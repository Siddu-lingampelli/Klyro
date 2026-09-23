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

  it('rejects lines with prototype-pollution keys before trusting fields', async () => {
    const log = new AuditLog(path.join(dir, 's1.jsonl'));
    await log.write({ kind: 'session_created', sessionId: 's1', task: 't', cwd: '/x', ts: 1 });
    const p = path.join(dir, 's1.jsonl');
    const lines = (await fs.readFile(p, 'utf-8')).split('\n').filter(Boolean);
    // defineProperty (not assignment) so __proto__ becomes a real own key
    // in the tampered line, exactly like a hostile file would carry it.
    const evil = { ...(JSON.parse(lines[0]!) as Record<string, unknown>) };
    Object.defineProperty(evil, '__proto__', { value: { polluted: true }, enumerable: true, configurable: true, writable: true });
    lines.push(JSON.stringify(evil));
    await fs.writeFile(p, lines.join('\n') + '\n', 'utf-8');
    const res = await verifyAuditChain(dir, 's1');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/dangerous keys/);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
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

  it('in-memory tip cache: chains after external change via reload', async () => {
    const p = path.join(dir, 's2.jsonl');
    const a = new AuditLog(p);
    await a.write({ kind: 'session_created', sessionId: 's2', task: 't', cwd: '/x', ts: 1 });
    await a.write({ kind: 'step_started', sessionId: 's2', step: 1, ts: 2 });
    // A fresh instance picks up the existing chain tip (file-backed read),
    // then chains in-memory from there.
    const b = new AuditLog(p);
    await b.write({ kind: 'step_completed', sessionId: 's2', step: 1, ts: 3 });
    const res = await verifyAuditChain(dir, 's2');
    expect(res).toEqual({ ok: true, events: 3 });
  });

  it('rotation bounds live file under maxBytes and segments verify', async () => {
    const p = path.join(dir, 's3.jsonl');
    // keep=10 so no record is evicted across the 40 writes: the count then
    // equals the full write set (eviction only kicks in past keep segments).
    const log = new AuditLog(p, /*maxBytes*/ 1024, /*keep*/ 10);
    // Force enough writes to trigger at least one rotation.
    for (let i = 0; i < 40; i++) {
      await log.write({ kind: 'step_started', sessionId: 's3', step: i, ts: i });
    }
    const stat = await fs.stat(p);
    expect(stat.size).toBeLessThanOrEqual(4096); // bounded live segment
    const seg1 = await fs.stat(p + '.1').catch(() => null);
    expect(seg1).not.toBeNull(); // at least one rotation happened
    const res = await verifyAuditChain(dir, 's3', 10);
    expect(res.ok).toBe(true);
    expect(res.events).toBeGreaterThan(30);
    // Tampering a rotated segment is also detected.
    const segLines = (await fs.readFile(p + '.1', 'utf-8')).split('\n').filter(Boolean);
    const bad = { ...(JSON.parse(segLines[0]!) as Record<string, unknown>), step: 9999 };
    segLines[0] = JSON.stringify(bad);
    await fs.writeFile(p + '.1', segLines.join('\n') + '\n', 'utf-8');
    const res2 = await verifyAuditChain(dir, 's3', 10);
    expect(res2.ok).toBe(false);
    expect(res2.error).toMatch(/s3\.jsonl\.1/);
  });
});
