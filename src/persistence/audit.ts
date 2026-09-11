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

export class AuditLog {
  /** Serializes chained appends so concurrent writes can't fork the chain. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async write(event: AuditEvent): Promise<void> {
    const task = this.chain.then(() => this.appendChained(event));
    // Keep the chain alive across failures; the caller still sees its error.
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async appendChained(event: AuditEvent): Promise<void> {
    const prevHash = await prevHashFor(this.filePath);
    const body: Record<string, unknown> = { ...(event as unknown as Record<string, unknown>), prevHash };
    const record: ChainedAuditRecord = { ...body, prevHash, hash: sha256Hex(canonicalJson(body)) };
    await SessionStore.appendJsonl(this.filePath, record);
  }
}

/**
 * Recompute the hash chain of a session JSONL file.
 * Sessions live at `<sessionsDir>/<sessionId>.jsonl` (see SessionStore).
 */
export async function verifyAuditChain(
  sessionsDir: string,
  sessionId: string,
): Promise<{ ok: boolean; events: number; error?: string }> {
  const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return { ok: false, events: 0, error: `audit log not found: ${filePath}` };
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
      return { ok: false, events, error: `line ${i + 1}: unparseable JSON` };
    }
    if (parsed.prevHash !== expectedPrev) {
      return { ok: false, events, error: `line ${i + 1}: prevHash mismatch (chain fork or truncation)` };
    }
    if (typeof parsed.hash !== 'string' || parsed.hash !== hashAuditRecord(parsed)) {
      return { ok: false, events, error: `line ${i + 1}: hash mismatch (tampered record)` };
    }
    expectedPrev = parsed.hash;
    events++;
  }
  return { ok: true, events };
}
