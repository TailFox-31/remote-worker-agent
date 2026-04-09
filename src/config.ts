import fs from 'node:fs';
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
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  attemptHeartbeatRetryCount: number;
  workspaceRoot: string;
  sessionStorePath: string;
  codexBin: string;
  codexModel?: string;
  codexSandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  publishMode: 'artifact' | 'push' | 'pr';
  publishBranchPrefix: string;
  gitCommitName: string;
  gitCommitEmail: string;
  githubToken?: string;
  githubApiBaseUrl: string;
  githubPrDraft: boolean;
  gitEnv: NodeJS.ProcessEnv;
  runtimeEnv: NodeJS.ProcessEnv;
}

export interface LoadConfigOptions {
  cwd?: string;
  envFilePath?: string;
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

function parseCodexSandbox(raw: string | undefined): WorkerConfig['codexSandbox'] {
  if (!raw || raw === 'workspace-write') {
    return 'workspace-write';
  }

  if (raw === 'read-only' || raw === 'danger-full-access') {
    return raw;
  }

  throw new Error(`Unsupported codex sandbox: ${raw}`);
}

function parsePublishMode(raw: string | undefined): WorkerConfig['publishMode'] {
  if (!raw || raw === 'artifact') {
    return 'artifact';
  }

  if (raw === 'push' || raw === 'pr') {
    return raw;
  }

  throw new Error(`Unsupported publish mode: ${raw}`);
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }

  if (raw === 'true') {
    return true;
  }

  if (raw === 'false') {
    return false;
  }

  throw new Error(`Expected boolean, received: ${raw}`);
}

function parseDotEnv(content: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalizedLine = line.startsWith('export ') ? line.slice('export '.length) : line;
    const separatorIndex = normalizedLine.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    let value = normalizedLine.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

function loadDotEnvFile(envFilePath: string): NodeJS.ProcessEnv {
  if (!fs.existsSync(envFilePath)) {
    return {};
  }

  return parseDotEnv(fs.readFileSync(envFilePath, 'utf8'));
}

function pickGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const gitEnv: NodeJS.ProcessEnv = {};
  const mappings: Array<[source: string, target: string]> = [
    ['WORKER_GIT_SSH_COMMAND', 'GIT_SSH_COMMAND'],
    ['WORKER_GIT_ASKPASS', 'GIT_ASKPASS'],
    ['WORKER_GIT_TERMINAL_PROMPT', 'GIT_TERMINAL_PROMPT'],
    ['WORKER_SSH_AUTH_SOCK', 'SSH_AUTH_SOCK'],
    ['GIT_SSH_COMMAND', 'GIT_SSH_COMMAND'],
    ['GIT_ASKPASS', 'GIT_ASKPASS'],
    ['GIT_TERMINAL_PROMPT', 'GIT_TERMINAL_PROMPT'],
    ['SSH_AUTH_SOCK', 'SSH_AUTH_SOCK']
  ];

  for (const [sourceKey, targetKey] of mappings) {
    const value = env[sourceKey];
    if (value && !gitEnv[targetKey]) {
      gitEnv[targetKey] = value;
    }
  }

  return gitEnv;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {}
): WorkerConfig {
  const envFilePath = options.envFilePath ?? path.resolve(options.cwd ?? process.cwd(), '.env');
  const mergedEnv: NodeJS.ProcessEnv = {
    ...loadDotEnvFile(envFilePath),
    ...env
  };

  const controlPlaneBaseUrl = requireEnv(mergedEnv, 'CONTROL_PLANE_BASE_URL').replace(/\/+$/, '');
  const controlPlaneToken = requireEnv(mergedEnv, 'CONTROL_PLANE_TOKEN');
  const workerId = requireEnv(mergedEnv, 'WORKER_ID');

  const workspaceRoot = path.resolve(mergedEnv.WORKER_WORKSPACE_ROOT ?? '.workspaces');
  const sessionStorePath = path.resolve(mergedEnv.WORKER_SESSION_STORE ?? '.sessions/store.json');
  const capabilities = (mergedEnv.WORKER_CAPABILITIES ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  const executionMode = mergedEnv.WORKER_EXECUTION_MODE === 'strict' ? 'strict' : 'dry-run';

  return {
    controlPlaneBaseUrl,
    controlPlaneToken,
    workerId,
    displayName: mergedEnv.WORKER_DISPLAY_NAME ?? workerId,
    capabilities,
    maxConcurrency: parsePositiveInteger(mergedEnv.WORKER_MAX_CONCURRENCY, 1),
    defaultProvider: parseProvider(mergedEnv.WORKER_DEFAULT_PROVIDER),
    executionMode,
    pollIntervalMs: parsePositiveInteger(mergedEnv.WORKER_POLL_INTERVAL_MS, 5000),
    retryInitialDelayMs: parsePositiveInteger(mergedEnv.WORKER_RETRY_INITIAL_MS, 1000),
    retryMaxDelayMs: parsePositiveInteger(mergedEnv.WORKER_RETRY_MAX_MS, 60000),
    attemptHeartbeatRetryCount: parsePositiveInteger(mergedEnv.WORKER_ATTEMPT_HEARTBEAT_MAX_RETRIES, 3),
    workspaceRoot,
    sessionStorePath,
    codexBin: mergedEnv.WORKER_CODEX_BIN?.trim() || 'codex',
    codexModel: mergedEnv.WORKER_CODEX_MODEL?.trim() || undefined,
    codexSandbox: parseCodexSandbox(mergedEnv.WORKER_CODEX_SANDBOX),
    publishMode: parsePublishMode(mergedEnv.WORKER_PUBLISH_MODE),
    publishBranchPrefix: mergedEnv.WORKER_PUBLISH_BRANCH_PREFIX?.trim() || 'job',
    gitCommitName: mergedEnv.WORKER_GIT_COMMIT_NAME?.trim() || 'Remote Worker Agent',
    gitCommitEmail: mergedEnv.WORKER_GIT_COMMIT_EMAIL?.trim() || 'remote-worker-agent@local',
    githubToken:
      mergedEnv.WORKER_GITHUB_TOKEN?.trim() ||
      mergedEnv.GITHUB_TOKEN?.trim() ||
      mergedEnv.GH_TOKEN?.trim() ||
      undefined,
    githubApiBaseUrl:
      mergedEnv.WORKER_GITHUB_API_BASE_URL?.trim().replace(/\/+$/u, '') || 'https://api.github.com',
    githubPrDraft: parseBoolean(mergedEnv.WORKER_GITHUB_PR_DRAFT, false),
    gitEnv: pickGitEnv(mergedEnv),
    runtimeEnv: { ...mergedEnv }
  };
}
