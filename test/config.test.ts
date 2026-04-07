import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('loads required values from a repo-root .env file', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-config-'));

    await writeFile(
      path.join(tempDir, '.env'),
      [
        'CONTROL_PLANE_BASE_URL=http://127.0.0.1:8787/',
        'CONTROL_PLANE_TOKEN=secret-token',
        'WORKER_ID=worker-win-01',
        'WORKER_DISPLAY_NAME=Windows Worker 01',
        'WORKER_CAPABILITIES=os:windows,tool:codex,tool:git',
        'WORKER_MAX_CONCURRENCY=2',
        'WORKER_DEFAULT_PROVIDER=codex',
        'WORKER_EXECUTION_MODE=strict'
      ].join('\n'),
      'utf8'
    );

    const config = loadConfig({} as NodeJS.ProcessEnv, { cwd: tempDir });

    expect(config).toMatchObject({
      controlPlaneBaseUrl: 'http://127.0.0.1:8787',
      controlPlaneToken: 'secret-token',
      workerId: 'worker-win-01',
      displayName: 'Windows Worker 01',
      capabilities: ['os:windows', 'tool:codex', 'tool:git'],
      maxConcurrency: 2,
      defaultProvider: 'codex',
      executionMode: 'strict',
      codexBin: 'codex',
      codexSandbox: 'workspace-write',
      publishMode: 'artifact',
      publishBranchPrefix: 'job',
      gitCommitName: 'Remote Worker Agent',
      gitCommitEmail: 'remote-worker-agent@local',
      githubApiBaseUrl: 'https://api.github.com',
      githubPrDraft: false
    });
    expect(config.gitEnv).toEqual({});
    expect(config.runtimeEnv.CONTROL_PLANE_TOKEN).toBe('secret-token');
  });

  it('lets explicit process env override .env values', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-config-override-'));

    await writeFile(
      path.join(tempDir, '.env'),
      [
        'CONTROL_PLANE_BASE_URL=http://127.0.0.1:8787',
        'CONTROL_PLANE_TOKEN=file-token',
        'WORKER_ID=file-worker'
      ].join('\n'),
      'utf8'
    );

    const config = loadConfig(
      {
        CONTROL_PLANE_TOKEN: 'shell-token',
        WORKER_ID: 'shell-worker'
      } as NodeJS.ProcessEnv,
      { cwd: tempDir }
    );

    expect(config.controlPlaneToken).toBe('shell-token');
    expect(config.workerId).toBe('shell-worker');
    expect(config.controlPlaneBaseUrl).toBe('http://127.0.0.1:8787');
  });

  it('maps worker-scoped git auth variables into git environment', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-config-git-env-'));

    await writeFile(
      path.join(tempDir, '.env'),
      [
        'CONTROL_PLANE_BASE_URL=http://127.0.0.1:8787',
        'CONTROL_PLANE_TOKEN=file-token',
        'WORKER_ID=file-worker',
        'WORKER_GIT_SSH_COMMAND=ssh -i C:/Users/test/.ssh/id_ed25519 -o IdentitiesOnly=yes',
        'WORKER_GIT_TERMINAL_PROMPT=0'
      ].join('\n'),
      'utf8'
    );

    const config = loadConfig({} as NodeJS.ProcessEnv, { cwd: tempDir });

    expect(config.gitEnv).toEqual({
      GIT_SSH_COMMAND: 'ssh -i C:/Users/test/.ssh/id_ed25519 -o IdentitiesOnly=yes',
      GIT_TERMINAL_PROMPT: '0'
    });
  });

  it('allows codex-specific worker configuration from .env', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-config-codex-'));

    await writeFile(
      path.join(tempDir, '.env'),
      [
        'CONTROL_PLANE_BASE_URL=http://127.0.0.1:8787',
        'CONTROL_PLANE_TOKEN=file-token',
        'WORKER_ID=file-worker',
        'WORKER_CODEX_BIN=C:/Tools/codex.cmd',
        'WORKER_CODEX_MODEL=gpt-5.4-codex',
        'CODEX_HOME=C:/Users/test/.codex'
      ].join('\n'),
      'utf8'
    );

    const config = loadConfig({} as NodeJS.ProcessEnv, { cwd: tempDir });

    expect(config.codexBin).toBe('C:/Tools/codex.cmd');
    expect(config.codexModel).toBe('gpt-5.4-codex');
    expect(config.codexSandbox).toBe('workspace-write');
    expect(config.runtimeEnv.CODEX_HOME).toBe('C:/Users/test/.codex');
  });

  it('allows codex sandbox overrides', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-config-codex-sandbox-'));

    await writeFile(
      path.join(tempDir, '.env'),
      [
        'CONTROL_PLANE_BASE_URL=http://127.0.0.1:8787',
        'CONTROL_PLANE_TOKEN=file-token',
        'WORKER_ID=file-worker',
        'WORKER_CODEX_SANDBOX=danger-full-access'
      ].join('\n'),
      'utf8'
    );

    const config = loadConfig({} as NodeJS.ProcessEnv, { cwd: tempDir });

    expect(config.codexSandbox).toBe('danger-full-access');
  });

  it('allows publish and GitHub settings overrides', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-config-publish-'));

    await writeFile(
      path.join(tempDir, '.env'),
      [
        'CONTROL_PLANE_BASE_URL=http://127.0.0.1:8787',
        'CONTROL_PLANE_TOKEN=file-token',
        'WORKER_ID=file-worker',
        'WORKER_PUBLISH_MODE=pr',
        'WORKER_PUBLISH_BRANCH_PREFIX=worker/job',
        'WORKER_GIT_COMMIT_NAME=Bot User',
        'WORKER_GIT_COMMIT_EMAIL=bot@example.com',
        'WORKER_GITHUB_TOKEN=github-token',
        'WORKER_GITHUB_API_BASE_URL=https://ghe.example.test/api/v3',
        'WORKER_GITHUB_PR_DRAFT=true'
      ].join('\n'),
      'utf8'
    );

    const config = loadConfig({} as NodeJS.ProcessEnv, { cwd: tempDir });

    expect(config.publishMode).toBe('pr');
    expect(config.publishBranchPrefix).toBe('worker/job');
    expect(config.gitCommitName).toBe('Bot User');
    expect(config.gitCommitEmail).toBe('bot@example.com');
    expect(config.githubToken).toBe('github-token');
    expect(config.githubApiBaseUrl).toBe('https://ghe.example.test/api/v3');
    expect(config.githubPrDraft).toBe(true);
  });
});
