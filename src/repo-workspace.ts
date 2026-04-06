import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RemoteWorkerJob } from './types.js';

export interface PreparedWorkspace {
  workspacePath: string;
  manifestPath: string;
}

export interface WorkspacePreparer {
  prepare(job: RemoteWorkerJob): Promise<PreparedWorkspace>;
}

function sanitizeSegment(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'workspace';
}

export class StubWorkspacePreparer implements WorkspacePreparer {
  constructor(private readonly rootPath: string) {}

  async prepare(job: RemoteWorkerJob): Promise<PreparedWorkspace> {
    const workspacePath = path.join(this.rootPath, sanitizeSegment(job.workspace_key), sanitizeSegment(job.job_id));
    await mkdir(workspacePath, { recursive: true });

    const manifestPath = path.join(workspacePath, 'job-manifest.json');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          repo_url: job.repo_url,
          branch: job.branch,
          base_commit: job.base_commit,
          mode: job.mode,
          target_files: job.target_files
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    return {
      workspacePath,
      manifestPath
    };
  }
}
