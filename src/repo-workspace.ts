import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

import type { RemoteWorkerJob } from './types.js';

const execFileAsync = promisify(execFile);

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

function buildWorkspacePath(rootPath: string, job: RemoteWorkerJob): string {
  return path.join(rootPath, sanitizeSegment(job.workspace_key), sanitizeSegment(job.job_id));
}

async function writeManifest(manifestPath: string, job: RemoteWorkerJob): Promise<void> {
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
}

async function runGit(args: string[], cwd: string, gitEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: {
        ...process.env,
        ...gitEnv
      }
    });
    return stdout.trim();
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    const stderr = execError.stderr?.trim();
    const stdout = execError.stdout?.trim();
    const detail = stderr || stdout || execError.message;
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function buildRepoCachePath(rootPath: string, repoUrl: string): string {
  const repoName = sanitizeSegment(path.basename(repoUrl).replace(/\.git$/u, ''));
  const repoHash = createHash('sha1').update(repoUrl).digest('hex').slice(0, 12);
  return path.join(rootPath, '.repo-cache', `${repoName}-${repoHash}`);
}

export class StubWorkspacePreparer implements WorkspacePreparer {
  constructor(private readonly rootPath: string) {}

  async prepare(job: RemoteWorkerJob): Promise<PreparedWorkspace> {
    const workspacePath = buildWorkspacePath(this.rootPath, job);
    await mkdir(workspacePath, { recursive: true });

    const manifestPath = path.join(workspacePath, 'job-manifest.json');
    await writeManifest(manifestPath, job);

    return {
      workspacePath,
      manifestPath
    };
  }
}

export class GitWorkspacePreparer implements WorkspacePreparer {
  constructor(
    private readonly rootPath: string,
    private readonly gitEnv: NodeJS.ProcessEnv = {}
  ) {}

  async prepare(job: RemoteWorkerJob): Promise<PreparedWorkspace> {
    await mkdir(this.rootPath, { recursive: true });

    const repoCachePath = buildRepoCachePath(this.rootPath, job.repo_url);
    const workspacePath = buildWorkspacePath(this.rootPath, job);

    await this.ensureRepoCache(repoCachePath, job.repo_url);
    await this.refreshRepoCache(repoCachePath, job);
    await this.resetWorkspace(repoCachePath, workspacePath);
    await runGit(['worktree', 'add', '--detach', workspacePath, job.base_commit], repoCachePath);

    const manifestPath = path.join(workspacePath, 'job-manifest.json');
    await writeManifest(manifestPath, job);

    return {
      workspacePath,
      manifestPath
    };
  }

  private async ensureRepoCache(repoCachePath: string, repoUrl: string): Promise<void> {
    if (fs.existsSync(repoCachePath)) {
      await runGit(['remote', 'set-url', 'origin', repoUrl], repoCachePath, this.gitEnv);
      return;
    }

    await mkdir(path.dirname(repoCachePath), { recursive: true });
    await runGit(['clone', '--no-checkout', repoUrl, repoCachePath], this.rootPath, this.gitEnv);
  }

  private async refreshRepoCache(repoCachePath: string, job: RemoteWorkerJob): Promise<void> {
    await runGit(['fetch', '--prune', 'origin'], repoCachePath, this.gitEnv);
    await runGit(['worktree', 'prune', '--expire', 'now'], repoCachePath, this.gitEnv);
    await runGit(['rev-parse', '--verify', `${job.base_commit}^{commit}`], repoCachePath, this.gitEnv);
  }

  private async resetWorkspace(repoCachePath: string, workspacePath: string): Promise<void> {
    try {
      await runGit(['worktree', 'remove', '--force', workspacePath], repoCachePath, this.gitEnv);
    } catch {
      /* ignore */
    }
    await rm(workspacePath, { recursive: true, force: true });
    await runGit(['worktree', 'prune', '--expire', 'now'], repoCachePath, this.gitEnv);
  }
}
