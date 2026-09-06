/**
 * Retry wrapper for ProviderAdapter.
 *
 * Wraps a ProviderAdapter.stream so that on a yielded `error` event with
 * `retryable: true`, the request is re-issued with exponential backoff +
 * jitter. Non-retryable errors fall through immediately.
 *
 * Important: this only retries errors that the adapter itself surfaces
 * via StreamEvent. The adapter is responsible for translating HTTP
 * status codes to retryable: true/false. We never reach into the
 * adapter to retry raw transport errors.
 *
 * The retry consumes the entire generator each attempt, then re-issues.
 * Between attempts we sleep with backoff:
 *
 *   delay = min(maxMs, baseMs * 2^attempt) ± jitter
 *
 * The default policy matches the L6 plan: 3 attempts, 500ms base, 8s cap.
 */

import type { ProviderAdapter, StreamEvent, CallRequest } from './provider-adapter.js';

export interface RetryOptions {
  maxAttempts: number; // total attempts (1 = no retry)
  baseMs: number; // first backoff
  maxMs: number; // cap
  /** Per-attempt AbortSignal honored — abort cancels the sleep + the next call. */
  signal?: AbortSignal;
  /** Sleep impl — tests inject a synchronous zero. Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Test hook: called once per attempt with 0-indexed attempt number. */
  onAttempt?: (attempt: number) => void;
}

export const DEFAULT_RETRY: Required<Omit<RetryOptions, 'signal' | 'onAttempt'>> = {
  maxAttempts: 3,
  baseMs: 500,
  maxMs: 8_000,
  sleep: defaultSleep,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* streamWithAbort(
  source: AsyncIterable<StreamEvent>,
  signal: AbortSignal | undefined,
): AsyncIterable<StreamEvent> {
  if (!signal) {
    for await (const ev of source) yield ev;
    return;
  }
  const it = source[Symbol.asyncIterator]();
  try {
    while (true) {
      if (signal.aborted) {
        try { await it.return?.(); } catch { /* ignore */ }
        return;
      }
      const next = await it.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    if (signal.aborted) {
      try { await it.return?.(); } catch { /* ignore */ }
    }
  }
}

/**
 * Sleep that resolves early when `signal` aborts (never rejects — callers
 * check `signal.aborted` themselves after waking).
 */
export function sleepAbortable(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  // No signal: plain sleep (identical to the old behavior).
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    void sleep(ms).then(finish);
  });
}

export function computeBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  // Jitter: ±25% to spread thundering herds.
  const jitter = exp * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(exp + jitter));
}

export function retryingAdapter(inner: ProviderAdapter, opts: Partial<RetryOptions> = {}): ProviderAdapter {
  const cfg = { ...DEFAULT_RETRY, ...opts };
  const sleep = opts.sleep ?? defaultSleep;

  return {
    id: `${inner.id}+retry`,
    async *stream(req: CallRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      // Support both calling conventions: stream(req) where req.signal is set, and legacy stream(req, signal)
      // Combine per-request signal (req.signal), legacy second-arg signal, and adapter-level opts.signal
      const getEffectiveSignal = (legacySignal?: AbortSignal): AbortSignal | undefined => {
        const sigs = [req.signal, legacySignal, opts.signal].filter(Boolean) as AbortSignal[];
        if (sigs.length === 0) return undefined;
        if (sigs.length === 1) return sigs[0];
        // If any aborts, effective aborts — create a combined controller
        const ctrl = new AbortController();
        const onAbort = () => {
          const reason = sigs.find((s) => s.aborted)?.reason ?? (sigs[0]?.reason as Error);
          try { ctrl.abort(reason as Error); } catch { ctrl.abort(); }
        };
        if (sigs.some((s) => s.aborted)) {
          onAbort();
        } else {
          for (const s of sigs) s.addEventListener('abort', onAbort, { once: true });
        }
        return ctrl.signal;
      };
      for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
        const effectiveSignal = getEffectiveSignal(signal);
        // Clone req per attempt to avoid reusing aborted signal
        const attemptReq: CallRequest = effectiveSignal ? { ...req, signal: effectiveSignal } : req;
        opts.onAttempt?.(attempt);
        if (effectiveSignal?.aborted) return;
        let sawRetryable = false;
        let lastError: StreamEvent | null = null;
        for await (const ev of streamWithAbort(inner.stream(attemptReq), effectiveSignal)) {
          if (effectiveSignal?.aborted) return;
          if (ev.kind === 'error' && ev.retryable) {
            // Buffer the retryable error; don't yield it yet. We'll either
            // re-issue (and the caller will never see the error) or, on
            // final attempt, yield it as the terminal error.
            sawRetryable = true;
            lastError = ev;
            break; // stop consuming; the stream is dead on retryable errors.
          }
          yield ev;
        }
        if (!sawRetryable) return; // success or non-retryable error — done.
        if (attempt === cfg.maxAttempts - 1) {
          // Final attempt failed — surface the error.
          if (lastError) yield lastError;
          return;
        }
        const delay = computeBackoff(attempt, cfg.baseMs, cfg.maxMs);
        // Abort-aware backoff: Ctrl+C during the sleep must stop promptly
        // instead of stalling up to maxMs before noticing.
        if (delay > 0) await sleepAbortable(delay, sleep, effectiveSignal);
      }
    },
  };
}
