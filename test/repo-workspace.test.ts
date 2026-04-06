import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { GitWorkspacePreparer } from '../src/repo-workspace.js';
import type { RemoteWorkerJob } from '../src/types.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function createSourceRepo(rootDir: string): Promise<{ repoPath: string; commit: string }> {
  const repoPath = path.join(rootDir, 'source-repo');
  await execFileAsync('mkdir', ['-p', repoPath]);
  await git(['init', '--initial-branch=main'], repoPath);
  await git(['config', 'user.name', 'Test User'], repoPath);
  await git(['config', 'user.email', 'test@example.com'], repoPath);
  await writeFile(path.join(repoPath, 'README.md'), 'hello remote worker\n', 'utf8');
  await git(['add', 'README.md'], repoPath);
  await git(['commit', '-m', 'initial'], repoPath);
  const commit = await git(['rev-parse', 'HEAD'], repoPath);
  return { repoPath, commit };
}

describe('GitWorkspacePreparer', () => {
  it('clones the repo cache and creates a detached worktree at the requested commit', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-workspace-'));
    const { repoPath, commit } = await createSourceRepo(tempDir);
    const workspaceRoot = path.join(tempDir, 'worker-root');
    const preparer = new GitWorkspacePreparer(workspaceRoot);

    const job: RemoteWorkerJob = {
      job_id: 'job-1',
      workspace_key: 'repo:test',
      repo_url: repoPath,
      branch: 'main',
      base_commit: commit,
      mode: 'edit',
      requirements: ['tool:codex'],
      prompt: 'Test workspace preparation',
      target_files: ['README.md'],
      timeout_sec: 600
    };

    const prepared = await preparer.prepare(job);
    const readme = await readFile(path.join(prepared.workspacePath, 'README.md'), 'utf8');
    const headCommit = await git(['rev-parse', 'HEAD'], prepared.workspacePath);

    expect(readme).toContain('hello remote worker');
    expect(headCommit).toBe(commit);
    expect(path.basename(prepared.manifestPath)).toBe('job-manifest.json');
  });
});
