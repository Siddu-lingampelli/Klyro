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
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from '../policy/secret-redactor.js';

export type SessionStatus = 'open' | 'complete' | 'verify_failed' | 'aborted' | 'max_steps' | 'stuck';

/** Persisted session schema version. Bump when SessionRecord changes shape;
 * readers migrate older records forward (missing version ⇒ v0). */
export const SESSION_SCHEMA_VERSION = 1;

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
  /** Schema version for migrations; absent on pre-v1 records (treated as v0). */
  schemaVersion?: number;
}

/** Migrate a persisted record forward. Unknown future versions pass through
 * untouched so a newer CLI's sessions stay readable (forward-compatible). */
export function migrateSessionRecord(raw: SessionRecord): SessionRecord {
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  if (version >= SESSION_SCHEMA_VERSION) return raw;
  return { ...raw, schemaVersion: SESSION_SCHEMA_VERSION };
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
  private readonly locks = new Map<string, Promise<void>>();

  constructor(dir: string) {
    this.dir = dir;
    this.indexPath = path.join(dir, 'sessions.json');
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((r) => { release = r; });
    this.locks.set(key, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release!();
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
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

  private projectHash(cwd: string): string {
    let h = 0; for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  }
  private perProjectIndexPath(cwd: string): string { return path.join(this.dir, `index-${this.projectHash(cwd)}.json`); }

  /** Atomic per-project index write (tmp + fsync + rename). */
  private async writePerProjectIndex(pp: string, pIdx: Record<string, SessionRecord>): Promise<void> {
    const tmp = `${pp}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await fs.writeFile(tmp, JSON.stringify(pIdx, null, 2), 'utf-8');
    try {
      const fh = await fs.open(tmp, 'r+');
      try { await fh.sync(); } finally { await fh.close(); }
    } catch { /* ignore on Windows */ }
    try {
      await fs.rename(tmp, pp);
    } catch {
      await fs.unlink(tmp).catch(() => undefined);
      throw new Error('Failed to write per-project sessions index');
    }
  }

  private titleFor(task: string): string {
    // heuristic title via first 6 words, or model.small would be used if available
    const w = task.trim().split(/\s+/).slice(0, 6).join(' ');
    return w.length > 40 ? w.slice(0, 40) + '…' : w || 'untitled';
  }

  async create(opts: { cwd: string; task: string; config: SessionConfig }): Promise<SessionRecord> {
    // Locked: the index read-modify-write below races under concurrent creates.
    return this.withLock('index', async () => {
      await this.ensureDir();
      // Redact at the persist boundary — tasks routinely paste keys/tokens.
      const task = redact(opts.task);
      let id = randomUUID();
      // Cross-process session lock: O_EXCL so a concurrent creator (another
      // process resuming/creating the same id path) can detect contention.
      // On collision fall back to a unique id suffix — never crash.
      try {
        await fs.writeFile(path.join(this.dir, `${id}.lock`), String(process.pid), { flag: 'wx' });
      } catch {
        id = `${id}-${process.pid}-${Date.now().toString(36)}`;
        try {
          await fs.writeFile(path.join(this.dir, `${id}.lock`), String(process.pid), { flag: 'wx' });
        } catch { /* best-effort only */ }
      }
      const now = Date.now();
      const record: SessionRecord = {
        id,
        cwd: opts.cwd,
        task,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        config: opts.config,
        schemaVersion: SESSION_SCHEMA_VERSION,
      };
      (record as unknown as Record<string, unknown>).title = this.titleFor(task);
      // Atomic session create (tmp + fsync + rename) so a crash can never
      // leave a truncated `${id}.json` that resume/import then trusts.
      const target = path.join(this.dir, `${id}.json`);
      const tmpCreate = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      await fs.writeFile(tmpCreate, JSON.stringify({ record, messages: [], observations: [] }, null, 2));
      try {
        const fh = await fs.open(tmpCreate, 'r+');
        try { await fh.sync(); } finally { await fh.close(); }
      } catch { /* ignore on Windows */ }
      try {
        await fs.rename(tmpCreate, target);
      } catch {
        await fs.unlink(tmpCreate).catch(() => undefined);
        throw new Error(`Failed to write session ${id}`);
      }
      await this.appendJsonl(id, { type: 'session.create', record, ts: now });
      const idx = await this.readIndex();
      idx[id] = record;
      await this.writeIndex(idx);
      // per-project index (atomic)
      try {
        const pp = this.perProjectIndexPath(opts.cwd);
        let pIdx: Record<string, SessionRecord> = {};
        try { pIdx = JSON.parse(await fs.readFile(pp, 'utf-8')); } catch {}
        pIdx[id] = record;
        await this.writePerProjectIndex(pp, pIdx);
      } catch {}
      return record;
    });
  }

  /**
   * Fork a session: new id + copied messages/observations so the fork
   * continues with full context instead of starting blank.
   */
  async fork(id: string, taskSuffix = ' (fork)'): Promise<SessionRecord> {
    const data = await this.readSession(id);
    const forked = await this.create({
      cwd: data.record.cwd,
      task: `${data.record.task}${taskSuffix}`,
      config: data.record.config,
    });
    await this.withLock(forked.id, async () => {
      const fresh = await this.readSession(forked.id);
      fresh.messages = data.messages.map((m) => ({ ...m }));
      fresh.observations = data.observations.map((o) => ({ ...o }));
      await this.writeSession(forked.id, fresh);
    });
    await this.appendJsonl(forked.id, { type: 'session.fork', from: id, ts: Date.now() });
    return forked;
  }

  /** Delete a session and all its artifacts (record, transcript, jsonl, lock, indexes). */
  async delete(id: string): Promise<boolean> {
    return this.withLock('index', async () => {
      const rec = await this.get(id);
      if (!rec) return false;
      for (const f of [`${id}.json`, `${id}.jsonl`, `${id}.lock`]) {
        try {
          await fs.unlink(path.join(this.dir, f));
        } catch { /* ignore */ }
      }
      const idx = await this.readIndex();
      delete idx[id];
      await this.writeIndex(idx);
      try {
        const pp = this.perProjectIndexPath(rec.cwd);
        const raw = await fs.readFile(pp, 'utf-8');
        const pIdx = JSON.parse(raw) as Record<string, SessionRecord>;
        delete pIdx[id];
        await this.writePerProjectIndex(pp, pIdx);
      } catch { /* ignore */ }
      return true;
    });
  }

  private jsonlPath(id: string): string { return path.join(this.dir, `${id}.jsonl`); }
  async appendJsonl(id: string, entry: unknown): Promise<void> {
    const p = this.jsonlPath(id);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    // append + fsync for tool results
    const fh = await fs.open(p, 'a');
    try { await fh.write(line); await fh.sync(); } finally { await fh.close(); }
  }
  async readJsonl(id: string): Promise<unknown[]> {
    try {
      const raw = await fs.readFile(this.jsonlPath(id), 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim());
      const out: unknown[] = [];
      for (const line of lines) {
        try { out.push(JSON.parse(line)); } catch {
          // truncated last line tolerated — skip
          continue;
        }
      }
      return out;
    } catch { return []; }
  }

  private async readSession(id: string): Promise<{ record: SessionRecord; messages: StoredMessage[]; observations: StoredObservation[] }> {
    const raw = await fs.readFile(path.join(this.dir, `${id}.json`), 'utf-8');
    const parsed = JSON.parse(raw) as { record: SessionRecord; messages: StoredMessage[]; observations: StoredObservation[] };
    parsed.record = migrateSessionRecord(parsed.record);
    return parsed;
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
    return this.withLock(id, async () => {
      const data = await this.readSession(id);
      data.messages.push({ ...message, content: redactStoredContent(message.content) });
      await this.writeSession(id, data);
    });
  }

  async appendObservation(id: string, obs: StoredObservation): Promise<void> {
    return this.withLock(id, async () => {
      const data = await this.readSession(id);
      // S4-at-rest: redact observation input/output at the persist boundary.
      data.observations.push({
        ...obs,
        input: redactStoredContent(obs.input),
        output: redactStoredContent(obs.output),
      });
      await this.writeSession(id, data);
    });
  }

  async setStatus(id: string, status: SessionStatus, finalText?: string): Promise<void> {
    return this.withLock(id, async () => {
      const data = await this.readSession(id);
      data.record.status = status;
      // S4-at-rest: redact finalText before persisting.
      if (finalText !== undefined) data.record.finalText = redact(finalText);
      await this.writeSession(id, data);
      // Terminal states release the cross-process lock (no destructor exists
      // to do it — the session is done, so the lock is stale by definition).
      if (status === 'complete' || status === 'aborted' || status === 'max_steps' ||
          status === 'verify_failed' || status === 'stuck') {
        await releaseSessionLock(this.dir, id);
      }
    });
  }

  async loadMessages(id: string): Promise<StoredMessage[]> {
    const data = await this.readSession(id);
    return data.messages;
  }

  /**
   * Conversation rewind: drop messages (and observations) at or after
   * `cutoffTs`, keeping everything older. Returns the removed counts.
   * Used by `/rewind <n> full` to restore the conversation alongside code.
   */
  async truncateMessages(id: string, cutoffTs: number): Promise<{ messages: number; observations: number }> {
    return this.withLock(id, async () => {
      const data = await this.readSession(id);
      const keptMessages = data.messages.filter((m) => (typeof m.ts === 'number' ? m.ts : 0) < cutoffTs);
      const keptObs = data.observations.filter((o) => (typeof o.startedAt === 'number' ? o.startedAt : 0) < cutoffTs);
      const removed = { messages: data.messages.length - keptMessages.length, observations: data.observations.length - keptObs.length };
      data.messages = keptMessages;
      data.observations = keptObs;
      await this.writeSession(id, data);
      return removed;
    });
  }

  async loadObservations(id: string): Promise<StoredObservation[]> {
    const data = await this.readSession(id);
    return data.observations;
  }

  async list(filter?: { status?: SessionStatus }): Promise<SessionRecord[]> {
    const idx = await this.readIndex();
    const all = Object.values(idx).map(migrateSessionRecord);
    return filter?.status ? all.filter((s) => s.status === filter.status) : all;
  }

  async get(id: string): Promise<SessionRecord | null> {
    const idx = await this.readIndex();
    const rec = idx[id];
    return rec ? migrateSessionRecord(rec) : null;
  }

  /** Atomic append + fsync — survives crashes; suitable for audit log. */
  static async appendJsonl(filePath: string, entry: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const fh = await fs.open(filePath, 'a');
    try { await fh.write(JSON.stringify(entry) + '\n'); await fh.sync(); } finally { await fh.close(); }
  }
}

/**
 * Redact text blocks of a stored message at the persist boundary.
 * Handles string content, `{ text }` blocks, arrays of blocks, and plain
 * objects (observation input/output) via a deep walk over string leaves.
 * Only secret-shaped strings (key/token/password patterns, [:=-] shapes)
 * are touched — normal prose passes through unchanged.
 */
export function redactStoredContent(content: unknown): unknown {
  if (typeof content === 'string') return redact(content);
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string') {
        return { ...(b as Record<string, unknown>), text: redact((b as Record<string, unknown>).text as string) };
      }
      if (typeof b === 'string') return redact(b);
      if (b && typeof b === 'object') return redactStoredContent(b);
      return b;
    });
  }
  if (content && typeof content === 'object') {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === 'string') {
      return { ...rec, text: redact(rec.text) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      out[k] = typeof v === 'string' ? redact(v) : (v && typeof v === 'object' ? redactStoredContent(v) : v);
    }
    return out;
  }
  return content;
}

export interface SessionLockInfo {
  held: boolean;
  pid?: number;
  /** True when the lock holder process is (probably) still running. */
  alive?: boolean;
}

/**
 * Cross-process session lock probe. The lock file `<sessionsDir>/<id>.lock`
 * contains the holder's PID. `alive` is resolved via `process.kill(pid, 0)`:
 * EPERM means alive-but-unpermitted (→ true); ESRCH / other errors → false.
 */
export function readSessionLock(sessionsDir: string, id: string): SessionLockInfo {
  let raw: string;
  try {
    raw = fsSync.readFileSync(path.join(sessionsDir, `${id}.lock`), 'utf-8');
  } catch {
    return { held: false };
  }
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) return { held: true };
  let alive: boolean;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    alive = code === 'EPERM';
  }
  return { held: true, pid, alive };
}

/** Best-effort release of the cross-process session lock. Never throws. */
export async function releaseSessionLock(sessionsDir: string, id: string): Promise<void> {
  try {
    await fs.unlink(path.join(sessionsDir, `${id}.lock`));
  } catch { /* ignore */ }
}
