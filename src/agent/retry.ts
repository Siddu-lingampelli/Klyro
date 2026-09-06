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
  while (true) {
    if (signal.aborted) return;
    const next = await it.next();
    if (next.done) return;
    yield next.value;
  }
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
      const effectiveSignal = signal ?? opts.signal;
      for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
        opts.onAttempt?.(attempt);
        if (effectiveSignal?.aborted) return;
        let sawRetryable = false;
        let lastError: StreamEvent | null = null;
        for await (const ev of streamWithAbort(inner.stream(req), effectiveSignal)) {
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
        if (delay > 0) await sleep(delay);
      }
    },
  };
}
