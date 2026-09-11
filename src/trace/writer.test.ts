import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { TraceWriter } from './writer.js';

let dir: string;

beforeEach(async () => {
  dir = path.join(os.tmpdir(), 'klyro-trace-' + Math.random().toString(36).slice(2));
  await fs.mkdir(dir, { recursive: true });
});

describe('TraceWriter', () => {
  it('concurrent writes stay line-valid with unique seqs', async () => {
    const w = new TraceWriter('s1', dir);
    await w.init();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        w.write({ type: 'stream.delta', ts: i, sessionId: 's1', text: `msg-${i}` }),
      ),
    );
    await w.close();
    const raw = await fs.readFile(path.join(dir, 's1.jsonl'), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(20);
    const seqs = new Set<number>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { seq?: unknown };
      expect(typeof parsed.seq).toBe('number');
      seqs.add(parsed.seq as number);
    }
    expect(seqs.size).toBe(20);
    const events = await w.readAll();
    expect(events).toHaveLength(20);
  });

  it('redacts secrets before append', async () => {
    const w = new TraceWriter('s2', dir);
    await w.init();
    const secret = 'sk-ant-abcdefghij1234567890XY';
    await w.write({ type: 'stream.delta', ts: 1, sessionId: 's2', text: `key ${secret} leaked` });
    const raw = await fs.readFile(path.join(dir, 's2.jsonl'), 'utf-8');
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[REDACTED]');
  });

  it('readAll skips corrupt lines instead of discarding the trace', async () => {
    const w = new TraceWriter('s3', dir);
    await w.init();
    await w.write({ type: 'stream.delta', ts: 1, sessionId: 's3', text: 'first' });
    await fs.appendFile(path.join(dir, 's3.jsonl'), '{not valid json\n', 'utf-8');
    await w.write({ type: 'stream.delta', ts: 2, sessionId: 's3', text: 'second' });
    const events = await w.readAll();
    expect(events).toHaveLength(2);
    expect((events[0] as { text?: string }).text).toBe('first');
    expect((events[1] as { text?: string }).text).toBe('second');
  });

  it('seq continues across writer instances (restart-safe)', async () => {
    const a = new TraceWriter('s4', dir);
    await a.init();
    await a.write({ type: 'stream.delta', ts: 1, sessionId: 's4', text: 'one' });
    const b = new TraceWriter('s4', dir);
    await b.init();
    await b.write({ type: 'stream.delta', ts: 2, sessionId: 's4', text: 'two' });
    const events = await b.readAll();
    const seqs = events.map((e) => (e as unknown as { seq: number }).seq);
    expect(seqs).toEqual([0, 1]);
  });
});
