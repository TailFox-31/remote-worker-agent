import { describe, expect, it, vi } from 'vitest';

import { ControlPlaneClient, ControlPlaneHttpError } from '../src/control-plane-client.js';

describe('ControlPlaneClient', () => {
  it('returns null when claim endpoint responds 204', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new ControlPlaneClient('https://example.test', 'token-1', fetchMock as typeof fetch);

    const result = await client.claimJob('worker-a');

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/v1/jobs/claim',
      expect.objectContaining({
        method: 'POST'
      })
    );
  });

  it('sends lease token for attempt calls', async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer token-2',
        'x-lease-token': 'lease-123'
      });

      return new Response(JSON.stringify({ status: 'running' }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    });
    const client = new ControlPlaneClient('https://example.test', 'token-2', fetchMock as typeof fetch);

    await client.startAttempt('attempt-1', 'lease-123', {
      worker_id: 'worker-a',
      provider: 'codex',
      session_reused: false
    });
  });

  it('throws structured error for non-2xx responses', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'bad_request' }), {
          status: 422,
          headers: {
            'content-type': 'application/json'
          }
        })
    );
    const client = new ControlPlaneClient('https://example.test', 'token-3', fetchMock as typeof fetch);

    await expect(client.getJob('job-1')).rejects.toMatchObject({
      status: 422,
      body: { error: 'bad_request' }
    });
  });
});
