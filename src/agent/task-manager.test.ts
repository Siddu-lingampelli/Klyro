import { describe, it, expect } from 'vitest';
import { TaskManager, type TaskRecord, type TaskStatus } from './task-manager.js';

describe('TaskManager', () => {
  it('creates a task with stable id, status=running, AbortController, and done promise', () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const rec = tm.create({ agentName: 'tester', cwd: '/tmp', depth: 1, maxDepth: 3 });
    expect(rec.id).toBe('task_1');
    expect(rec.status).toBe('running');
    expect(rec.abortController).toBeInstanceOf(AbortController);
    expect(rec.done).toBeInstanceOf(Promise);
    expect(rec.model).toBeUndefined();
  });

  it('queued option defers startedAt until start', () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const rec = tm.create({ agentName: 'tester', cwd: '/tmp', depth: 1, maxDepth: 3, autoStart: false });
    expect(rec.status).toBe('queued');
  });

  it('parent abort chains to child', async () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const parent = new AbortController();
    const rec = tm.create({ agentName: 'tester', cwd: '/tmp', depth: 1, maxDepth: 3, abortOnParent: parent.signal });
    parent.abort();
    expect(rec.status).toBe('cancelled');
    expect(rec.error?.code).toBe('CANCELLED');
    expect(rec.abortController.signal.aborted).toBe(true);
  });

  it('cancel() sets status=cancelled, fires event, resolves done', async () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const rec = tm.create({ agentName: 'tester', cwd: '/tmp', depth: 1, maxDepth: 3 });

    let fired = 0;
    tm.subscribe(rec.id, () => { fired += 1; });

    const ret = tm.cancel(rec.id, 'user stop');
    expect(ret.status).toBe('cancelled');
    expect(ret.error?.code).toBe('CANCELLED');
    expect(fired).toBeGreaterThan(0);

    const done = await rec.done;
    expect(done.status).toBe('cancelled');
  });

  it('finish() transitions status and resolves done', async () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const rec = tm.create({ agentName: 'tester', cwd: '/tmp', depth: 1, maxDepth: 3 });
    const ret = tm.finish(rec.id, 'succeeded', { summary: ['ok'] });
    expect(ret.status).toBe('succeeded');
    expect(await rec.done).toBe(rec);
  });

  it('timeout fires after timeoutMs and yields timed_out status', async () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const rec = tm.create({ agentName: 'tester', cwd: '/tmp', depth: 1, maxDepth: 3, timeoutMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(rec.status).toBe('timed_out');
    expect(rec.error?.code).toBe('TIMED_OUT');
  });

  it('finish() clears timeout — no double-fire', async () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const rec = tm.create({ agentName: 'tester', cwd: '/tmp', depth: 1, maxDepth: 3, timeoutMs: 5 });
    tm.finish(rec.id, 'succeeded');
    await new Promise((r) => setTimeout(r, 20));
    expect(rec.status).toBe('succeeded');
  });

  it('blocks recursion limit at create time', () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const rec = tm.create({ agentName: 'deep', cwd: '/tmp', depth: 4, maxDepth: 3 });
    expect(rec.status).toBe('blocked');
    expect(rec.error?.code).toBe('BLOCKED');
    expect(rec.error?.message).toMatch(/recursion/i);
  });

  it('cancelTree() cascades to descendants', async () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const p = tm.create({ agentName: 'root', cwd: '/tmp', depth: 0, maxDepth: 3 });
    const c1 = tm.create({ agentName: 'a', cwd: '/tmp', depth: 1, maxDepth: 3, parentTaskId: p.id });
    const c2 = tm.create({ agentName: 'b', cwd: '/tmp', depth: 1, maxDepth: 3, parentTaskId: p.id });
    const g = tm.create({ agentName: 'g1', cwd: '/tmp', depth: 2, maxDepth: 3, parentTaskId: c1.id });
    await tm.cancelTree(p.id);
    expect(p.status).toBe('cancelled');
    expect(c1.status).toBe('cancelled');
    expect(c2.status).toBe('cancelled');
    expect(g.status).toBe('cancelled');
  });

  it('list() filters by parentTaskId and status', () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const a = tm.create({ agentName: 'a', cwd: '/tmp', depth: 0, maxDepth: 3 });
    const b = tm.create({ agentName: 'b', cwd: '/tmp', depth: 1, maxDepth: 3, parentTaskId: a.id });
    tm.finish(b.id, 'succeeded');
    const c = tm.create({ agentName: 'c', cwd: '/tmp', depth: 1, maxDepth: 3, parentTaskId: a.id });

    const all = tm.list();
    expect(all.map((s) => s.id).sort()).toEqual([a.id, b.id, c.id].sort());

    const running = tm.list({ status: 'running' });
    expect(running.map((s) => s.id)).toEqual([a.id, c.id].sort());

    const childrenOfA = tm.list({ parentTaskId: a.id });
    expect(childrenOfA.map((s) => s.id).sort()).toEqual([b.id, c.id].sort());
  });

  it('subscribe() receives every transition; unsubscribe stops it', () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const rec = tm.create({ agentName: 't', cwd: '/tmp', depth: 0, maxDepth: 3 });

    const events: TaskStatus[] = [];
    const unsub = tm.subscribe(rec.id, (r) => events.push(r.status));
    expect(events).toEqual(['running']);

    tm.cancel(rec.id);
    expect(events).toEqual(['running', 'cancelled']);

    unsub();
    tm.finish(rec.id, 'succeeded'); // already terminal; no listener should fire
    expect(events).toEqual(['running', 'cancelled']);
  });

  it('parent watchers receive descendant events (transitive)', () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const p = tm.create({ agentName: 'p', cwd: '/tmp', depth: 0, maxDepth: 3 });
    const c = tm.create({ agentName: 'c', cwd: '/tmp', depth: 1, maxDepth: 3, parentTaskId: p.id });

    const seen: { id: string; status: TaskStatus }[] = [];
    tm.subscribe(p.id, (r) => seen.push({ id: r.id, status: r.status }));

    tm.cancel(c.id);
    expect(seen.some((e) => e.id === c.id && e.status === 'cancelled')).toBe(true);
  });

  it('shutdown() cancels all live tasks', async () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const a = tm.create({ agentName: 'a', cwd: '/tmp', depth: 0, maxDepth: 3 });
    const b = tm.create({ agentName: 'b', cwd: '/tmp', depth: 0, maxDepth: 3 });
    tm.finish(b.id, 'succeeded');

    await tm.shutdown();
    expect(a.status).toBe('cancelled');
    expect(b.status).toBe('succeeded');
  });

  it('toSummary returns plain object with core fields', () => {
    const tm = new TaskManager({ sessionId: 'sess' });
    const rec = tm.create({ agentName: 'x', cwd: '/tmp', depth: 2, maxDepth: 3, model: 'gpt-4o-mini' });
    const s = tm.toSummary(rec);
    expect(s.id).toBe(rec.id);
    expect(s.agentName).toBe('x');
    expect(s.depth).toBe(2);
    expect(s.model).toBe('gpt-4o-mini');
    expect(s.status).toBe('running');
  });
});
