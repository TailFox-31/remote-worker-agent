import { describe, expect, it, vi } from 'vitest';

import { computeRetryDelayMs, runAgentService } from '../src/service-runner.js';

describe('runAgentService', () => {
  it('retries register failures with backoff until registration succeeds', async () => {
    const controller = new AbortController();
    const register = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('control plane offline'))
      .mockResolvedValueOnce();
    const runLoop = vi.fn(async () => {
      controller.abort();
    });
    const sleep = vi.fn(async () => {});

    await runAgentService(
      {
        retryInitialDelayMs: 100,
        retryMaxDelayMs: 1_000
      },
      {
        agent: { register, runLoop },
        sleep,
        logger: { warn: vi.fn() }
      },
      {
        signal: controller.signal
      }
    );

    expect(register).toHaveBeenCalledTimes(2);
    expect(runLoop).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(100, controller.signal);
  });

  it('restarts the loop after a top-level runLoop failure', async () => {
    const controller = new AbortController();
    const register = vi.fn<() => Promise<void>>(async () => {});
    const runLoop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('heartbeat failed'))
      .mockImplementationOnce(async () => {
        controller.abort();
      });
    const sleep = vi.fn(async () => {});

    await runAgentService(
      {
        retryInitialDelayMs: 250,
        retryMaxDelayMs: 1_000
      },
      {
        agent: { register, runLoop },
        sleep,
        logger: { warn: vi.fn() }
      },
      {
        signal: controller.signal
      }
    );

    expect(register).toHaveBeenCalledTimes(2);
    expect(runLoop).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250, controller.signal);
  });
});

describe('computeRetryDelayMs', () => {
  it('caps exponential backoff at the configured maximum', () => {
    expect(computeRetryDelayMs(1, 1_000, 60_000)).toBe(1_000);
    expect(computeRetryDelayMs(2, 1_000, 60_000)).toBe(2_000);
    expect(computeRetryDelayMs(7, 1_000, 60_000)).toBe(60_000);
  });
});
