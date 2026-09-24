/**
 * Legacy chat streaming (3.1): all human output flows through the shared
 * terminal renderer — model text is sanitized, backpressure preserved.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamToStdout } from './chat.js';

const ESC = String.fromCharCode(27);

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}

function sseText(content: string): string {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streamToStdout via renderer', () => {
  it('streams text deltas and strips control sequences', async () => {
    const body = sseBody([
      sseText('hello'),
      sseText(' ' + ESC + '[2Jworld'),
      'data: [DONE]\n\n',
    ]);
    const out = await captureStdout(() => streamToStdout(body, new AbortController().signal));
    expect(out).toContain('hello');
    expect(out).toContain('world');
    expect(out).not.toContain(ESC + '[2J');
  });

  it('stops cleanly on abort', async () => {
    const ac = new AbortController();
    ac.abort();
    const body = sseBody([sseText('hi')]);
    await captureStdout(() => streamToStdout(body, ac.signal).catch(() => undefined));
  });
});
