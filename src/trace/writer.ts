/**
 * 3.1 — TraceWriter (JSONL, fsync on tool results)
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { KlyroEvent } from '../events/catalog.js';

export class TraceWriter {
  private filePath: string;

  constructor(sessionId: string, dir?: string) {
    const base = dir ?? path.join(process.cwd(), '.klyro', 'traces');
    this.filePath = path.join(base, `${sessionId}.jsonl`);
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // Ensure file exists
    try { await fs.appendFile(this.filePath, '', 'utf-8'); } catch { /* ignore */ }
  }

  async write(ev: KlyroEvent): Promise<void> {
    const line = JSON.stringify(ev) + '\n';
    await fs.appendFile(this.filePath, line, 'utf-8');
    // fsync on tool results for crash safety
    if (ev.type === 'tool.result') {
      try {
        const handle = await fs.open(this.filePath, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
      } catch { /* ignore */ }
    }
  }

  async close(): Promise<void> {
    // No persistent handle to close
  }

  get path(): string {
    return this.filePath;
  }

  // For tests: read back
  async readAll(): Promise<KlyroEvent[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as KlyroEvent);
    } catch {
      return [];
    }
  }
}
