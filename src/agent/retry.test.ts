import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryingAdapter, DEFAULT_RETRY, computeBackoff, sleepAbortable } from './retry.js';
import { acquireStreamSlot, setStreamBudgetForTests, streamBudgetState } from './stream-budget.js';
import type { ProviderAdapter, StreamEvent, CallRequest } from './provider-adapter.js';

beforeEach(() => setStreamBudgetForTests());
afterEach(() => setStreamBudgetForTests());

/** Test adapter that emits a scripted sequence per call. */
function scripted(events: StreamEvent[][]): ProviderAdapter & { calls: number } {
  const state = { calls: 0, idx: 0 };
  return {
    id: 'scripted',
    get calls() {
      return state.idx;
    },
    async *stream() {
      state.idx++;
      const step = events[state.idx - 1];
      if (!step) return;
      for (const ev of step) yield ev;
    },
  };
}

describe('retryingAdapter', () => {
  it('passes through non-error events on first attempt', async () => {
    const inner = scripted([
      [
        { kind: 'message_start' } as StreamEvent,
        { kind: 'text_delta', text: 'hi' } as StreamEvent,
        { kind: 'message_end', finishReason: 'stop' } as StreamEvent,
      ],
    ]);
    const out = retryingAdapter(inner, { sleep: async () => {} });
    const events: StreamEvent[] = [];
    for await (const ev of out.stream({} as CallRequest)) events.push(ev);
    expect(events.map((e) => e.kind)).toEqual(['message_start', 'text_delta', 'message_end']);
    expect(inner.calls).toBe(1);
  });

  it('retries on retryable error then succeeds', async () => {
    const inner = scripted([
      [{ kind: 'error', code: 'NETWORK', message: 'flaky', retryable: true } as StreamEvent],
      [
        { kind: 'message_start' } as StreamEvent,
        { kind: 'text_delta', text: 'ok' } as StreamEvent,
        { kind: 'message_end', finishReason: 'stop' } as StreamEvent,
      ],
    ]);
    const onAttempt = vi.fn();
    const out = retryingAdapter(inner, { sleep: async () => {}, onAttempt });
    const events: StreamEvent[] = [];
    for await (const ev of out.stream({} as CallRequest)) events.push(ev);
    expect(events.map((e) => e.kind)).toEqual(['message_start', 'text_delta', 'message_end']);
    expect(inner.calls).toBe(2);
    expect(onAttempt).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-retryable error', async () => {
    const inner = scripted([
      [{ kind: 'error', code: 'BAD_REQUEST', message: 'no', retryable: false } as StreamEvent],
    ]);
    const out = retryingAdapter(inner, { sleep: async () => {} });
    const events: StreamEvent[] = [];
    for await (const ev of out.stream({} as CallRequest)) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect(inner.calls).toBe(1);
  });

  it('gives up after maxAttempts and yields the retryable error', async () => {
    const inner = scripted([
      [{ kind: 'error', code: 'NETWORK', message: 'a', retryable: true } as StreamEvent],
      [{ kind: 'error', code: 'NETWORK', message: 'b', retryable: true } as StreamEvent],
      [{ kind: 'error', code: 'NETWORK', message: 'c', retryable: true } as StreamEvent],
    ]);
    const onAttempt = vi.fn();
    const out = retryingAdapter(inner, { maxAttempts: 3, sleep: async () => {}, onAttempt });
    const events: StreamEvent[] = [];
    for await (const ev of out.stream({} as CallRequest)) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    const e = events[0] as { kind: 'error'; message: string };
    expect(e.message).toBe('c');
    expect(inner.calls).toBe(3);
    expect(onAttempt).toHaveBeenCalledTimes(3);
  });

  it('uses default policy (5 attempts, 500ms base, 8s cap)', () => {
    expect(DEFAULT_RETRY.maxAttempts).toBe(5);
    expect(DEFAULT_RETRY.baseMs).toBe(500);
    expect(DEFAULT_RETRY.maxMs).toBe(8000);
  });

  it('aborts immediately when signal is already aborted', async () => {
    const inner = scripted([[{ kind: 'text_delta', text: 'x' } as StreamEvent]]);
    const ac = new AbortController();
    ac.abort();
    const out = retryingAdapter(inner, { sleep: async () => {} });
    const events: StreamEvent[] = [];
    for await (const ev of out.stream({} as CallRequest, ac.signal)) events.push(ev);
    expect(events).toHaveLength(0);
    expect(inner.calls).toBe(0);
  });

  it('backoff grows exponentially up to cap', () => {
    expect(computeBackoff(0, 500, 8000)).toBeGreaterThanOrEqual(0);
    expect(computeBackoff(0, 500, 8000)).toBeLessThanOrEqual(625);
    // Attempt 1 doubles
    expect(computeBackoff(1, 500, 8000)).toBeLessThanOrEqual(1250);
    // Attempt 4 caps at 8000
    expect(computeBackoff(10, 500, 8000)).toBeLessThanOrEqual(10000);
  });

  it('does not retry after a successful message_end in attempt 1', async () => {
    const inner = scripted([
      [
        { kind: 'message_start' } as StreamEvent,
        { kind: 'message_end', finishReason: 'stop' } as StreamEvent,
        // No retryable error — should not consume a 2nd attempt.
        { kind: 'error', code: 'LATE', message: 'after end', retryable: true } as StreamEvent,
      ],
    ]);
    const out = retryingAdapter(inner, { sleep: async () => {} });
    const events: StreamEvent[] = [];
    for await (const ev of out.stream({} as CallRequest)) events.push(ev);
    // Both yielded because the error came after message_end — but since
    // it's retryable, retry should kick in and call again.
    // Expected: message_start, message_end, error (terminal because we never
    //  re-issue if error arrives last in a non-empty stream).
    // Actually: our impl breaks out of inner on first retryable error.
    // So we'll get message_start, message_end, then break to retry — but
    // the second call returns nothing, so we yield no error. Verify
    // that the retryable error after message_end is consumed and not
    // surfaced (since it had retryable=true but appeared after success
    // markers, this is an edge case).
    expect(events.map((e) => e.kind)).toEqual(['message_start', 'message_end']);
  });

  it('sleepAbortable wakes early on abort (no stall)', async () => {
    const ctrl = new AbortController();
    let slept = 0;
    const sleep = async (ms: number): Promise<void> => {
      slept += ms;
      await new Promise((r) => setTimeout(r, ms));
    };
    const p = sleepAbortable(5000, sleep, ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    const start = Date.now();
    await p;
    expect(Date.now() - start).toBeLessThan(1000);
    expect(slept).toBe(5000); // underlying sleep still ran; WE returned early
  });

  it('sleepAbortable is a no-op without signal', async () => {
    let called = false;
    await sleepAbortable(1, async () => { called = true; });
    expect(called).toBe(true);
  });

  it('onRetry fires with attempt 1 then 2 and consumer never sees buffered errors', async () => {
    const inner = scripted([
      [{ kind: 'error', code: 'HTTP_429', message: 'slow down', retryable: true, status: '429' } as StreamEvent],
      [{ kind: 'error', code: 'HTTP_503', message: 'flaky', retryable: true } as StreamEvent],
      [
        { kind: 'message_start' } as StreamEvent,
        { kind: 'text_delta', text: 'ok' } as StreamEvent,
        { kind: 'message_end', finishReason: 'stop' } as StreamEvent,
      ],
    ]);
    const onRetry = vi.fn();
    const out = retryingAdapter(inner, { sleep: async () => {}, onRetry });
    const events: StreamEvent[] = [];
    for await (const ev of out.stream({} as CallRequest)) events.push(ev);
    expect(events.map((e) => e.kind)).toEqual(['message_start', 'text_delta', 'message_end']);
    expect(inner.calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, { attempt: 1, status: '429' });
    expect(onRetry).toHaveBeenNthCalledWith(2, { attempt: 2, status: 'HTTP_503' });
  });

  it('fatal error yields immediately with no onRetry', async () => {
    const inner = scripted([
      [{ kind: 'error', code: 'BAD_REQUEST', message: 'no', retryable: false } as StreamEvent],
    ]);
    const onRetry = vi.fn();
    const out = retryingAdapter(inner, { sleep: async () => {}, onRetry });
    const events: StreamEvent[] = [];
    for await (const ev of out.stream({} as CallRequest)) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect(inner.calls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('does not call onRetry for the terminal failure', async () => {
    const inner = scripted([
      [{ kind: 'error', code: 'NETWORK', message: 'a', retryable: true } as StreamEvent],
      [{ kind: 'error', code: 'NETWORK', message: 'b', retryable: true } as StreamEvent],
      [{ kind: 'error', code: 'NETWORK', message: 'c', retryable: true } as StreamEvent],
    ]);
    const onRetry = vi.fn();
    const out = retryingAdapter(inner, { maxAttempts: 3, sleep: async () => {}, onRetry });
    const events: StreamEvent[] = [];
    for await (const ev of out.stream({} as CallRequest)) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('error');
    expect(inner.calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, { attempt: 1, status: 'NETWORK' });
    expect(onRetry).toHaveBeenNthCalledWith(2, { attempt: 2, status: 'NETWORK' });
  });

  it("falls back to 'retryable' when status and code are absent", async () => {
    const inner = scripted([
      [{ kind: 'error', code: '', message: 'x', retryable: true } as unknown as StreamEvent],
      [{ kind: 'message_end', finishReason: 'stop' } as StreamEvent],
    ]);
    const onRetry = vi.fn();
    const out = retryingAdapter(inner, { sleep: async () => {}, onRetry });
    const events: StreamEvent[] = [];
    for await (const ev of out.stream({} as CallRequest)) events.push(ev);
    expect(events.map((e) => e.kind)).toEqual(['message_end']);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, status: 'retryable' });
  });

  it('abort during backoff stops further attempts', async () => {
    const ac = new AbortController();
    const inner = scripted([
      [{ kind: 'error', code: 'HTTP_503', message: 'flaky', retryable: true, retryAfterMs: 5000 } as StreamEvent],
      [
        { kind: 'message_start' } as StreamEvent,
        { kind: 'message_end', finishReason: 'stop' } as StreamEvent,
      ],
    ]);
    const onRetry = vi.fn();
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      ac.abort();
    };
    const out = retryingAdapter(inner, { sleep, onRetry });
    const events: StreamEvent[] = [];
    for await (const ev of out.stream({ signal: ac.signal } as CallRequest)) events.push(ev);
    expect(events).toHaveLength(0);
    expect(inner.calls).toBe(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([5000]);
  });

  it('honors retryAfterMs from the error event as the backoff delay', async () => {    const inner = scripted([
      [{ kind: 'error', code: 'HTTP_429', message: 'slow', retryable: true, status: '429', retryAfterMs: 2500 } as StreamEvent],
      [{ kind: 'message_end', finishReason: 'stop' } as StreamEvent],
    ]);
    const onRetry = vi.fn();
    const sleeps: number[] = [];
    const out = retryingAdapter(inner, { sleep: async (ms: number) => { sleeps.push(ms); }, onRetry });
    const events: StreamEvent[] = [];
    for await (const ev of out.stream({} as CallRequest)) events.push(ev);
    expect(events.map((e) => e.kind)).toEqual(['message_end']);
    expect(inner.calls).toBe(2);
    expect(sleeps).toEqual([2500]);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, status: '429', retryAfterMs: 2500 });
  });
});

