import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  acquireStreamSlot,
  noteRateLimited,
  setStreamBudgetForTests,
  streamBudgetState,
  MAX_CONCURRENT_STREAMS,
} from './stream-budget.js';

beforeEach(() => setStreamBudgetForTests());
afterEach(() => setStreamBudgetForTests());

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('stream budget', () => {
  it('caps concurrent streams at MAX_CONCURRENT_STREAMS=4', async () => {
    expect(MAX_CONCURRENT_STREAMS).toBe(4);
    let active = 0;
    let maxActive = 0;
    const one = async (): Promise<void> => {
      const release = await acquireStreamSlot();
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active -= 1;
      release();
    };
    await Promise.all([one(), one(), one(), one(), one()]);
    expect(maxActive).toBeLessThanOrEqual(4);
    // All five ran, so the cap must actually have been hit.
    expect(maxActive).toBe(4);
    expect(streamBudgetState().inFlight).toBe(0);
  });

  it('noteRateLimited collapses the cap to 1 until released', async () => {
    noteRateLimited(60_000);
    expect(streamBudgetState().cap).toBe(1);
    const first = await acquireStreamSlot();
    let secondGranted = false;
    const second = acquireStreamSlot().then((release) => {
      secondGranted = true;
      return release;
    });
    // Attach a noop catch early so a test failure cannot surface as an
    // unhandled rejection before we await below.
    second.catch(() => undefined);
    await sleep(30);
    expect(secondGranted).toBe(false);
    first();
    const releaseSecond = await second;
    releaseSecond();
    expect(streamBudgetState().inFlight).toBe(0);
  });

  it('honours a short retryAfterMs: cap restores after the cooldown', async () => {
    noteRateLimited(30);
    expect(streamBudgetState().cap).toBe(1);
    await sleep(60);
    expect(streamBudgetState().cap).toBe(MAX_CONCURRENT_STREAMS);
  });

  it('abort while queued rejects promptly', async () => {
    const holders = await Promise.all([
      acquireStreamSlot(),
      acquireStreamSlot(),
      acquireStreamSlot(),
      acquireStreamSlot(),
    ]);
    try {
      const ctrl = new AbortController();
      const pending = acquireStreamSlot(ctrl.signal);
      pending.catch(() => undefined);
      let settled: 'resolved' | 'rejected' | null = null;
      const guarded = pending.then(
        () => {
          settled = 'resolved';
        },
        () => {
          settled = 'rejected';
        },
      );
      setTimeout(() => ctrl.abort(), 10);
      const start = Date.now();
      await guarded;
      expect(settled).toBe('rejected');
      expect(Date.now() - start).toBeLessThan(1000);
      // The aborted waiter left the queue; state is clean.
      expect(streamBudgetState().queued).toBe(0);
    } finally {
      for (const release of holders) release();
    }
  });

  it('already-aborted signal rejects immediately', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(acquireStreamSlot(ctrl.signal)).rejects.toThrow(/abort/i);
  });

  it('setStreamBudgetForTests clears a 429 cooldown', async () => {
    noteRateLimited(60_000);
    expect(streamBudgetState().cap).toBe(1);
    setStreamBudgetForTests();
    expect(streamBudgetState().cap).toBe(MAX_CONCURRENT_STREAMS);
    const releases = await Promise.all([
      acquireStreamSlot(),
      acquireStreamSlot(),
      acquireStreamSlot(),
      acquireStreamSlot(),
    ]);
    for (const release of releases) release();
  });

  it('release is idempotent (double release never corrupts the counter)', async () => {
    const release = await acquireStreamSlot();
    release();
    release();
    expect(streamBudgetState().inFlight).toBe(0);
  });
});
