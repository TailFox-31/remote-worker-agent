import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { describe, expect, it, vi } from 'vitest';

import { CodexExecutor } from '../src/executors/codex.js';
import type { ExecutorRunContext } from '../src/executors/base.js';

function initGitRepo(repoPath: string): void {
  execFileSync('git', ['init', '-q'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
}

function commitAll(repoPath: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-qm', message], { cwd: repoPath });
}

async function createFakeCodexBinary(rootPath: string): Promise<string> {
  const runnerPath = path.join(rootPath, 'fake-codex-runner.mjs');
  const script = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
const resumeIndex = args.indexOf('resume');
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : 'sess-fake-001';
const prompt = fs.readFileSync(0, 'utf8');

if (process.env.FAKE_CODEX_MODE === 'fail') {
  process.stderr.write('fake codex failed\\n');
  process.exit(17);
}

fs.writeFileSync(path.join(process.cwd(), 'prompt.log'), prompt, 'utf8');
const gitConfigEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith('GIT_CONFIG_'))
);
fs.writeFileSync(path.join(process.cwd(), 'git-config-env.json'), JSON.stringify(gitConfigEnv, null, 2), 'utf8');
const safeDirectories = execFileSync('git', ['config', '--get-all', 'safe.directory'], {
  cwd: process.cwd(),
  encoding: 'utf8'
});
fs.writeFileSync(path.join(process.cwd(), 'safe-directories.txt'), safeDirectories, 'utf8');
fs.appendFileSync(path.join(process.cwd(), 'note.txt'), '\\nchanged-by-fake-codex', 'utf8');

if (outputPath) {
  fs.writeFileSync(outputPath, resumeIndex >= 0 ? 'RESUMED' : 'DONE', 'utf8');
}

process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: sessionId }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_0',
    type: 'agent_message',
    text: resumeIndex >= 0 ? 'RESUMED' : 'DONE'
  }
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'turn.completed',
  usage: {
    input_tokens: 123,
    output_tokens: 45
  }
}) + '\\n');
process.stderr.write('fake stderr\\n');
`;

  await writeFile(runnerPath, script, 'utf8');
  await chmod(runnerPath, 0o755);

  if (process.platform === 'win32') {
    const commandPath = path.join(rootPath, 'fake-codex.cmd');
    const escapedRunnerPath = runnerPath.replace(/"/g, '""');
    const wrapper = `@echo off\r\n"${process.execPath}" "${escapedRunnerPath}" %*\r\n`;
    await writeFile(commandPath, wrapper, 'utf8');
    return commandPath;
  }

  const commandPath = path.join(rootPath, 'fake-codex');
  const wrapper = `#!/usr/bin/env sh\nexec "${process.execPath}" "${runnerPath}" "$@"\n`;
  await writeFile(commandPath, wrapper, 'utf8');
  await chmod(commandPath, 0o755);
  return commandPath;
}

function createContext(workspacePath: string, resumeSession: ExecutorRunContext['resumeSession'] = null): ExecutorRunContext {
  return {
    job: {
      job_id: 'job-codex-1',
      workspace_key: 'repo:test',
      repo_url: 'git@github.com:TailFox-31/remote-worker-agent.git',
      branch: 'main',
      base_commit: 'abc1234',
      mode: 'edit',
      requirements: ['tool:codex'],
      prompt: 'Update note.txt and describe the change.',
      target_files: ['note.txt'],
      timeout_sec: 600
    },
    workspacePath,
    resumeSession,
    signal: new AbortController().signal,
    onProgress: vi.fn(async () => {})
  };
}

describe('CodexExecutor', () => {
  it('runs codex strict mode, captures session id, and uploads artifacts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-codex-'));
    const workspacePath = path.join(tempDir, 'repo');
    const binaryPath = await createFakeCodexBinary(tempDir);

    await mkdir(workspacePath, { recursive: true });
    initGitRepo(workspacePath);
    await writeFile(path.join(workspacePath, 'note.txt'), 'initial\n', 'utf8');
    commitAll(workspacePath, 'init');

    const executor = new CodexExecutor({
      executionMode: 'strict',
      bin: binaryPath,
      sandbox: 'workspace-write',
      env: process.env
    });
    const context = createContext(workspacePath);

    const result = await executor.run(context);

    expect(result.status).toBe('completed');
    expect(result.result_summary).toBe('DONE');
    expect(result.opaque_session_id).toBe('sess-fake-001');
    expect(result.artifacts?.map((artifact) => artifact.request.kind)).toEqual(
      expect.arrayContaining(['report', 'stdout', 'stderr', 'patch'])
    );
    const gitConfigEnv = JSON.parse(
      await readFile(path.join(workspacePath, 'git-config-env.json'), 'utf8')
    ) as Record<string, string>;
    expect(gitConfigEnv.GIT_CONFIG_COUNT).toBeDefined();
    const configKeys = Object.entries(gitConfigEnv)
      .filter(([key]) => key.startsWith('GIT_CONFIG_KEY_'))
      .map(([, value]) => value);
    const configValues = Object.entries(gitConfigEnv)
      .filter(([key]) => key.startsWith('GIT_CONFIG_VALUE_'))
      .map(([, value]) => value);
    expect(configKeys).toContain('safe.directory');
    expect(configValues).toContain(workspacePath);
    const safeDirectories = await readFile(path.join(workspacePath, 'safe-directories.txt'), 'utf8');
    expect(safeDirectories.split(/\r?\n/u).filter(Boolean)).toContain(workspacePath);
    expect((context.onProgress as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it('reuses resume session ids for codex exec resume', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-codex-resume-'));
    const workspacePath = path.join(tempDir, 'repo');
    const binaryPath = await createFakeCodexBinary(tempDir);

    await mkdir(workspacePath, { recursive: true });
    initGitRepo(workspacePath);
    await writeFile(path.join(workspacePath, 'note.txt'), 'initial\n', 'utf8');
    commitAll(workspacePath, 'init');

    const executor = new CodexExecutor({
      executionMode: 'strict',
      bin: binaryPath,
      sandbox: 'workspace-write',
      env: process.env
    });
    const context = createContext(workspacePath, {
      provider: 'codex',
      opaque_session_id: 'sess-existing-123'
    });

    const result = await executor.run(context);

    expect(result.status).toBe('completed');
    expect(result.result_summary).toBe('RESUMED');
    expect(result.opaque_session_id).toBe('sess-existing-123');
  });

  it('returns a failed result when codex exits non-zero', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-codex-fail-'));
    const workspacePath = path.join(tempDir, 'repo');
    const binaryPath = await createFakeCodexBinary(tempDir);

    await mkdir(workspacePath, { recursive: true });
    initGitRepo(workspacePath);
    await writeFile(path.join(workspacePath, 'note.txt'), 'initial\n', 'utf8');
    commitAll(workspacePath, 'init');

    const executor = new CodexExecutor({
      executionMode: 'strict',
      bin: binaryPath,
      sandbox: 'workspace-write',
      env: {
        ...process.env,
        FAKE_CODEX_MODE: 'fail'
      }
    });
    const context = createContext(workspacePath);

    const result = await executor.run(context);

    expect(result.status).toBe('failed');
    expect(result.failure_code).toBe('codex_exec_failed');
    expect(result.failure_message).toContain('fake codex failed');
  });
});
