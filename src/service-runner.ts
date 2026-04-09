import { setTimeout as sleep } from 'node:timers/promises';

import type { WorkerConfig } from './config.js';
import type { WorkerCycleResult } from './worker.js';

export interface AgentServiceLoop {
  register(): Promise<void>;
  runLoop(
    signal?: AbortSignal,
    onCycleResult?: (result: WorkerCycleResult) => void | Promise<void>
  ): Promise<void>;
}

export interface ServiceRunnerDependencies {
  agent: AgentServiceLoop;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  logger?: Pick<Console, 'warn'>;
}

export interface RunAgentServiceOptions {
  signal?: AbortSignal;
  onCycleResult?: (result: WorkerCycleResult) => void | Promise<void>;
}

function computeRetryDelayMs(
  attemptNumber: number,
  initialDelayMs: number,
  maxDelayMs: number
): number {
  const exponent = Math.max(0, attemptNumber - 1);
  return Math.min(maxDelayMs, initialDelayMs * 2 ** exponent);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

async function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  await sleep(delayMs, undefined, { signal }).catch((error: unknown) => {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.name !== 'AbortError') {
      throw error;
    }
  });
}

export async function runAgentService(
  config: Pick<WorkerConfig, 'retryInitialDelayMs' | 'retryMaxDelayMs'>,
  deps: ServiceRunnerDependencies,
  options: RunAgentServiceOptions = {}
): Promise<void> {
  const wait = deps.sleep ?? defaultSleep;
  const logger = deps.logger ?? console;
  let consecutiveFailures = 0;

  while (!options.signal?.aborted) {
    try {
      await deps.agent.register();
      consecutiveFailures = 0;
      await deps.agent.runLoop(options.signal, options.onCycleResult);
      return;
    } catch (error) {
      if (options.signal?.aborted) {
        return;
      }

      consecutiveFailures += 1;
      const delayMs = computeRetryDelayMs(
        consecutiveFailures,
        config.retryInitialDelayMs,
        config.retryMaxDelayMs
      );
      logger.warn?.(
        `[worker] service loop failed (${formatError(error)}); retrying in ${delayMs}ms`
      );
      await wait(delayMs, options.signal);
    }
  }
}

export { computeRetryDelayMs };
