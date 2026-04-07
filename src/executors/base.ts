import type { ExecutorArtifact, ExecutorRunResult, RemoteWorkerJob, SessionProvider, SessionResume } from '../types.js';

export interface ExecutorRunContext {
  job: RemoteWorkerJob;
  workspacePath: string;
  resumeSession: SessionResume | null;
  signal: AbortSignal;
  onProgress: (phase: string, message: string) => Promise<void>;
}

export interface ExecutorAdapter {
  readonly provider: SessionProvider;
  run(context: ExecutorRunContext): Promise<ExecutorRunResult>;
}

export abstract class SkeletonExecutor implements ExecutorAdapter {
  constructor(
    readonly provider: SessionProvider,
    protected readonly executionMode: 'dry-run' | 'strict'
  ) {}

  async run(context: ExecutorRunContext): Promise<ExecutorRunResult> {
    await context.onProgress('execute', `${this.provider} executor started`);

    if (this.executionMode === 'strict') {
      return {
        status: 'failed',
        result_summary: `${this.provider} executor is not implemented yet`,
        failure_code: 'not_implemented',
        failure_message: `${this.provider} executor skeleton has no CLI binding yet`
      };
    }

    const artifacts: ExecutorArtifact[] = [
      {
        request: {
          kind: 'report',
          storage_type: 'inline',
          content_type: 'application/json',
          content_base64: Buffer.from(
            JSON.stringify(
              {
                provider: this.provider,
                mode: context.job.mode,
                prompt_preview: context.job.prompt.slice(0, 120),
                workspace_path: context.workspacePath
              },
              null,
              2
            ),
            'utf8'
          ).toString('base64')
        }
      }
    ];

    return {
      status: 'completed',
      result_summary: `${this.provider} dry-run completed for ${context.job.job_id}`,
      result_json: {
        execution_mode: 'dry-run',
        workspace_path: context.workspacePath
      },
      opaque_session_id: context.resumeSession?.opaque_session_id ?? `${this.provider}:${context.job.job_id}`,
      artifacts
    };
  }
}
