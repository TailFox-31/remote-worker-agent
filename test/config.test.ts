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
      executionMode: 'strict'
    });
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
});
