import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SessionProvider, SessionResume } from './types.js';

export interface SessionRecord extends SessionResume {
  session_key: string;
  updated_at: string;
}

interface SessionStoreDocument {
  version: 1;
  records: SessionRecord[];
}

export class JsonSessionStore {
  constructor(private readonly filePath: string) {}

  async get(sessionKey: string, provider: SessionProvider): Promise<SessionResume | null> {
    const document = await this.readDocument();
    const record = document.records.find(
      (candidate) => candidate.session_key === sessionKey && candidate.provider === provider
    );

    if (!record) {
      return null;
    }

    return {
      provider: record.provider,
      opaque_session_id: record.opaque_session_id
    };
  }

  async set(record: SessionRecord): Promise<void> {
    const document = await this.readDocument();
    const nextRecords = document.records.filter(
      (candidate) => !(candidate.session_key === record.session_key && candidate.provider === record.provider)
    );
    nextRecords.push(record);
    await this.writeDocument({
      version: 1,
      records: nextRecords
    });
  }

  private async readDocument(): Promise<SessionStoreDocument> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as SessionStoreDocument;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return {
          version: 1,
          records: []
        };
      }

      throw error;
    }
  }

  private async writeDocument(document: SessionStoreDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }
}
