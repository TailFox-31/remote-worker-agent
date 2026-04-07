import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { ExecutorArtifact, ExecutorRunResult, RemoteWorkerJob, SessionResume } from '../types.js';
import { SkeletonExecutor, type ExecutorRunContext } from './base.js';

const MAX_CAPTURE_BYTES = 256 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

interface CodexExecutorOptions {
  executionMode: 'dry-run' | 'strict';
  bin?: string;
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  env?: NodeJS.ProcessEnv;
  heartbeatIntervalMs?: number;
}

interface CapturedProcessOutput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ParsedCodexOutput {
  sessionId?: string;
  lastAgentMessage?: string;
  usage?: Record<string, number>;
}

interface ProcessSpec {
  command: string;
  args: string[];
}

function buildPrompt(job: RemoteWorkerJob): string {
  const lines = [job.prompt, '', `Mode: ${job.mode}`, `Branch: ${job.branch}`, `Base commit: ${job.base_commit}`];

  if (job.target_files.length > 0) {
    lines.push('', 'Target files:', ...job.target_files.map((file) => `- ${file}`));
  }

  lines.push('', 'Work inside the current prepared git worktree and leave the result in the workspace.');

  return lines.join('\n');
}

function truncateContent(content: string): { text: string; truncated: boolean } {
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.length <= MAX_CAPTURE_BYTES) {
    return {
      text: content,
      truncated: false
    };
  }

  return {
    text: buffer.subarray(0, MAX_CAPTURE_BYTES).toString('utf8'),
    truncated: true
  };
}

function encodeInlineArtifact(
  kind: ExecutorArtifact['request']['kind'],
  contentType: string,
  content: string,
  metadata: Record<string, unknown> = {}
): ExecutorArtifact {
  const buffer = Buffer.from(content, 'utf8');
  return {
    request: {
      kind,
      storage_type: 'inline',
      content_type: contentType,
      content_base64: buffer.toString('base64'),
      sha256: createHash('sha256').update(buffer).digest('hex'),
      size_bytes: buffer.length,
      metadata
    }
  };
}

function parseCodexJsonOutput(stdout: string): ParsedCodexOutput {
  const parsed: ParsedCodexOutput = {};

  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        parsed.sessionId = event.thread_id;
      }

      if (event.type === 'item.completed' && typeof event.item === 'object' && event.item) {
        const item = event.item as Record<string, unknown>;
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          parsed.lastAgentMessage = item.text;
        }
      }

      if (event.type === 'turn.completed' && typeof event.usage === 'object' && event.usage) {
        parsed.usage = event.usage as Record<string, number>;
      }
    } catch {
      /* ignore malformed lines */
    }
  }

  return parsed;
}

function buildProgressMessage(stdoutBytes: number, stderrBytes: number): string {
  return `codex exec running (stdout=${stdoutBytes}B, stderr=${stderrBytes}B)`;
}

function buildCodexProcess(bin: string, args: string[]): ProcessSpec {
  if (process.platform !== 'win32') {
    return { command: bin, args };
  }

  return {
    command: bin,
    args
  };
}

async function collectProcessOutput(
  processSpec: ProcessSpec,
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdinContent: string,
  onProgress: (stdoutBytes: number, stderrBytes: number) => Promise<void>,
  heartbeatIntervalMs: number,
  signal?: AbortSignal
): Promise<CapturedProcessOutput> {
  const child = spawn(processSpec.command, processSpec.args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true
  });

  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let heartbeatError: unknown;
  let abortError: Error | null = null;
  let heartbeatInFlight: Promise<void> | null = null;

  const terminateChild = (): void => {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, 2_000).unref();
  };

  const pulseHeartbeat = async (): Promise<void> => {
    if (heartbeatError || heartbeatInFlight) {
      return;
    }

    heartbeatInFlight = onProgress(stdoutBytes, stderrBytes).catch((error) => {
      heartbeatError = error;
      terminateChild();
    });

    try {
      await heartbeatInFlight;
    } finally {
      heartbeatInFlight = null;
    }
  };

  const heartbeatTimer = setInterval(() => {
    void pulseHeartbeat();
  }, heartbeatIntervalMs);

  const handleAbort = (): void => {
    if (!abortError) {
      abortError = new Error('codex execution aborted');
    }
    terminateChild();
  };

  if (signal) {
    if (signal.aborted) {
      handleAbort();
    } else {
      signal.addEventListener('abort', handleAbort, { once: true });
    }
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    stdoutBytes += Buffer.byteLength(chunk, 'utf8');
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    stderrBytes += Buffer.byteLength(chunk, 'utf8');
  });

  child.stdin.end(stdinContent, 'utf8');

  const exit = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => {
    clearInterval(heartbeatTimer);
    signal?.removeEventListener('abort', handleAbort);
  });

  if (heartbeatInFlight) {
    await heartbeatInFlight;
  }

  if (heartbeatError) {
    throw heartbeatError;
  }

  if (abortError) {
    throw abortError;
  }

  return {
    ...exit,
    stdout,
    stderr
  };
}

