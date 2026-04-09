import { setTimeout as sleep } from 'node:timers/promises';

import type { WorkerConfig } from './config.js';
import { ControlPlaneHttpError } from './control-plane-client.js';
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
import type { PublishResult, ResultPublisher } from './publisher.js';

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
  publisher?: ResultPublisher;
}

class AttemptKeepalive {
  private readonly intervalMs: number;
  private readonly sessionTouch: boolean;
  private readonly sendHeartbeat: (
    phase: string,
    message: string | undefined,
    sessionTouch: boolean
  ) => Promise<void>;
  private readonly abortController: AbortController;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private error: unknown = null;
  private progressPhase: string;
  private progressMessage: string | undefined;
  private stopped = false;

  constructor(options: {
    intervalMs: number;
    initialPhase: string;
    initialMessage?: string;
    sessionTouch: boolean;
    abortController: AbortController;
    sendHeartbeat: (phase: string, message: string | undefined, sessionTouch: boolean) => Promise<void>;
  }) {
    this.intervalMs = options.intervalMs;
    this.progressPhase = options.initialPhase;
    this.progressMessage = options.initialMessage;
    this.sessionTouch = options.sessionTouch;
    this.abortController = options.abortController;
    this.sendHeartbeat = options.sendHeartbeat;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.flush();
    }, this.intervalMs);
  }

  update(phase: string, message?: string): void {
    this.progressPhase = phase;
    this.progressMessage = message;
  }

  async flush(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.error) {
      throw this.error;
    }

    if (!this.inFlight) {
      this.inFlight = this.sendHeartbeat(this.progressPhase, this.progressMessage, this.sessionTouch).catch((error) => {
        this.error = error;
        this.abortController.abort();
      });
    }

    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }

    if (this.error) {
      throw this.error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.inFlight) {
      try {
        await this.inFlight;
      } finally {
        this.inFlight = null;
      }
    }
  }

  throwIfFailed(): void {
    if (this.error) {
      throw this.error;
    }
  }
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
    let keepalive: AttemptKeepalive | null = null;
    const executionController = new AbortController();

    try {
      await this.deps.client.startAttempt(attemptId, leaseToken, {
        worker_id: this.config.workerId,
        provider,
        opaque_session_id: opaqueSessionId,
        session_reused: Boolean(resumeSession)
      });

      keepalive = new AttemptKeepalive({
        intervalMs: Math.max(1_000, claim.attempt.heartbeat_interval_sec * 1_000),
        initialPhase: 'prepare_workspace',
        initialMessage: 'Preparing workspace',
        sessionTouch: Boolean(resumeSession),
        abortController: executionController,
        sendHeartbeat: async (phase, message, sessionTouch) => {
          const heartbeat = await this.heartbeatAttemptWithRetry(
            attemptId,
            leaseToken,
            {
              worker_id: this.config.workerId,
              progress_phase: phase,
              progress_message: message,
              session_touch: sessionTouch
            },
            executionController.signal
          );
          this.throwIfCancelled(heartbeat);
        }
      });
      keepalive.start();
      await keepalive.flush();

      preparedWorkspace = await this.deps.workspacePreparer.prepare(claim.job);
      keepalive.throwIfFailed();

      const executionResult = await executor.run({
        job: claim.job,
        workspacePath: preparedWorkspace.workspacePath,
        resumeSession,
        signal: executionController.signal,
        onProgress: async (phase, message) => {
          keepalive?.update(phase, message);
          await keepalive?.flush();
          keepalive?.throwIfFailed();
        }
      });
      await keepalive.stop();
      keepalive.throwIfFailed();

      const finalizedResult =
        executionResult.status === 'completed'
          ? this.mergeExecutionResult(
              executionResult,
              await this.deps.publisher?.publish({
                job: claim.job,
                workerId: this.config.workerId,
                provider,
                workspacePath: preparedWorkspace.workspacePath,
                executionResult
              })
            )
          : executionResult;

      await this.uploadArtifacts(attemptId, leaseToken, finalizedResult.artifacts?.map((item) => item.request) ?? []);

      if (claim.session.session_key && finalizedResult.opaque_session_id) {
        const record: SessionRecord = {
          session_key: claim.session.session_key,
          provider,
          opaque_session_id: finalizedResult.opaque_session_id,
          updated_at: new Date().toISOString()
        };
        await this.deps.sessionStore.set(record);
      }

      if (finalizedResult.status === 'completed') {
        await this.deps.client.completeAttempt(attemptId, leaseToken, {
          worker_id: this.config.workerId,
          result_summary: finalizedResult.result_summary,
          result_json: finalizedResult.result_json
        });
        return {
          status: 'completed',
          jobId: claim.job.job_id,
          detail: finalizedResult.result_summary
        };
      }

      if (finalizedResult.status === 'cancelled') {
        await this.deps.client.cancelAttempt(attemptId, leaseToken, {
          worker_id: this.config.workerId,
          result_summary: finalizedResult.result_summary,
          result_json: finalizedResult.result_json
        });
        return {
          status: 'cancelled',
          jobId: claim.job.job_id,
          detail: finalizedResult.result_summary
        };
      }

      await this.deps.client.failAttempt(attemptId, leaseToken, {
        worker_id: this.config.workerId,
        failure_code: finalizedResult.failure_code ?? 'execution_failed',
        failure_message: finalizedResult.failure_message ?? finalizedResult.result_summary,
        retryable: false,
        result_json: finalizedResult.result_json
      });
      return {
        status: 'failed',
        jobId: claim.job.job_id,
        detail: finalizedResult.result_summary
      };
    } catch (error) {
      if (keepalive) {
        await keepalive.stop();
      }

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
      if (keepalive) {
        await keepalive.stop();
      }
      await this.heartbeatWorker('idle', []);
      if (preparedWorkspace) {
        await this.persistWorkspaceManifest(preparedWorkspace);
      }
    }
  }

  private async heartbeatAttemptWithRetry(
    attemptId: string,
    leaseToken: string,
    input: {
      worker_id: string;
      progress_phase: string;
      progress_message?: string;
      session_touch: boolean;
    },
    signal?: AbortSignal
  ): Promise<AttemptHeartbeatResponse> {
    const maxAttempts = Math.max(1, this.config.attemptHeartbeatRetryCount);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.deps.client.heartbeatAttempt(attemptId, leaseToken, input);
      } catch (error) {
        if (!this.shouldRetryAttemptHeartbeat(error) || attempt === maxAttempts) {
          throw error;
        }

        const delayMs = this.getRetryDelayMs(attempt);
        try {
          await sleep(delayMs, undefined, { signal });
        } catch (sleepError) {
          const nodeError = sleepError as NodeJS.ErrnoException;
          if (nodeError.name !== 'AbortError') {
            throw sleepError;
          }
          throw error;
        }
      }
    }

    throw new Error('Attempt heartbeat retry unexpectedly exhausted');
  }

  private shouldRetryAttemptHeartbeat(error: unknown): boolean {
    if (!(error instanceof ControlPlaneHttpError)) {
      return true;
    }

    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  private getRetryDelayMs(attemptNumber: number): number {
    const exponent = Math.max(0, attemptNumber - 1);
    return Math.min(
      this.config.retryMaxDelayMs,
      this.config.retryInitialDelayMs * 2 ** exponent
    );
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

  private mergeExecutionResult<T extends Awaited<ReturnType<ExecutorAdapter['run']>>>(
    executionResult: T,
    publishResult: PublishResult | null | undefined
  ): T {
    if (!publishResult) {
      return executionResult;
    }

    return {
      ...executionResult,
      result_summary: publishResult.summarySuffix
        ? `${executionResult.result_summary} | ${publishResult.summarySuffix}`
        : executionResult.result_summary,
      result_json: {
        ...(executionResult.result_json ?? {}),
        ...(publishResult.resultJson ?? {})
      },
      artifacts: [...(executionResult.artifacts ?? []), ...(publishResult.artifacts ?? [])]
    };
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
    if (claim.session.session_policy === 'fresh') {
      return null;
    }

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
