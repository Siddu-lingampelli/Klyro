import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { AuditLog, verifyAuditChain, canonicalJson, hashAuditRecord } from './audit.js';

let dir: string;

beforeEach(async () => {
  dir = path.join(os.tmpdir(), 'klyro-audit-' + Math.random().toString(36).slice(2));
  await fs.mkdir(dir, { recursive: true });
});

describe('AuditLog hash chain', () => {
  it('chains writes and verifies ok', async () => {
    const log = new AuditLog(path.join(dir, 's1.jsonl'));
    await log.write({ kind: 'session_created', sessionId: 's1', task: 't', cwd: '/x', ts: 1 });
    await log.write({ kind: 'step_started', sessionId: 's1', step: 1, ts: 2 });
    const res = await verifyAuditChain(dir, 's1');
    expect(res).toEqual({ ok: true, events: 2 });
  });

  it('first record uses GENESIS prevHash', async () => {
    const log = new AuditLog(path.join(dir, 's1.jsonl'));
    await log.write({ kind: 'session_created', sessionId: 's1', task: 't', cwd: '/x', ts: 1 });
    const raw = await fs.readFile(path.join(dir, 's1.jsonl'), 'utf-8');
    const rec = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(rec.prevHash).toBe('GENESIS');
    expect(rec.hash).toBe(hashAuditRecord(rec));
  });

  it('concurrent writes stay chained (serialized queue)', async () => {
    const log = new AuditLog(path.join(dir, 's1.jsonl'));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        log.write({ kind: 'step_started', sessionId: 's1', step: i, ts: i }),
      ),
    );
    const res = await verifyAuditChain(dir, 's1');
    expect(res).toEqual({ ok: true, events: 10 });
  });

  it('detects tampering', async () => {
    const log = new AuditLog(path.join(dir, 's1.jsonl'));
    await log.write({ kind: 'session_created', sessionId: 's1', task: 't', cwd: '/x', ts: 1 });
    await log.write({ kind: 'step_started', sessionId: 's1', step: 1, ts: 2 });
    const p = path.join(dir, 's1.jsonl');
    const lines = (await fs.readFile(p, 'utf-8')).split('\n').filter(Boolean);
    const tampered = { ...(JSON.parse(lines[1]!) as Record<string, unknown>), step: 999 };
    lines[1] = JSON.stringify(tampered);
    await fs.writeFile(p, lines.join('\n') + '\n', 'utf-8');
    const res = await verifyAuditChain(dir, 's1');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/hash mismatch/);
  });

  it('detects truncation (prevHash mismatch)', async () => {
    const log = new AuditLog(path.join(dir, 's1.jsonl'));
    await log.write({ kind: 'session_created', sessionId: 's1', task: 't', cwd: '/x', ts: 1 });
    await log.write({ kind: 'step_started', sessionId: 's1', step: 1, ts: 2 });
    await log.write({ kind: 'step_completed', sessionId: 's1', step: 1, ts: 3 });
    const p = path.join(dir, 's1.jsonl');
    const lines = (await fs.readFile(p, 'utf-8')).split('\n').filter(Boolean);
    await fs.writeFile(p, [lines[0], lines[2]].join('\n') + '\n', 'utf-8');
    const res = await verifyAuditChain(dir, 's1');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/prevHash mismatch/);
  });

  it('missing file returns ok:false with error', async () => {
    const res = await verifyAuditChain(dir, 'nope');
    expect(res.ok).toBe(false);
    expect(res.events).toBe(0);
    expect(res.error).toBeDefined();
  });

  it('canonicalJson is key-order stable', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});
