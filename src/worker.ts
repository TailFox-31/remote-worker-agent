import { setTimeout as sleep } from 'node:timers/promises';

import type { WorkerConfig } from './config.js';
import type { PreparedWorkspace, WorkspacePreparer } from './repo-workspace.js';
import { JsonSessionStore, type SessionRecord } from './session-store.js';
import type {
  ArtifactUploadRequest,
  AttemptHeartbeatResponse,
  JobClaimResponse,
  SessionProvider,
  SessionResume,
  WorkerHeartbeatResponse
} from './types.js';
import type { ControlPlaneClient } from './control-plane-client.js';
import type { ExecutorAdapter } from './executors/base.js';

export interface WorkerCycleResult {
  status: 'idle' | 'completed' | 'failed' | 'cancelled';
  jobId?: string;
  detail?: string;
}

export class AttemptCancelledError extends Error {
  constructor(readonly reason?: string) {
    super(reason ?? 'Attempt cancelled by control plane');
  }
}

interface WorkerDependencies {
  client: Pick<
    ControlPlaneClient,
    | 'registerWorker'
    | 'heartbeatWorker'
    | 'claimJob'
    | 'startAttempt'
    | 'heartbeatAttempt'
    | 'completeAttempt'
    | 'failAttempt'
    | 'cancelAttempt'
    | 'uploadArtifact'
  >;
  sessionStore: JsonSessionStore;
  workspacePreparer: WorkspacePreparer;
  executors: Map<SessionProvider, ExecutorAdapter>;
}

export class RemoteWorkerAgent {
  constructor(
    private readonly config: WorkerConfig,
    private readonly deps: WorkerDependencies
  ) {}

  async register(): Promise<void> {
    await this.deps.client.registerWorker({
      worker_id: this.config.workerId,
      display_name: this.config.displayName,
      capability_tokens: this.config.capabilities,
      max_concurrency: this.config.maxConcurrency,
      metadata: {
        execution_mode: this.config.executionMode
      }
    });
  }

  async runCycle(): Promise<WorkerCycleResult> {
    await this.heartbeatWorker('idle', []);

    const claim = await this.deps.client.claimJob(this.config.workerId);
    if (!claim) {
      return { status: 'idle' };
    }

    return this.runClaim(claim);
  }

