/**
 * Rate-limit scheduler for provider streams.
 *
 * A global in-flight counter + FIFO semaphore caps concurrent
 * `ProviderAdapter.stream` calls at `MAX_CONCURRENT_STREAMS` (4). An
 * adaptive cooldown collapses the cap to 1 while a recent 429 was
 * observed (`noteRateLimited`), honouring an optional server-provided
 * `Retry-After` delay, otherwise 60s.
 *
 * Consumed by `retryingAdapter` (see `./retry.js`), which acquires one
 * slot around each `inner.stream` call and releases it in a `finally`.
 * Aborted waiters are dequeued and rejected promptly.
 */

export const MAX_CONCURRENT_STREAMS = 4;
/** Fallback cooldown when no Retry-After delay was provided. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

let inFlight = 0;
/** `Date.now()` timestamp until which the cap stays collapsed at 1. */
let recent429Until = 0;

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const queue: Waiter[] = [];

function abortError(): Error {
  const err = new Error('stream slot acquisition aborted');
  err.name = 'AbortError';
  return err;
}

function effectiveCap(now: number = Date.now()): number {
  return now < recent429Until ? 1 : MAX_CONCURRENT_STREAMS;
}

function makeRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight = Math.max(0, inFlight - 1);
    pump();
  };
}

/** Grant queued waiters while a slot is free under the current cap. */
function pump(): void {
  while (queue.length > 0 && inFlight < effectiveCap()) {
    const waiter = queue.shift();
    if (!waiter) break;
    if (waiter.signal?.aborted) {
      waiter.reject(abortError());
      continue;
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    inFlight += 1;
    waiter.resolve(makeRelease());
  }
}

/**
 * Record a 429 (or equivalent) rate-limit signal. Collapses the stream
 * cap to 1 for `retryAfterMs` (or 60s when absent/invalid).
 */
export function noteRateLimited(retryAfterMs?: number): void {
  const cooldown =
    typeof retryAfterMs === 'number' &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
      ? retryAfterMs
      : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  recent429Until = Date.now() + cooldown;
  // Wake queued waiters once the cooldown lifts even if no release
  // happens in between (holders may outlive the cooldown). Unref'd so
  // tests and short-lived processes never hang on this timer.
  if (cooldown > 0 && cooldown < 3_600_000) {
    const timer = setTimeout(pump, cooldown);
    timer.unref?.();
  }
}

/**
 * Acquire a stream slot. Grants immediately when `inFlight` is under the
 * effective cap, otherwise queues FIFO until a release (or the cooldown
 * lifting) frees one. Abort-aware: an already-aborted signal rejects
 * immediately; aborting while queued dequeues and rejects promptly.
 */
export function acquireStreamSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (inFlight < effectiveCap()) {
    inFlight += 1;
    return Promise.resolve(makeRelease());
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject };
    if (signal) {
      waiter.signal = signal;
      waiter.onAbort = () => {
        const idx = queue.indexOf(waiter);
        if (idx >= 0) queue.splice(idx, 1);
        reject(abortError());
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    queue.push(waiter);
    // Re-check: the cap may have widened (cooldown expiry) between the
    // fast-path check and the push.
    pump();
  });
}

/** Observable budget state (tests/diagnostics). */
export function streamBudgetState(): { inFlight: number; queued: number; cap: number } {
  return { inFlight, queued: queue.length, cap: effectiveCap() };
}

/** Reset the budget (counters, cooldown, queued waiters). Tests only. */
export function setStreamBudgetForTests(): void {
  inFlight = 0;
  recent429Until = 0;
  const pending = queue.splice(0, queue.length);
  for (const waiter of pending) {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.reject(new Error('stream budget reset'));
  }
}