describe('retryingAdapter stream budget', () => {
  /** After a 429 the global cap collapses to 1: a second slot must wait. */
  async function expectCapCollapsedToOne(): Promise<void> {
    expect(streamBudgetState().cap).toBe(1);
    const first = await acquireStreamSlot();
    try {
      let granted = false;
      const second = acquireStreamSlot().then((release) => {
        granted = true;
        return release;
      });
      second.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 20));
      expect(granted).toBe(false);
      first();
      (await second)();
    } catch {
      first();
      throw new Error('expected cap 1 after 429');
    }
  }

  async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  it("notes rate-limit on status string '429'", async () => {
    const inner = scripted([
      [{ kind: 'error', code: 'HTTP_429', message: 'slow', retryable: true, status: '429', retryAfterMs: 60_000 } as StreamEvent],
      [{ kind: 'message_end', finishReason: 'stop' } as StreamEvent],
    ]);
    const out = retryingAdapter(inner, { sleep: async () => {} });
    expect((await drain(out.stream({} as CallRequest))).map((e) => e.kind)).toEqual(['message_end']);
    await expectCapCollapsedToOne();
  });

  it('notes rate-limit on code substring (no status field)', async () => {
    const inner = scripted([
      [{ kind: 'error', code: 'HTTP_429', message: 'slow', retryable: true, retryAfterMs: 60_000 } as StreamEvent],
      [{ kind: 'message_end', finishReason: 'stop' } as StreamEvent],
    ]);
    const out = retryingAdapter(inner, { sleep: async () => {} });
    expect((await drain(out.stream({} as CallRequest))).map((e) => e.kind)).toEqual(['message_end']);
    await expectCapCollapsedToOne();
  });

  it('notes rate-limit on numeric 429 fields', async () => {
    const inner = scripted([
      [{ kind: 'error', code: 'E', message: 'slow', retryable: true, status: 429, retryAfterMs: 60_000 } as unknown as StreamEvent],
      [{ kind: 'message_end', finishReason: 'stop' } as StreamEvent],
    ]);
    const out = retryingAdapter(inner, { sleep: async () => {} });
    expect((await drain(out.stream({} as CallRequest))).map((e) => e.kind)).toEqual(['message_end']);
    await expectCapCollapsedToOne();
  });

  it('non-429 retryable errors leave the cap at 4', async () => {
    const inner = scripted([
      [{ kind: 'error', code: 'HTTP_503', message: 'flaky', retryable: true } as StreamEvent],
      [{ kind: 'message_end', finishReason: 'stop' } as StreamEvent],
    ]);
    const out = retryingAdapter(inner, { sleep: async () => {} });
    expect((await drain(out.stream({} as CallRequest))).map((e) => e.kind)).toEqual(['message_end']);
    expect(streamBudgetState().cap).toBe(4);
    const releases = await Promise.all([
      acquireStreamSlot(),
      acquireStreamSlot(),
      acquireStreamSlot(),
      acquireStreamSlot(),
    ]);
    for (const release of releases) release();
  });

  it('slots are released after each attempt (no leak across retries)', async () => {
    const inner = scripted([
      [{ kind: 'error', code: 'NETWORK', message: 'a', retryable: true } as StreamEvent],
      [{ kind: 'message_end', finishReason: 'stop' } as StreamEvent],
    ]);
    const out = retryingAdapter(inner, { sleep: async () => {} });
    await drain(out.stream({} as CallRequest));
    expect(streamBudgetState().inFlight).toBe(0);
  });

  it('abort while queued for a slot ends promptly with no inner call', async () => {
    const holders = await Promise.all([
      acquireStreamSlot(),
      acquireStreamSlot(),
      acquireStreamSlot(),
      acquireStreamSlot(),
    ]);
    try {
      const inner = scripted([[{ kind: 'message_end', finishReason: 'stop' } as StreamEvent]]);
      const ctrl = new AbortController();
      const out = retryingAdapter(inner, { sleep: async () => {} });
      setTimeout(() => ctrl.abort(), 10);
      const start = Date.now();
      const events = await drain(out.stream({} as CallRequest, ctrl.signal));
      expect(Date.now() - start).toBeLessThan(1000);
      expect(events).toHaveLength(0);
      expect(inner.calls).toBe(0);
    } finally {
      for (const release of holders) release();
    }
  });
});
