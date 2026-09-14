/**
 * Audit log — append-only JSONL of runtime events. Same shape as the
 * future durable-task scheduler will read, so the data layout is
 * forward-compatible.
 *
 * Durability: every record is hash-chained. Each line carries `prevHash`
 * (hex sha256 of the previous line's canonical JSON, 'GENESIS' for the
 * first line) and `hash` (sha256 of the record-with-prevHash canonical
 * JSON). `verifyAuditChain` recomputes the chain for `klyro audit`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SessionStore } from './store.js';

export type AuditEvent =
  | { kind: 'session_created'; sessionId: string; task: string; cwd: string; ts: number }
  | { kind: 'session_resumed'; sessionId: string; ts: number }
  | { kind: 'session_completed'; sessionId: string; status: string; ts: number }
  | { kind: 'step_started'; sessionId: string; step: number; ts: number }
  | { kind: 'step_completed'; sessionId: string; step: number; ts: number }
  | { kind: 'tool_call_started'; sessionId: string; callId: string; name: string; ts: number }
  | { kind: 'tool_call_completed'; sessionId: string; callId: string; isError: boolean; latencyMs: number; ts: number }
  | { kind: 'policy_decision'; sessionId: string; callId: string; action: string; ts: number }
  | { kind: 'verification_attempted'; sessionId: string; command: string; ts: number }
  | { kind: 'verification_succeeded'; sessionId: string; ts: number }
  | { kind: 'verification_failed'; sessionId: string; exitCode: number; type: string; ts: number }
  | { kind: 'repair_attempted'; sessionId: string; attempt: number; ts: number };

export const AUDIT_GENESIS = 'GENESIS';

export interface ChainedAuditRecord {
  prevHash: string;
  hash: string;
  [key: string]: unknown;
}

/** Canonical JSON: object keys sorted recursively, so hashes are stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(',')}}`;
}

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

/** Hash of a chained record excluding its own `hash` field. */
export function hashAuditRecord(record: Record<string, unknown>): string {
  const { hash: _omit, ...body } = record;
  void _omit;
  return sha256Hex(canonicalJson(body));
}

async function readLastLine(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    return lines.length > 0 ? lines[lines.length - 1]! : null;
  } catch {
    return null;
  }
}

/** prevHash for the next record: hash of the previous line, or GENESIS. */
async function prevHashFor(filePath: string): Promise<string> {
  const last = await readLastLine(filePath);
  if (!last) return AUDIT_GENESIS;
  try {
    const parsed = JSON.parse(last) as Record<string, unknown>;
    if (typeof parsed.hash === 'string' && parsed.hash) return parsed.hash;
    return sha256Hex(canonicalJson(parsed));
  } catch {
    return sha256Hex(last);
  }
}

/** Default rotation bound: 1 MiB live segment, 5 rotated segments kept. */
export const AUDIT_MAX_BYTES = 1_048_576;
export const AUDIT_ROTATE_KEEP = 5;

/**
 * Rotate an audit log once it exceeds `maxBytes`: shift the newest segment
 * over the oldest (deleted), leave a fresh live file. Each segment carries
 * its own GENESIS-rooted chain, so rotation is tamper-evident per segment.
 * Returns true when a rotation actually happened (the caller must reset its
 * in-memory chain tip to GENESIS — the next live record starts a fresh
 * chain). Best-effort — rotation failures never break appends.
 */
async function rotateAuditLog(filePath: string, maxBytes: number, keep: number): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size <= maxBytes) return false;
    try { await fs.rm(`${filePath}.${keep}`, { force: true }); } catch { /* best-effort */ }
    for (let i = keep - 1; i >= 1; i--) {
      try { await fs.rename(`${filePath}.${i}`, `${filePath}.${i + 1}`); } catch { /* missing segment */ }
    }
    await fs.rename(filePath, `${filePath}.1`);
    return true;
  } catch {
    /* stat failure (no file yet) — nothing to rotate */
    return false;
  }
}

export class AuditLog {
  /** Serializes chained appends so concurrent writes can't fork the chain. */
  private chain: Promise<void> = Promise.resolve();
  /**
   * Cached last-written hash: avoids re-reading the whole file (O(n) per
   * write) on every append. Null = not loaded yet — first append reads the
   * file (picks up an existing chain), then the cache takes over.
   */
  private lastHash: string | null = null;

  constructor(
    private readonly filePath: string,
    private readonly maxBytes: number = AUDIT_MAX_BYTES,
    private readonly keepSegments: number = AUDIT_ROTATE_KEEP,
  ) {}

  async write(event: AuditEvent): Promise<void> {
    const task = this.chain.then(() => this.appendChained(event));
    // Keep the chain alive across failures; the caller still sees its error.
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async appendChained(event: AuditEvent): Promise<void> {
    // Rotation leaves a fresh live file and resets the in-memory tip: the
    // next live record restarts at GENESIS (each segment is its own chain).
    const rotated = await rotateAuditLog(this.filePath, this.maxBytes, this.keepSegments);
    if (rotated) this.lastHash = AUDIT_GENESIS;
    if (this.lastHash === null) this.lastHash = await prevHashFor(this.filePath);
    const prevHash = this.lastHash;
    const body: Record<string, unknown> = { ...(event as unknown as Record<string, unknown>), prevHash };
    const record: ChainedAuditRecord = { ...body, prevHash, hash: sha256Hex(canonicalJson(body)) };
    this.lastHash = record.hash;
    await SessionStore.appendJsonl(this.filePath, record);
  }
}

/** Recompute one segment's chain; returns verified lines or a numbered error. */
async function verifySegment(filePath: string, segmentLabel: string): Promise<{ events: number; error?: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return { events: 0, error: `${segmentLabel}: not found` };
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  let expectedPrev = AUDIT_GENESIS;
  let events = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { events, error: `${segmentLabel}:${i + 1}: unparseable JSON` };
    }
    if (parsed.prevHash !== expectedPrev) {
      return { events, error: `${segmentLabel}:${i + 1}: prevHash mismatch (chain fork or truncation)` };
    }
    if (typeof parsed.hash !== 'string' || parsed.hash !== hashAuditRecord(parsed)) {
      return { events, error: `${segmentLabel}:${i + 1}: hash mismatch (tampered record)` };
    }
    expectedPrev = parsed.hash;
    events++;
  }
  return { events };
}

/**
 * Recompute the hash chain of a session JSONL file, including rotated
 * segments (`.jsonl.1` … `.jsonl.keep` each verified as its own chain).
 * Sessions live at `<sessionsDir>/<sessionId>.jsonl` (see SessionStore).
 */
export async function verifyAuditChain(
  sessionsDir: string,
  sessionId: string,
  keepSegments: number = AUDIT_ROTATE_KEEP,
): Promise<{ ok: boolean; events: number; error?: string }> {
  let totalEvents = 0;
  for (let i = keepSegments; i >= 1; i--) {
    const label = `${sessionId}.jsonl.${i}`;
    const seg = await verifySegment(path.join(sessionsDir, label), label);
    if (seg.error) {
      if (seg.error.endsWith(': not found')) continue; // missing rotated segment is fine
      return { ok: false, events: totalEvents, error: seg.error };
    }
    totalEvents += seg.events;
  }
  const live = await verifySegment(path.join(sessionsDir, `${sessionId}.jsonl`), `${sessionId}.jsonl`);
  if (live.error) return { ok: false, events: totalEvents, error: live.error };
  totalEvents += live.events;
  return { ok: true, events: totalEvents };
}
