/**
 * One-shot chat. POSTs to an OpenAI-compatible /v1/chat/completions endpoint
 * and streams the response to stdout.
 *
 * Config (env):
 *   KLYRO_BASE_URL  e.g. https://api.openai.com/v1
 *   KLYRO_API_KEY   bearer token
 *   KLYRO_MODEL     e.g. gpt-4o-mini
 *   KLYRO_TIMEOUT_MS request timeout in ms (default 60000)
 *
 * No abstractions, no registry, no retries. If you want those, layer them on later.
 */

/** Default request timeout: 60s. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Max bytes of an error response body we will print. */
const MAX_ERROR_BODY_BYTES = 4_000;

export interface ChatOptions {
  system?: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Strip a trailing slash so we can append /chat/completions cleanly. */
export function normalizeBaseURL(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Validate that the base URL is HTTPS (or localhost over HTTP for local LLMs).
 * Refuses to send the bearer token over a plaintext remote connection.
 */
export function assertSafeBaseURL(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`KLYRO_BASE_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    // Allow loopback equivalents: localhost, 127.0.0.1, ::1, 0.0.0.0, ::, 127.x.x.x is NOT allowed without https
    // Note: hostnames that resolve to loopback (e.g. nip.io) still require https — we check hostname, not DNS.
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host === '::' || host === '[::]') return;
    // Also allow 127.0.0.0/8 range via prefix check (e.g. 127.0.0.2)
    if (host.startsWith('127.')) {
      const parts = host.split('.');
      if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) return;
    }
    throw new Error(
      `Refusing to send KLYRO_API_KEY over plaintext HTTP to ${host}. ` +
        `Use https:// or a localhost URL (localhost, 127.0.0.1, ::1, 0.0.0.0).`,
    );
  }
  throw new Error(`Unsupported KLYRO_BASE_URL protocol: ${parsed.protocol}`);
}

export async function chat(
  prompt: string,
  system: string,
  modelOverride?: string,
  opts: ChatOptions = {},
): Promise<void> {
  const baseURL = opts.baseURL ?? process.env.KLYRO_BASE_URL ?? 'https://api.openai.com/v1';
  const apiKey = opts.apiKey ?? process.env.KLYRO_API_KEY;
  const model = modelOverride ?? opts.model ?? process.env.KLYRO_MODEL ?? 'gpt-4o-mini';
  const timeoutMs =
    opts.timeoutMs ?? (Number(process.env.KLYRO_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

  if (!apiKey) {
    console.error('klyro: KLYRO_API_KEY is not set. Set it in your environment.');
    process.exit(2);
  }
  assertSafeBaseURL(baseURL);

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  // Ensure timer is always cleared — use try/finally pattern
  const clearTimer = () => clearTimeout(timeout);
  // If the caller passed their own signal, abort when they abort.
  let callerAbortHandler: (() => void) | undefined;
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort(opts.signal.reason);
    else {
      callerAbortHandler = () => ac.abort(opts.signal?.reason);
      opts.signal.addEventListener('abort', callerAbortHandler, { once: true });
    }
  }

  let res: Response;
  try {
    res = await fetch(`${normalizeBaseURL(baseURL)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        stream: true,
      }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimer();
    if (callerAbortHandler && opts.signal) opts.signal.removeEventListener('abort', callerAbortHandler);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`klyro: request failed: ${msg}`);
    process.exit(1);
  }
  clearTimer();
  if (callerAbortHandler && opts.signal) opts.signal.removeEventListener('abort', callerAbortHandler);

  if (!res.ok) {
    const text = await readBoundedText(res.body, MAX_ERROR_BODY_BYTES);
    console.error(`klyro: HTTP ${res.status} ${res.statusText}\n${text}`);
    process.exit(1);
  }
  if (!res.body) {
    console.error('klyro: response had no body');
    process.exit(1);
  }

  try {
    await streamToStdout(res.body, ac.signal);
  } catch (err) {
    if (ac.signal.aborted) {
      // Cancelled by us (timeout) or the caller. Quiet exit.
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nklyro: stream error: ${msg}`);
    process.exit(1);
  }
}

/**
 * Parse SSE frames and write text deltas to stdout. Handles
 * fragmented chunks by buffering and splitting on \n\n event boundary.
 * Respects backpressure on stdout and the provided abort signal.
 */
export async function streamToStdout(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  process.stdout.write('\n');
  try {
    while (true) {
      if (signal.aborted) throw new Error('aborted');
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by \n\n — handle fragmented deliveries
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        if (signal.aborted) throw new Error('aborted');
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const rawLine of event.split('\n')) {
          const line = rawLine.replace(/\r$/, '');
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            process.stdout.write('\n');
            return;
          }
          // Handle case where data was split across chunks and reassembled as event
          if (data === '') continue;
          let parsed: { choices?: Array<{ delta?: { content?: string } }> };
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          const text = parsed.choices?.[0]?.delta?.content;
          if (text) {
            if (!await writeWithBackpressure(text, signal)) {
              try { await reader.cancel(); } catch { /* ignore */ }
              return;
            }
          }
        }
      }
      // Also handle single \n lines that haven't yet formed \n\n (for providers that send \n only)
      // Process remaining complete lines if no \n\n found but buffer has \n
      if (buf.includes('\n') && !buf.includes('\n\n')) {
        const lines = buf.split('\n');
        // Keep last incomplete line in buf
        buf = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, '');
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            process.stdout.write('\n');
            return;
          }
          if (data === '') continue;
          try {
            const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            const text = parsed.choices?.[0]?.delta?.content;
            if (text) {
              if (!await writeWithBackpressure(text, signal)) {
                try { await reader.cancel(); } catch { /* ignore */ }
                return;
              }
            }
          } catch {
            continue;
          }
        }
      }
    }
    process.stdout.write('\n');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/**
 * Write to stdout and wait for the drain event if the buffer is full.
 * Returns false if stdout has been closed (e.g. piped to `head`).
 * Respects abort signal — resolves false if aborted while waiting.
 */
function writeWithBackpressure(chunk: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    if (!process.stdout.write(chunk)) {
      let settled = false;
      const cleanup = () => {
        process.stdout.off('drain', onDrain);
        process.stdout.off('error', onError);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onDrain = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(true);
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      process.stdout.once('drain', onDrain);
      process.stdout.once('error', onError);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    } else {
      resolve(true);
    }
  });
}

/**
 * Read up to `max` bytes from a response body. Used for error responses where
 * we want to surface the cause without risking OOM on a misbehaving server.
 */
export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (received < max) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        break;
      }
      const { value, done } = result;
      if (done) break;
      if (!value) break;
      const remaining = max - received;
      if (value.byteLength <= remaining) {
        chunks.push(value);
        received += value.byteLength;
      } else {
        chunks.push(value.slice(0, remaining));
        received += remaining;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await reader.cancel().catch(() => undefined);
    } catch {
      /* ignore */
    }
  }
  const decoder = new TextDecoder('utf-8');
  const text = decoder.decode(Buffer.concat(chunks));
  return received >= max ? `${text}\n[truncated]` : text;
}