async function captureGitDiff(workspacePath: string): Promise<string> {
  const child = spawn('git', ['-C', workspacePath, 'diff', '--binary', '--no-color'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const { exitCode } = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (receivedExitCode, signal) => resolve({ exitCode: receivedExitCode, signal }));
  });

  if (exitCode !== 0) {
    throw new Error(`git diff failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
  }

  return stdout;
}

function buildArtifacts(
  workspacePath: string,
  stdout: string,
  stderr: string,
  diff: string,
  report: Record<string, unknown>
): ExecutorArtifact[] {
  const artifacts: ExecutorArtifact[] = [
    encodeInlineArtifact('report', 'application/json', `${JSON.stringify(report, null, 2)}\n`)
  ];

  if (stdout.trim()) {
    const captured = truncateContent(stdout);
    artifacts.push(
      encodeInlineArtifact('stdout', 'application/x-ndjson', captured.text, {
        truncated: captured.truncated
      })
    );
  }

  if (stderr.trim()) {
    const captured = truncateContent(stderr);
    artifacts.push(
      encodeInlineArtifact('stderr', 'text/plain', captured.text, {
        truncated: captured.truncated
      })
    );
  }

  if (diff.trim()) {
    const captured = truncateContent(diff);
    artifacts.push(
      encodeInlineArtifact('patch', 'text/x-diff', captured.text, {
        truncated: captured.truncated,
        workspace_path: workspacePath
      })
    );
  }

  return artifacts;
}

export class CodexExecutor extends SkeletonExecutor {
  private readonly bin: string;
  private readonly model?: string;
  private readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  private readonly env: NodeJS.ProcessEnv;
  private readonly heartbeatIntervalMs: number;

  constructor(optionsOrMode: CodexExecutorOptions | 'dry-run' | 'strict') {
    const options =
      typeof optionsOrMode === 'string'
        ? { executionMode: optionsOrMode }
        : optionsOrMode;

    super('codex', options.executionMode);
    this.bin = options.bin ?? 'codex';
    this.model = options.model;
    this.sandbox = options.sandbox ?? 'workspace-write';
    this.env = options.env ?? process.env;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  override async run(context: ExecutorRunContext): Promise<ExecutorRunResult> {
    if (this.executionMode !== 'strict') {
      return super.run(context);
    }

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-codex-'));
    const outputFilePath = path.join(tmpDir, 'last-message.txt');
    const args = ['exec'];
    const prompt = buildPrompt(context.job);

    if (context.resumeSession?.opaque_session_id) {
      args.push('resume', context.resumeSession.opaque_session_id);
    }

    args.push('--skip-git-repo-check', '--json', '-o', outputFilePath);
    args.push('-s', this.sandbox);

    if (this.model) {
      args.push('-m', this.model);
    }

    const processSpec = buildCodexProcess(this.bin, args);

    await context.onProgress('execute', `${this.provider} executor started`);

    try {
      const output = await collectProcessOutput(
        processSpec,
        context.workspacePath,
        {
          ...process.env,
          ...this.env
        },
        prompt,
        async (stdoutBytes, stderrBytes) => {
          await context.onProgress('execute', buildProgressMessage(stdoutBytes, stderrBytes));
        },
        this.heartbeatIntervalMs,
        context.signal
      );

      const parsedOutput = parseCodexJsonOutput(output.stdout);
      const outputText = (await readFile(outputFilePath, 'utf8').catch(() => '')).trim();
      const diff = await captureGitDiff(context.workspacePath);
      const summary =
        outputText || parsedOutput.lastAgentMessage || `codex exec completed for ${context.job.job_id}`;

      const report = {
        provider: this.provider,
        workspace_path: context.workspacePath,
        exit_code: output.exitCode,
        signal: output.signal,
        session_id: parsedOutput.sessionId ?? context.resumeSession?.opaque_session_id,
        resumed_session_id: context.resumeSession?.opaque_session_id ?? null,
        command: [processSpec.command, ...processSpec.args].join(' '),
        model: this.model ?? null,
        sandbox: this.sandbox,
        prompt_preview: context.job.prompt.slice(0, 200),
        usage: parsedOutput.usage ?? null
      };

      const artifacts = buildArtifacts(context.workspacePath, output.stdout, output.stderr, diff, report);

      if (output.exitCode === 0) {
        return {
          status: 'completed',
          result_summary: summary,
          result_json: {
            provider: this.provider,
            workspace_path: context.workspacePath,
            exit_code: output.exitCode,
            session_id: parsedOutput.sessionId ?? context.resumeSession?.opaque_session_id ?? null,
            usage: parsedOutput.usage ?? null
          },
          opaque_session_id:
            parsedOutput.sessionId ??
            context.resumeSession?.opaque_session_id ??
            `${this.provider}:${context.job.job_id}`,
          artifacts
        };
      }

      return {
        status: 'failed',
        result_summary: `codex exec failed for ${context.job.job_id}`,
        failure_code: 'codex_exec_failed',
        failure_message: output.stderr.trim() || summary || `codex exited with code ${output.exitCode ?? 'unknown'}`,
        result_json: {
          provider: this.provider,
          workspace_path: context.workspacePath,
          exit_code: output.exitCode,
          signal: output.signal,
          session_id: parsedOutput.sessionId ?? context.resumeSession?.opaque_session_id ?? null
        },
        opaque_session_id:
          parsedOutput.sessionId ??
          context.resumeSession?.opaque_session_id ??
          `${this.provider}:${context.job.job_id}`,
        artifacts
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}