  async runLoop(
    signal?: AbortSignal,
    onCycleResult?: (result: WorkerCycleResult) => void | Promise<void>
  ): Promise<void> {
    while (!signal?.aborted) {
      const result = await this.runCycle();
      await onCycleResult?.(result);
      await sleep(this.config.pollIntervalMs, undefined, { signal }).catch((error: unknown) => {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.name !== 'AbortError') {
          throw error;
        }
      });
    }
  }

  private async runClaim(claim: JobClaimResponse): Promise<WorkerCycleResult> {
    const provider = this.selectProvider(claim);
    const executor = this.deps.executors.get(provider);
    if (!executor) {
      throw new Error(`No executor registered for provider: ${provider}`);
    }

    const resumeSession = await this.resolveSessionResume(claim, provider);
    const attemptId = claim.attempt.attempt_id;
    const leaseToken = claim.attempt.lease_token;
    const opaqueSessionId =
      resumeSession?.opaque_session_id ?? `${provider}:${claim.job.job_id}`;

    let preparedWorkspace: PreparedWorkspace | null = null;

    try {
      await this.deps.client.startAttempt(attemptId, leaseToken, {
        worker_id: this.config.workerId,
        provider,
        opaque_session_id: opaqueSessionId,
        session_reused: Boolean(resumeSession)
      });

      const workspaceHeartbeat = await this.deps.client.heartbeatAttempt(attemptId, leaseToken, {
        worker_id: this.config.workerId,
        progress_phase: 'prepare_workspace',
        progress_message: 'Preparing workspace',
        session_touch: Boolean(resumeSession)
      });
      this.throwIfCancelled(workspaceHeartbeat);

      preparedWorkspace = await this.deps.workspacePreparer.prepare(claim.job);

      const executionResult = await executor.run({
        job: claim.job,
        workspacePath: preparedWorkspace.workspacePath,
        resumeSession,
        onProgress: async (phase, message) => {
          const heartbeat = await this.deps.client.heartbeatAttempt(attemptId, leaseToken, {
            worker_id: this.config.workerId,
            progress_phase: phase,
            progress_message: message,
            session_touch: Boolean(resumeSession)
          });
          this.throwIfCancelled(heartbeat);
        }
      });

      await this.uploadArtifacts(attemptId, leaseToken, executionResult.artifacts?.map((item) => item.request) ?? []);

      if (claim.session.session_key && executionResult.opaque_session_id) {
        const record: SessionRecord = {
          session_key: claim.session.session_key,
          provider,
          opaque_session_id: executionResult.opaque_session_id,
          updated_at: new Date().toISOString()
        };
        await this.deps.sessionStore.set(record);
      }

      if (executionResult.status === 'completed') {
        await this.deps.client.completeAttempt(attemptId, leaseToken, {
          worker_id: this.config.workerId,
          result_summary: executionResult.result_summary,
          result_json: executionResult.result_json
        });
        return {
          status: 'completed',
          jobId: claim.job.job_id,
          detail: executionResult.result_summary
        };
      }

      if (executionResult.status === 'cancelled') {
        await this.deps.client.cancelAttempt(attemptId, leaseToken, {
          worker_id: this.config.workerId,
          result_summary: executionResult.result_summary,
          result_json: executionResult.result_json
        });
        return {
          status: 'cancelled',
          jobId: claim.job.job_id,
          detail: executionResult.result_summary
        };
      }

      await this.deps.client.failAttempt(attemptId, leaseToken, {
        worker_id: this.config.workerId,
        failure_code: executionResult.failure_code ?? 'execution_failed',
        failure_message: executionResult.failure_message ?? executionResult.result_summary,
        retryable: false,
        result_json: executionResult.result_json
      });
      return {
        status: 'failed',
        jobId: claim.job.job_id,
        detail: executionResult.result_summary
      };
    } catch (error) {
      if (error instanceof AttemptCancelledError) {
        await this.deps.client.cancelAttempt(attemptId, leaseToken, {
          worker_id: this.config.workerId,
          result_summary: error.reason ?? 'Cancelled by control plane'
        });
        return {
          status: 'cancelled',
          jobId: claim.job.job_id,
          detail: error.reason
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      await this.deps.client.failAttempt(attemptId, leaseToken, {
        worker_id: this.config.workerId,
        failure_code: 'worker_exception',
        failure_message: message,
        retryable: false,
        result_json: {
          error_name: error instanceof Error ? error.name : 'UnknownError'
        }
      });
      return {
        status: 'failed',
        jobId: claim.job.job_id,
        detail: message
      };
    } finally {
      await this.heartbeatWorker('idle', []);
      if (preparedWorkspace) {
        await this.persistWorkspaceManifest(preparedWorkspace);
      }
    }
  }

  private async uploadArtifacts(
    attemptId: string,
    leaseToken: string,
    artifacts: ArtifactUploadRequest[]
  ): Promise<void> {
    for (const artifact of artifacts) {
      await this.deps.client.uploadArtifact(attemptId, leaseToken, artifact);
    }
  }

  private async heartbeatWorker(
    status: 'idle' | 'busy' | 'draining',
    runningAttemptIds: string[]
  ): Promise<WorkerHeartbeatResponse> {
    return this.deps.client.heartbeatWorker(this.config.workerId, {
      status,
      running_attempt_ids: runningAttemptIds,
      metadata: {
        default_provider: this.config.defaultProvider
      }
    });
  }

  private selectProvider(claim: JobClaimResponse): SessionProvider {
    if (claim.session.resume?.provider) {
      return claim.session.resume.provider;
    }

    if (claim.job.requirements.includes('tool:claude-code')) {
      return 'claude-code';
    }

    if (claim.job.requirements.includes('tool:codex')) {
      return 'codex';
    }

    return this.config.defaultProvider;
  }

  private async resolveSessionResume(
    claim: JobClaimResponse,
    provider: SessionProvider
  ): Promise<SessionResume | null> {
    if (claim.session.resume) {
      return claim.session.resume;
    }

    if (!claim.session.session_key) {
      return null;
    }

    return this.deps.sessionStore.get(claim.session.session_key, provider);
  }

  private throwIfCancelled(heartbeat: AttemptHeartbeatResponse): void {
    if (heartbeat.cancel_requested) {
      throw new AttemptCancelledError(heartbeat.cancel_reason);
    }
  }

  private async persistWorkspaceManifest(_workspace: PreparedWorkspace): Promise<void> {
    return;
  }
}
