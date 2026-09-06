/**
 * Session store — JSON-on-disk persistence for sessions, transcripts,
 * and observations. Single file per session, indexed by a `sessions.json`
 * directory index. No native deps.
 *
 * MVP rationale: better-sqlite3 needs a native build step that fails on
 * some Windows installs. A JSON file per session + a flat index is
 * trivial to back up, easy to inspect, and good enough for the MVP's
 * ~50-task eval suite. v1.0 can swap in SQLite behind the same
 * SessionStore interface.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export type SessionStatus = 'open' | 'complete' | 'verify_failed' | 'aborted' | 'max_steps';

export interface SessionConfig {
  model: string;
  maxSteps: number;
  policyAllow?: string[];
}

export interface SessionRecord {
  id: string;
  cwd: string;
  task: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  config: SessionConfig;
  finalText?: string;
}

export interface StoredMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: unknown;
  ts: number;
}

export interface StoredObservation {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  startedAt: number;
  finishedAt: number;
}

export class SessionStore {
  private readonly dir: string;
  private readonly indexPath: string;

  constructor(dir: string) {
    this.dir = dir;
    this.indexPath = path.join(dir, 'sessions.json');
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private async readIndex(): Promise<Record<string, SessionRecord>> {
    try {
      const raw = await fs.readFile(this.indexPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async writeIndex(idx: Record<string, SessionRecord>): Promise<void> {
    const tmp = `${this.indexPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await fs.writeFile(tmp, JSON.stringify(idx, null, 2), 'utf-8');
    try {
      const fh = await fs.open(tmp, 'r+');
      try { await fh.sync(); } finally { await fh.close(); }
    } catch { /* ignore on Windows */ }
    try {
      await fs.rename(tmp, this.indexPath);
    } catch {
      await fs.unlink(tmp).catch(() => undefined);
      throw new Error('Failed to write sessions index');
    }
  }

  async create(opts: { cwd: string; task: string; config: SessionConfig }): Promise<SessionRecord> {
    await this.ensureDir();
    const id = randomUUID();
    const now = Date.now();
    const record: SessionRecord = {
      id,
      cwd: opts.cwd,
      task: opts.task,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      config: opts.config,
    };
    await fs.writeFile(path.join(this.dir, `${id}.json`), JSON.stringify({ record, messages: [], observations: [] }, null, 2));
    const idx = await this.readIndex();
    idx[id] = record;
    await this.writeIndex(idx);
    return record;
  }

  private async readSession(id: string): Promise<{ record: SessionRecord; messages: StoredMessage[]; observations: StoredObservation[] }> {
    const raw = await fs.readFile(path.join(this.dir, `${id}.json`), 'utf-8');
    return JSON.parse(raw);
  }

  private async writeSession(id: string, data: { record: SessionRecord; messages: StoredMessage[]; observations: StoredObservation[] }): Promise<void> {
    data.record.updatedAt = Date.now();
    const target = path.join(this.dir, `${id}.json`);
    const tmp = `${target}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    try {
      const fh = await fs.open(tmp, 'r+');
      try { await fh.sync(); } finally { await fh.close(); }
    } catch { /* ignore */ }
    try {
      await fs.rename(tmp, target);
    } catch {
      await fs.unlink(tmp).catch(() => undefined);
      throw new Error(`Failed to write session ${id}`);
    }
    // Update index with simple retry for concurrent writers (optimistic)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const idx = await this.readIndex();
        idx[id] = data.record;
        await this.writeIndex(idx);
        return;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
      }
    }
  }

  async appendMessage(id: string, message: StoredMessage): Promise<void> {
    const data = await this.readSession(id);
    data.messages.push(message);
    await this.writeSession(id, data);
  }

  async appendObservation(id: string, obs: StoredObservation): Promise<void> {
    const data = await this.readSession(id);
    data.observations.push(obs);
    await this.writeSession(id, data);
  }

  async setStatus(id: string, status: SessionStatus, finalText?: string): Promise<void> {
    const data = await this.readSession(id);
    data.record.status = status;
    if (finalText !== undefined) data.record.finalText = finalText;
    await this.writeSession(id, data);
  }

  async loadMessages(id: string): Promise<StoredMessage[]> {
    const data = await this.readSession(id);
    return data.messages;
  }

  async loadObservations(id: string): Promise<StoredObservation[]> {
    const data = await this.readSession(id);
    return data.observations;
  }

  async list(filter?: { status?: SessionStatus }): Promise<SessionRecord[]> {
    const idx = await this.readIndex();
    const all = Object.values(idx);
    return filter?.status ? all.filter((s) => s.status === filter.status) : all;
  }

  async get(id: string): Promise<SessionRecord | null> {
    const idx = await this.readIndex();
    return idx[id] ?? null;
  }

  /** Atomic append — survives crashes; suitable for audit log. */
  static async appendJsonl(filePath: string, entry: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }
}
