import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkerConfig } from '../src/config.js';
import { ControlPlaneHttpError } from '../src/control-plane-client.js';
import type { AttemptHeartbeatResponse, JobClaimResponse } from '../src/types.js';
import { JsonSessionStore } from '../src/session-store.js';
import { StubWorkspacePreparer } from '../src/repo-workspace.js';
import { RemoteWorkerAgent } from '../src/worker.js';
import type { ExecutorAdapter, ExecutorRunContext } from '../src/executors/base.js';
import type { ResultPublisher } from '../src/publisher.js';

function createConfig(sessionStorePath: string, workspaceRoot: string): WorkerConfig {
  return {
    controlPlaneBaseUrl: 'https://example.test',
    controlPlaneToken: 'token',
    workerId: 'worker-a',
    displayName: 'Worker A',
    capabilities: ['tool:codex'],
    maxConcurrency: 1,
    defaultProvider: 'codex',
    executionMode: 'dry-run',
    pollIntervalMs: 10,
    retryInitialDelayMs: 1,
    retryMaxDelayMs: 10,
    attemptHeartbeatRetryCount: 3,
    workspaceRoot,
    sessionStorePath,
    codexBin: 'codex',
    codexSandbox: 'workspace-write',
    publishMode: 'artifact',
    publishBranchPrefix: 'job',
    gitCommitName: 'Remote Worker Agent',
    gitCommitEmail: 'remote-worker-agent@local',
    githubApiBaseUrl: 'https://api.github.com',
    githubPrDraft: false,
    gitEnv: {},
    runtimeEnv: {}
  };
}

function createClaim(
  overrides: Partial<JobClaimResponse['attempt']> = {},
  sessionOverrides: Partial<JobClaimResponse['session']> = {},
): JobClaimResponse {
  return {
    job: {
      job_id: 'job-1',
      workspace_key: 'repo:test',
      repo_url: 'git@github.com:TailFox-31/remote-worker-agent.git',
      branch: 'main',
      base_commit: 'abc1234',
      mode: 'edit',
      requirements: ['tool:codex'],
      prompt: 'Update worker loop',
      target_files: ['src/worker.ts'],
      timeout_sec: 600
    },
    attempt: {
      attempt_id: 'attempt-1',
      lease_token: 'lease-1',
      heartbeat_interval_sec: 15,
      lease_ttl_sec: 45,
      ...overrides
    },
    session: {
      session_key: 'discord:room:1',
      session_policy: 'prefer_reuse',
      resume: null,
      ...sessionOverrides
    }
  };
}

class FakeExecutor implements ExecutorAdapter {
  readonly provider = 'codex' as const;

  constructor(private readonly mode: 'completed' | 'cancelled' = 'completed') {}

  async run(context: ExecutorRunContext) {
    await context.onProgress('execute', 'running fake executor');

    if (this.mode === 'cancelled') {
      return {
        status: 'cancelled' as const,
        result_summary: 'Cancelled inside executor'
      };
    }

    return {
      status: 'completed' as const,
      result_summary: 'Execution completed',
      opaque_session_id: 'sess-123',
      artifacts: [
        {
          request: {
            kind: 'report' as const,
            storage_type: 'inline' as const,
            content_type: 'text/plain',
            content_base64: Buffer.from('ok', 'utf8').toString('base64')
          }
        }
      ]
    };
  }
}

class SlowExecutor implements ExecutorAdapter {
  readonly provider = 'codex' as const;

  async run(_context: ExecutorRunContext) {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    return {
      status: 'completed' as const,
      result_summary: 'Slow execution completed'
    };
  }
}

