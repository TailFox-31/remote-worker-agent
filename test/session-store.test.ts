import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonSessionStore } from '../src/session-store.js';

describe('JsonSessionStore', () => {
  it('persists and reloads provider-specific sessions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remote-worker-agent-store-'));
    const filePath = path.join(tempDir, 'store.json');
    const store = new JsonSessionStore(filePath);

    await store.set({
      session_key: 'room:1',
      provider: 'codex',
      opaque_session_id: 'sess-1',
      updated_at: '2026-04-07T00:00:00Z'
    });

    const stored = await store.get('room:1', 'codex');

    expect(stored).toEqual({
      provider: 'codex',
      opaque_session_id: 'sess-1'
    });

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { records: Array<{ session_key: string }> };
    expect(raw.records).toHaveLength(1);
    expect(raw.records[0]?.session_key).toBe('room:1');
  });
});
