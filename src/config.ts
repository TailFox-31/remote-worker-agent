import path from 'node:path';
import process from 'node:process';

import type { SessionProvider } from './types.js';

export interface WorkerConfig {
  controlPlaneBaseUrl: string;
  controlPlaneToken: string;
  workerId: string;
  displayName: string;
  capabilities: string[];
  maxConcurrency: number;
  defaultProvider: SessionProvider;
  executionMode: 'dry-run' | 'strict';
  pollIntervalMs: number;
  workspaceRoot: string;
  sessionStorePath: string;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected positive integer, received: ${raw}`);
  }

  return value;
}

function parseProvider(raw: string | undefined): SessionProvider {
  if (!raw || raw === 'codex') {
    return 'codex';
  }

  if (raw === 'claude-code') {
    return 'claude-code';
  }

  throw new Error(`Unsupported provider: ${raw}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const controlPlaneBaseUrl = requireEnv(env, 'CONTROL_PLANE_BASE_URL').replace(/\/+$/, '');
  const controlPlaneToken = requireEnv(env, 'CONTROL_PLANE_TOKEN');
  const workerId = requireEnv(env, 'WORKER_ID');

  const workspaceRoot = path.resolve(env.WORKER_WORKSPACE_ROOT ?? '.workspaces');
  const sessionStorePath = path.resolve(env.WORKER_SESSION_STORE ?? '.sessions/store.json');
  const capabilities = (env.WORKER_CAPABILITIES ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  const executionMode = env.WORKER_EXECUTION_MODE === 'strict' ? 'strict' : 'dry-run';

  return {
    controlPlaneBaseUrl,
    controlPlaneToken,
    workerId,
    displayName: env.WORKER_DISPLAY_NAME ?? workerId,
    capabilities,
    maxConcurrency: parsePositiveInteger(env.WORKER_MAX_CONCURRENCY, 1),
    defaultProvider: parseProvider(env.WORKER_DEFAULT_PROVIDER),
    executionMode,
    pollIntervalMs: parsePositiveInteger(env.WORKER_POLL_INTERVAL_MS, 5000),
    workspaceRoot,
    sessionStorePath
  };
}