describe('RemoteWorkerAgent', () => {
  it('completes claimed work and persists session reuse data', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-'));
    const sessionStorePath = path.join(tempDir, 'sessions.json');
    const workspaceRoot = path.join(tempDir, 'workspaces');
    const config = createConfig(sessionStorePath, workspaceRoot);
    const sessionStore = new JsonSessionStore(sessionStorePath);
    const startAttempt = vi.fn(async () => ({ status: 'running' }));
    const completeAttempt = vi.fn(async () => ({ job_status: 'completed' }));
    const uploadArtifact = vi.fn(async () => ({ artifact_id: 'artifact-1' }));
    const heartbeatAttempt = vi.fn(
      async (): Promise<AttemptHeartbeatResponse> => ({
        accepted: true,
        lease_expires_at: '2026-04-07T00:00:30Z',
        cancel_requested: false
      })
    );

    const agent = new RemoteWorkerAgent(config, {
      client: {
        registerWorker: vi.fn(async () => ({
          worker_id: 'worker-a',
          status: 'idle',
          heartbeat_interval_sec: 15,
          lease_ttl_sec: 45
        })),
        heartbeatWorker: vi.fn(async () => ({
          accepted: true,
          server_time: '2026-04-07T00:00:00Z',
          next_heartbeat_sec: 15,
          drain_requested: false
        })),
        claimJob: vi.fn(async () => createClaim()),
        startAttempt,
        heartbeatAttempt,
        completeAttempt,
        failAttempt: vi.fn(async () => ({ job_status: 'failed' })),
        cancelAttempt: vi.fn(async () => ({ job_status: 'cancelled' })),
        uploadArtifact
      },
      sessionStore,
      workspacePreparer: new StubWorkspacePreparer(workspaceRoot),
      executors: new Map([['codex', new FakeExecutor()]])
    });

    const result = await agent.runCycle();

    expect(result).toMatchObject({
      status: 'completed',
      jobId: 'job-1'
    });
    expect(startAttempt).toHaveBeenCalledWith('attempt-1', 'lease-1', {
      worker_id: 'worker-a',
      provider: 'codex',
      opaque_session_id: 'codex:job-1',
      session_reused: false
    });
    expect(completeAttempt).toHaveBeenCalledTimes(1);
    expect(uploadArtifact).toHaveBeenCalledTimes(1);
    await expect(sessionStore.get('discord:room:1', 'codex')).resolves.toEqual({
      provider: 'codex',
      opaque_session_id: 'sess-123'
    });
  });

  it('propagates cancellation when heartbeat requests interrupt', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-cancel-'));
    const sessionStorePath = path.join(tempDir, 'sessions.json');
    const workspaceRoot = path.join(tempDir, 'workspaces');
    const config = createConfig(sessionStorePath, workspaceRoot);
    const cancelAttempt = vi.fn(async () => ({ job_status: 'cancelled' }));

    const agent = new RemoteWorkerAgent(config, {
      client: {
        registerWorker: vi.fn(async () => ({
          worker_id: 'worker-a',
          status: 'idle',
          heartbeat_interval_sec: 15,
          lease_ttl_sec: 45
        })),
        heartbeatWorker: vi.fn(async () => ({
          accepted: true,
          server_time: '2026-04-07T00:00:00Z',
          next_heartbeat_sec: 15,
          drain_requested: false
        })),
        claimJob: vi.fn(async () => createClaim()),
        startAttempt: vi.fn(async () => ({ status: 'running' })),
        heartbeatAttempt: vi.fn(
          async (): Promise<AttemptHeartbeatResponse> => ({
            accepted: true,
            lease_expires_at: '2026-04-07T00:00:30Z',
            cancel_requested: true,
            cancel_reason: 'user requested cancel',
            interrupt_deadline_at: '2026-04-07T00:00:40Z'
          })
        ),
        completeAttempt: vi.fn(async () => ({ job_status: 'completed' })),
        failAttempt: vi.fn(async () => ({ job_status: 'failed' })),
        cancelAttempt,
        uploadArtifact: vi.fn(async () => ({ artifact_id: 'artifact-1' }))
      },
      sessionStore: new JsonSessionStore(sessionStorePath),
      workspacePreparer: new StubWorkspacePreparer(workspaceRoot),
      executors: new Map([['codex', new FakeExecutor()]])
    });

    const result = await agent.runCycle();

    expect(result).toMatchObject({
      status: 'cancelled',
      jobId: 'job-1'
    });
    expect(cancelAttempt).toHaveBeenCalledTimes(1);
  });

  it('ignores resume payloads and stored sessions for fresh jobs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-fresh-'));
    const sessionStorePath = path.join(tempDir, 'sessions.json');
    const workspaceRoot = path.join(tempDir, 'workspaces');
    const config = createConfig(sessionStorePath, workspaceRoot);
    const sessionStore = new JsonSessionStore(sessionStorePath);
    await sessionStore.set({
      session_key: 'discord:room:1',
      provider: 'codex',
      opaque_session_id: 'sess-local-store',
      updated_at: new Date().toISOString(),
    });

    const startAttempt = vi.fn(async () => ({ status: 'running' }));

    const agent = new RemoteWorkerAgent(config, {
      client: {
        registerWorker: vi.fn(async () => ({
          worker_id: 'worker-a',
          status: 'idle',
          heartbeat_interval_sec: 15,
          lease_ttl_sec: 45
        })),
        heartbeatWorker: vi.fn(async () => ({
          accepted: true,
          server_time: '2026-04-07T00:00:00Z',
          next_heartbeat_sec: 15,
          drain_requested: false
        })),
        claimJob: vi.fn(async () =>
          createClaim(
            {},
            {
              session_policy: 'fresh',
              resume: { provider: 'codex', opaque_session_id: 'sess-server-resume' },
            },
          ),
        ),
        startAttempt,
        heartbeatAttempt: vi.fn(
          async (): Promise<AttemptHeartbeatResponse> => ({
            accepted: true,
            lease_expires_at: '2026-04-07T00:00:30Z',
            cancel_requested: false
          })
        ),
        completeAttempt: vi.fn(async () => ({ job_status: 'completed' })),
        failAttempt: vi.fn(async () => ({ job_status: 'failed' })),
        cancelAttempt: vi.fn(async () => ({ job_status: 'cancelled' })),
        uploadArtifact: vi.fn(async () => ({ artifact_id: 'artifact-1' }))
      },
      sessionStore,
      workspacePreparer: new StubWorkspacePreparer(workspaceRoot),
      executors: new Map([['codex', new FakeExecutor()]])
    });

    const result = await agent.runCycle();

    expect(result).toMatchObject({
      status: 'completed',
      jobId: 'job-1'
    });
    expect(startAttempt).toHaveBeenCalledWith('attempt-1', 'lease-1', {
      worker_id: 'worker-a',
      provider: 'codex',
      opaque_session_id: 'codex:job-1',
      session_reused: false
    });
  });

  it('fails the attempt instead of crashing when startAttempt throws', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-start-fail-'));
    const sessionStorePath = path.join(tempDir, 'sessions.json');
    const workspaceRoot = path.join(tempDir, 'workspaces');
    const config = createConfig(sessionStorePath, workspaceRoot);
    const failAttempt = vi.fn(async () => ({ job_status: 'failed' }));

    const agent = new RemoteWorkerAgent(config, {
      client: {
        registerWorker: vi.fn(async () => ({
          worker_id: 'worker-a',
          status: 'idle',
          heartbeat_interval_sec: 15,
          lease_ttl_sec: 45
        })),
        heartbeatWorker: vi.fn(async () => ({
          accepted: true,
          server_time: '2026-04-07T00:00:00Z',
          next_heartbeat_sec: 15,
          drain_requested: false
        })),
        claimJob: vi.fn(async () => createClaim()),
        startAttempt: vi.fn(async () => {
          throw new Error('start failed');
        }),
        heartbeatAttempt: vi.fn(
          async (): Promise<AttemptHeartbeatResponse> => ({
            accepted: true,
            lease_expires_at: '2026-04-07T00:00:30Z',
            cancel_requested: false
          })
        ),
        completeAttempt: vi.fn(async () => ({ job_status: 'completed' })),
        failAttempt,
        cancelAttempt: vi.fn(async () => ({ job_status: 'cancelled' })),
        uploadArtifact: vi.fn(async () => ({ artifact_id: 'artifact-1' }))
      },
      sessionStore: new JsonSessionStore(sessionStorePath),
      workspacePreparer: new StubWorkspacePreparer(workspaceRoot),
      executors: new Map([['codex', new FakeExecutor()]])
    });

    const result = await agent.runCycle();

    expect(result).toMatchObject({
      status: 'failed',
      jobId: 'job-1',
      detail: 'start failed'
    });
    expect(failAttempt).toHaveBeenCalledTimes(1);
  });

  it('keeps renewing attempt leases while a long-running executor is still busy', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-keepalive-'));
    const sessionStorePath = path.join(tempDir, 'sessions.json');
    const workspaceRoot = path.join(tempDir, 'workspaces');
    const config = createConfig(sessionStorePath, workspaceRoot);
    const heartbeatAttempt = vi.fn(
      async (): Promise<AttemptHeartbeatResponse> => ({
        accepted: true,
        lease_expires_at: '2026-04-07T00:00:30Z',
        cancel_requested: false
      })
    );

    const agent = new RemoteWorkerAgent(config, {
      client: {
        registerWorker: vi.fn(async () => ({
          worker_id: 'worker-a',
          status: 'idle',
          heartbeat_interval_sec: 15,
          lease_ttl_sec: 45
        })),
        heartbeatWorker: vi.fn(async () => ({
          accepted: true,
          server_time: '2026-04-07T00:00:00Z',
          next_heartbeat_sec: 15,
          drain_requested: false
        })),
        claimJob: vi.fn(async () => createClaim({ heartbeat_interval_sec: 1, lease_ttl_sec: 3 })),
        startAttempt: vi.fn(async () => ({ status: 'running' })),
        heartbeatAttempt,
        completeAttempt: vi.fn(async () => ({ job_status: 'completed' })),
        failAttempt: vi.fn(async () => ({ job_status: 'failed' })),
        cancelAttempt: vi.fn(async () => ({ job_status: 'cancelled' })),
        uploadArtifact: vi.fn(async () => ({ artifact_id: 'artifact-1' }))
      },
      sessionStore: new JsonSessionStore(sessionStorePath),
      workspacePreparer: new StubWorkspacePreparer(workspaceRoot),
      executors: new Map([['codex', new SlowExecutor()]])
    });

    const result = await agent.runCycle();

    expect(result).toMatchObject({
      status: 'completed',
      jobId: 'job-1'
    });
    expect(heartbeatAttempt.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('retries transient attempt heartbeat failures before succeeding', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-heartbeat-retry-'));
    const sessionStorePath = path.join(tempDir, 'sessions.json');
    const workspaceRoot = path.join(tempDir, 'workspaces');
    const config = createConfig(sessionStorePath, workspaceRoot);
    const heartbeatAttempt = vi
      .fn<() => Promise<AttemptHeartbeatResponse>>()
      .mockResolvedValueOnce({
        accepted: true,
        lease_expires_at: '2026-04-07T00:00:30Z',
        cancel_requested: false
      })
      .mockRejectedValueOnce(new ControlPlaneHttpError(502, { error: 'bad gateway' }))
      .mockRejectedValueOnce(new ControlPlaneHttpError(502, { error: 'bad gateway' }))
      .mockResolvedValue({
        accepted: true,
        lease_expires_at: '2026-04-07T00:00:30Z',
        cancel_requested: false
      });

    const agent = new RemoteWorkerAgent(config, {
      client: {
        registerWorker: vi.fn(async () => ({
          worker_id: 'worker-a',
          status: 'idle',
          heartbeat_interval_sec: 15,
          lease_ttl_sec: 45
        })),
        heartbeatWorker: vi.fn(async () => ({
          accepted: true,
          server_time: '2026-04-07T00:00:00Z',
          next_heartbeat_sec: 15,
          drain_requested: false
        })),
        claimJob: vi.fn(async () => createClaim()),
        startAttempt: vi.fn(async () => ({ status: 'running' })),
        heartbeatAttempt,
        completeAttempt: vi.fn(async () => ({ job_status: 'completed' })),
        failAttempt: vi.fn(async () => ({ job_status: 'failed' })),
        cancelAttempt: vi.fn(async () => ({ job_status: 'cancelled' })),
        uploadArtifact: vi.fn(async () => ({ artifact_id: 'artifact-1' }))
      },
      sessionStore: new JsonSessionStore(sessionStorePath),
      workspacePreparer: new StubWorkspacePreparer(workspaceRoot),
      executors: new Map([['codex', new FakeExecutor()]])
    });

    const result = await agent.runCycle();

    expect(result).toMatchObject({
      status: 'completed',
      jobId: 'job-1'
    });
    expect(heartbeatAttempt).toHaveBeenCalledTimes(4);
  });

  it('merges publish results into completion output and uploads publish artifacts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-publish-'));
    const sessionStorePath = path.join(tempDir, 'sessions.json');
    const workspaceRoot = path.join(tempDir, 'workspaces');
    const config = createConfig(sessionStorePath, workspaceRoot);
    const completeAttempt = vi.fn(async () => ({ job_status: 'completed' }));
    const uploadArtifact = vi.fn(async () => ({ artifact_id: 'artifact-1' }));
    const publisher: ResultPublisher = {
      publish: vi.fn(async () => ({
        summarySuffix: 'PR: https://github.com/TailFox-31/idle-game/pull/1',
        resultJson: {
          publish: {
            branch_name: 'job/job-1',
            pr_url: 'https://github.com/TailFox-31/idle-game/pull/1'
          }
        },
        artifacts: [
          {
            request: {
              kind: 'report' as const,
              storage_type: 'inline' as const,
              content_type: 'application/json',
              content_base64: Buffer.from('publish', 'utf8').toString('base64')
            }
          }
        ]
      }))
    };

    const agent = new RemoteWorkerAgent(config, {
      client: {
        registerWorker: vi.fn(async () => ({
          worker_id: 'worker-a',
          status: 'idle',
          heartbeat_interval_sec: 15,
          lease_ttl_sec: 45
        })),
        heartbeatWorker: vi.fn(async () => ({
          accepted: true,
          server_time: '2026-04-07T00:00:00Z',
          next_heartbeat_sec: 15,
          drain_requested: false
        })),
        claimJob: vi.fn(async () => createClaim()),
        startAttempt: vi.fn(async () => ({ status: 'running' })),
        heartbeatAttempt: vi.fn(
          async (): Promise<AttemptHeartbeatResponse> => ({
            accepted: true,
            lease_expires_at: '2026-04-07T00:00:30Z',
            cancel_requested: false
          })
        ),
        completeAttempt,
        failAttempt: vi.fn(async () => ({ job_status: 'failed' })),
        cancelAttempt: vi.fn(async () => ({ job_status: 'cancelled' })),
        uploadArtifact
      },
      sessionStore: new JsonSessionStore(sessionStorePath),
      workspacePreparer: new StubWorkspacePreparer(workspaceRoot),
      executors: new Map([['codex', new FakeExecutor()]]),
      publisher
    });

    const result = await agent.runCycle();

    expect(result).toMatchObject({
      status: 'completed',
      jobId: 'job-1',
      detail: 'Execution completed | PR: https://github.com/TailFox-31/idle-game/pull/1'
    });
    expect(completeAttempt).toHaveBeenCalledWith(
      'attempt-1',
      'lease-1',
      expect.objectContaining({
        result_summary: 'Execution completed | PR: https://github.com/TailFox-31/idle-game/pull/1',
        result_json: expect.objectContaining({
          publish: {
            branch_name: 'job/job-1',
            pr_url: 'https://github.com/TailFox-31/idle-game/pull/1'
          }
        })
      })
    );
    expect(uploadArtifact).toHaveBeenCalledTimes(2);
  });
});
