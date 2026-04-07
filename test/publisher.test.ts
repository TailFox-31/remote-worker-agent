import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { WorkerConfig } from '../src/config.js';
import type { ExecutorRunResult, RemoteWorkerJob } from '../src/types.js';
import { GitResultPublisher, parseGitHubRepoRef } from '../src/publisher.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function createBareRemote(rootDir: string): Promise<{ remotePath: string; commit: string; workspacePath: string }> {
  const remotePath = path.join(rootDir, 'remote.git');
  const seedPath = path.join(rootDir, 'seed');
  const workspacePath = path.join(rootDir, 'workspace');

  await git(['init', '--bare', remotePath], rootDir);
  await git(['init', '--initial-branch=main', seedPath], rootDir);
  await git(['config', 'user.name', 'Test User'], seedPath);
  await git(['config', 'user.email', 'test@example.com'], seedPath);
  await writeFile(path.join(seedPath, 'README.md'), 'hello\n', 'utf8');
  await git(['add', 'README.md'], seedPath);
  await git(['commit', '-m', 'initial'], seedPath);
  await git(['remote', 'add', 'origin', remotePath], seedPath);
  await git(['push', '-u', 'origin', 'main'], seedPath);
  const commit = await git(['rev-parse', 'HEAD'], seedPath);

  await git(['clone', remotePath, workspacePath], rootDir);
  await git(['checkout', '--detach', commit], workspacePath);
  await writeFile(path.join(workspacePath, 'README.md'), 'hello\nupdated\n', 'utf8');
  await writeFile(path.join(workspacePath, 'job-manifest.json'), '{}\n', 'utf8');

  return { remotePath, commit, workspacePath };
}

function createConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    controlPlaneBaseUrl: 'https://example.test',
    controlPlaneToken: 'token',
    workerId: 'worker-a',
    displayName: 'Worker A',
    capabilities: ['tool:codex'],
    maxConcurrency: 1,
    defaultProvider: 'codex',
    executionMode: 'strict',
    pollIntervalMs: 10,
    workspaceRoot: '.workspaces',
    sessionStorePath: '.sessions/store.json',
    codexBin: 'codex',
    codexSandbox: 'workspace-write',
    publishMode: 'artifact',
    publishBranchPrefix: 'job',
    gitCommitName: 'Remote Worker Agent',
    gitCommitEmail: 'remote-worker-agent@local',
    githubApiBaseUrl: 'https://api.github.com',
    githubPrDraft: false,
    gitEnv: {},
    runtimeEnv: {},
    ...overrides
  };
}

function createJob(overrides: Partial<RemoteWorkerJob> = {}): RemoteWorkerJob {
  return {
    job_id: 'job-1',
    workspace_key: 'repo:test',
    repo_url: 'git@github.com:TailFox-31/idle-game.git',
    branch: 'main',
    base_commit: 'abc1234',
    mode: 'edit',
    requirements: ['tool:codex'],
    prompt: 'Add a smoke script',
    target_files: ['Assets/Scripts/SmokeTest.cs'],
    timeout_sec: 600,
    ...overrides
  };
}

function createExecutionResult(): ExecutorRunResult {
  return {
    status: 'completed',
    result_summary: 'Execution completed',
    result_json: {
      provider: 'codex'
    },
    opaque_session_id: 'sess-123',
    artifacts: []
  };
}

describe('parseGitHubRepoRef', () => {
  it('parses SSH GitHub URLs', () => {
    expect(parseGitHubRepoRef('git@github.com:TailFox-31/idle-game.git')).toEqual({
      owner: 'TailFox-31',
      repo: 'idle-game'
    });
  });

  it('parses HTTPS GitHub URLs', () => {
    expect(parseGitHubRepoRef('https://github.com/TailFox-31/idle-game.git')).toEqual({
      owner: 'TailFox-31',
      repo: 'idle-game'
    });
  });
});

describe('GitResultPublisher', () => {
  it('creates and pushes a job branch while excluding job-manifest.json', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-publisher-'));
    const { remotePath, commit, workspacePath } = await createBareRemote(tempDir);
    const publisher = new GitResultPublisher(
      createConfig({
        publishMode: 'push'
      })
    );

    const result = await publisher.publish({
      job: createJob({
        repo_url: remotePath,
        base_commit: commit
      }),
      workerId: 'worker-a',
      provider: 'codex',
      workspacePath,
      executionResult: createExecutionResult()
    });

    expect(result?.resultJson).toMatchObject({
      publish: {
        mode: 'push',
        branch_name: 'job/job-1'
      }
    });

    const remoteHead = await git(['--git-dir', remotePath, 'rev-parse', 'refs/heads/job/job-1'], tempDir);
    expect(remoteHead).toMatch(/^[a-f0-9]{40}$/);

    const manifestTracked = await git(['--git-dir', remotePath, 'show', 'refs/heads/job/job-1:job-manifest.json'], tempDir).catch(
      () => ''
    );
    expect(manifestTracked).toBe('');
  });

  it('creates a pull request through the GitHub API', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-publisher-pr-'));
    const { commit, workspacePath } = await createBareRemote(tempDir);
    const requests: Array<{ authorization?: string; body: string }> = [];

    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requests.push({
          authorization: req.headers.authorization,
          body
        });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            number: 42,
            html_url: 'https://github.com/TailFox-31/idle-game/pull/42'
          })
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const publisher = new GitResultPublisher(
        createConfig({
          publishMode: 'pr',
          githubToken: 'github-token',
          githubApiBaseUrl: `http://127.0.0.1:${port}`
        })
      );

      const result = await publisher.publish({
        job: createJob({
          repo_url: 'git@github.com:TailFox-31/idle-game.git',
          base_commit: commit
        }),
        workerId: 'worker-a',
        provider: 'codex',
        workspacePath,
        executionResult: createExecutionResult()
      });

      expect(result?.summarySuffix).toBe('PR: https://github.com/TailFox-31/idle-game/pull/42');
      expect(result?.resultJson).toMatchObject({
        publish: {
          mode: 'pr',
          pull_request: {
            number: 42,
            url: 'https://github.com/TailFox-31/idle-game/pull/42'
          }
        }
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].authorization).toBe('Bearer github-token');
    } finally {
      server.close();
    }
  });
});
