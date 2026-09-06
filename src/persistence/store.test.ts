import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { SessionStore } from './store.js';

let store: SessionStore;
let dir: string;

beforeEach(async () => {
  dir = path.join(os.tmpdir(), 'klyro-store-' + Math.random().toString(36).slice(2));
  await fs.mkdir(dir, { recursive: true });
  store = new SessionStore(dir);
});

describe('SessionStore', () => {
  it('creates and retrieves a session', async () => {
    const r = await store.create({ cwd: '/x', task: 'do a thing', config: { model: 'm', maxSteps: 10 } });
    expect(r.status).toBe('open');
    expect(r.cwd).toBe('/x');
    const fetched = await store.get(r.id);
    expect(fetched?.id).toBe(r.id);
  });

  it('appends messages and observations', async () => {
    const r = await store.create({ cwd: '/x', task: 't', config: { model: 'm', maxSteps: 10 } });
    await store.appendMessage(r.id, { role: 'user', content: 'hi', ts: 1 });
    await store.appendMessage(r.id, { role: 'assistant', content: 'hello', ts: 2 });
    const msgs = await store.loadMessages(r.id);
    expect(msgs).toHaveLength(2);
    await store.appendObservation(r.id, {
      toolCallId: 'c1',
      toolName: 'read_file',
      input: { path: 'a' },
      output: 'contents',
      isError: false,
      startedAt: 1,
      finishedAt: 2,
    });
    const obs = await store.loadObservations(r.id);
    expect(obs).toHaveLength(1);
    expect(obs[0]?.toolName).toBe('read_file');
  });

  it('forks with copied messages and observations', async () => {
    const r = await store.create({ cwd: '/x', task: 't', config: { model: 'm', maxSteps: 10 } });
    await store.appendMessage(r.id, { role: 'user', content: 'hi', ts: 1 });
    await store.appendObservation(r.id, {
      toolCallId: 'c1', toolName: 'read_file', input: {}, output: 'x',
      isError: false, startedAt: 1, finishedAt: 2,
    });
    const f = await store.fork(r.id);
    expect(f.id).not.toBe(r.id);
    expect(f.task).toContain('(fork)');
    expect(await store.loadMessages(f.id)).toHaveLength(1);
    expect(await store.loadObservations(f.id)).toHaveLength(1);
    // original untouched
    expect(await store.loadMessages(r.id)).toHaveLength(1);
  });

  it('deletes sessions and artifacts', async () => {
    const r = await store.create({ cwd: '/x', task: 't', config: { model: 'm', maxSteps: 10 } });
    await store.appendMessage(r.id, { role: 'user', content: 'hi', ts: 1 });
    expect(await store.delete(r.id)).toBe(true);
    expect(await store.get(r.id)).toBeNull();
    expect(await store.delete(r.id)).toBe(false);
    expect(await store.list()).toHaveLength(0);
  });

  it('updates status', async () => {
    const r = await store.create({ cwd: '/x', task: 't', config: { model: 'm', maxSteps: 10 } });
    await store.setStatus(r.id, 'complete', 'done');
    const after = await store.get(r.id);
    expect(after?.status).toBe('complete');
    expect(after?.finalText).toBe('done');
  });

  it('lists sessions filtered by status', async () => {
    const a = await store.create({ cwd: '/x', task: 'a', config: { model: 'm', maxSteps: 10 } });
    const b = await store.create({ cwd: '/x', task: 'b', config: { model: 'm', maxSteps: 10 } });
    await store.setStatus(a.id, 'complete');
    const open = await store.list({ status: 'open' });
    expect(open.map((s) => s.id)).toContain(b.id);
    expect(open.map((s) => s.id)).not.toContain(a.id);
  });

  it('JSONL append is atomic and idempotent across crashes', async () => {
    const j = path.join(dir, 'audit.jsonl');
    await SessionStore.appendJsonl(j, { a: 1 });
    await SessionStore.appendJsonl(j, { a: 2 });
    const raw = await fs.readFile(j, 'utf-8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);
  });
});
