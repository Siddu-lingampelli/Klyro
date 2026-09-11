/**
 * 3.1 — TraceWriter (JSONL, fsync on tool results)
 *
 * Durability: appends serialize through a promise-chain queue (concurrent
 * writes stay line-valid), each line carries a per-file `seq` number, and
 * the serialized line is passed through redact() before it hits disk so
 * secrets never land in the trace. readAll skips corrupt lines instead of
 * discarding the whole trace.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { KlyroEvent } from '../events/catalog.js';
import { redact } from '../policy/secret-redactor.js';

export class TraceWriter {
  private filePath: string;
  /** Serializes appends; concurrent write() calls stay line-valid. */
  private queue: Promise<void> = Promise.resolve();
  private nextSeq = 0;
  private seqPrimed = false;

  constructor(sessionId: string, dir?: string) {
    const base = dir ?? path.join(process.cwd(), '.klyro', 'traces');
    this.filePath = path.join(base, `${sessionId}.jsonl`);
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // Ensure file exists
    try { await fs.appendFile(this.filePath, '', 'utf-8'); } catch { /* ignore */ }
  }

  /** Prime the seq counter from existing lines (so restarts don't reuse seqs). */
  private async primeSeq(): Promise<void> {
    if (this.seqPrimed) return;
    this.seqPrimed = true;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { seq?: unknown };
          if (typeof parsed.seq === 'number' && parsed.seq >= this.nextSeq) {
            this.nextSeq = parsed.seq + 1;
          }
        } catch { /* corrupt line — ignored, readAll skips it too */ }
      }
    } catch { /* missing file — seq starts at 0 */ }
  }

  async write(ev: KlyroEvent): Promise<void> {
    const task = this.queue.then(() => this.appendOne(ev));
    // Keep the queue alive across failures; the caller still sees its error.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async appendOne(ev: KlyroEvent): Promise<void> {
    await this.primeSeq();
    const line = redact(JSON.stringify({ ...ev, seq: this.nextSeq++ })) + '\n';
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
    // Drain the queue — no persistent handle to close.
    await this.queue;
  }

  get path(): string {
    return this.filePath;
  }

  // For tests: read back (skips unparseable lines, never discards the trace).
  async readAll(): Promise<KlyroEvent[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const out: KlyroEvent[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as KlyroEvent);
        } catch {
          continue; // corrupt line skipped
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}
