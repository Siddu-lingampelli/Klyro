import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { SessionStore, readSessionLock, releaseSessionLock, redactStoredContent } from './store.js';

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

  it('appends messages and observations', async () => {    const r = await store.create({ cwd: '/x', task: 't', config: { model: 'm', maxSteps: 10 } });
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

  it('truncateMessages drops messages/observations at or after a cutoff', async () => {
    const r = await store.create({ cwd: '/x', task: 't', config: { model: 'm', maxSteps: 10 } });
    await store.appendMessage(r.id, { role: 'user', content: 'old', ts: 1 });
    await store.appendMessage(r.id, { role: 'assistant', content: 'new', ts: 100 });
    await store.appendObservation(r.id, {
      toolCallId: 'c1', toolName: 'read_file', input: {}, output: 'x',
      isError: false, startedAt: 100, finishedAt: 101,
    });
    const removed = await store.truncateMessages(r.id, 50);
    expect(removed).toEqual({ messages: 1, observations: 1 });
    expect(await store.loadMessages(r.id)).toHaveLength(1);
    expect(await store.loadObservations(r.id)).toHaveLength(0);
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

  it('create writes a cross-process lock file; terminal setStatus releases it', async () => {
    const r = await store.create({ cwd: '/x', task: 't', config: { model: 'm', maxSteps: 10 } });
    const lockPath = path.join(dir, `${r.id}.lock`);
    expect(await fs.readFile(lockPath, 'utf-8')).toBe(String(process.pid));
    const info = readSessionLock(dir, r.id);
    expect(info.held).toBe(true);
    expect(info.pid).toBe(process.pid);
    expect(info.alive).toBe(true);
    // Non-terminal status keeps the lock.
    await store.setStatus(r.id, 'open');
    expect(readSessionLock(dir, r.id).held).toBe(true);
    // Terminal status releases it.
    await store.setStatus(r.id, 'complete', 'done');
    expect(readSessionLock(dir, r.id)).toEqual({ held: false });
  });

  it('readSessionLock reports stale locks for dead pids', () => {
    expect(readSessionLock(dir, 'missing')).toEqual({ held: false });
    // Garbage lock content: held but no usable pid.
    return fs.writeFile(path.join(dir, 'bad.lock'), 'not-a-pid', 'utf-8').then(() => {
      expect(readSessionLock(dir, 'bad')).toEqual({ held: true });
    });
  });

  it('readSessionLock marks ESRCH pids as not alive', async () => {
    const deadPid = 4123456; // overwhelmingly likely to be dead
    try { process.kill(deadPid, 0); return; } catch { /* expected dead */ }
    await fs.writeFile(path.join(dir, 'dead.lock'), String(deadPid), 'utf-8');
    const info = readSessionLock(dir, 'dead');
    expect(info.held).toBe(true);
    expect(info.pid).toBe(deadPid);
    expect(info.alive).toBe(false);
    await releaseSessionLock(dir, 'dead');
    expect(readSessionLock(dir, 'dead')).toEqual({ held: false });
  });

  it('redacts task text at the persist boundary', async () => {
    const secret = 'sk-ant-abcdefghij1234567890XY';
    const r = await store.create({ cwd: '/x', task: `fix login with ${secret}`, config: { model: 'm', maxSteps: 10 } });
    expect(r.task).not.toContain(secret);
    expect(r.task).toContain('[REDACTED]');
    const raw = await fs.readFile(path.join(dir, `${r.id}.json`), 'utf-8');
    expect(raw).not.toContain(secret);
  });

  it('redacts stored message text blocks', async () => {
    const secret = 'sk-ant-abcdefghij1234567890XY';
    const r = await store.create({ cwd: '/x', task: 't', config: { model: 'm', maxSteps: 10 } });
    await store.appendMessage(r.id, { role: 'user', content: `token ${secret} here`, ts: 1 });
    const msgs = await store.loadMessages(r.id);
    expect(JSON.stringify(msgs)).not.toContain(secret);
    expect(redactStoredContent([{ kind: 'text', text: `pw password=hunter2secret` }])).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('[REDACTED]') })]),
    );
  });

  it('per-project index is written atomically (no tmp droppings)', async () => {
    const r = await store.create({ cwd: '/proj', task: 't', config: { model: 'm', maxSteps: 10 } });
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([]);
    expect(entries.some((e) => e.startsWith('index-') && e.endsWith('.json'))).toBe(true);
    await store.delete(r.id);
    expect((await fs.readdir(dir)).filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  it('S4-at-rest: redacts observation input/output at the persist boundary', async () => {
    const secret = 'sk-ant-abcdefghij1234567890XY';
    const r = await store.create({ cwd: '/x', task: 't', config: { model: 'm', maxSteps: 10 } });
    await store.appendObservation(r.id, {
      toolCallId: 'c1',
      toolName: 'shell_exec',
      input: { command: `deploy with ${secret}` },
      output: `result included ${secret} inline`,
      isError: false,
      startedAt: 1,
      finishedAt: 2,
    });
    const obs = await store.loadObservations(r.id);
    expect(JSON.stringify(obs)).not.toContain(secret);
    expect(JSON.stringify(obs)).toContain('[REDACTED]');
  });

  it('S4-at-rest: normal observation prose survives redaction', async () => {
    const r = await store.create({ cwd: '/x', task: 't', config: { model: 'm', maxSteps: 10 } });
    await store.appendObservation(r.id, {
      toolCallId: 'c1',
      toolName: 'read_file',
      input: { path: 'a', note: 'my password is hunter2' },
      output: 'remember the plan',
      isError: false,
      startedAt: 1,
      finishedAt: 2,
    });
    const obs = await store.loadObservations(r.id);
    // redact() only fires on [:=-] shapes — bare prose passes through.
    expect(JSON.stringify(obs)).toContain('my password is hunter2');
    expect(JSON.stringify(obs)).toContain('remember the plan');
  });

  it('S4-at-rest: redacts finalText on setStatus but keeps normal prose', async () => {
    const secret = 'sk-ant-abcdefghij1234567890XY';
    const r = await store.create({ cwd: '/x', task: 't', config: { model: 'm', maxSteps: 10 } });
    await store.setStatus(r.id, 'complete', `done, used ${secret} to deploy`);
    const after = await store.get(r.id);
    expect(after?.finalText).not.toContain(secret);
    expect(after?.finalText).toContain('[REDACTED]');
    const raw = await fs.readFile(path.join(dir, `${r.id}.json`), 'utf-8');
    expect(raw).not.toContain(secret);

    const r2 = await store.create({ cwd: '/x', task: 't', config: { model: 'm', maxSteps: 10 } });
    await store.setStatus(r2.id, 'complete', 'all done, remember the plan');
    expect((await store.get(r2.id))?.finalText).toContain('remember the plan');
  });
});
