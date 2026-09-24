/**
 * run CLI flags (2.3/3.4/3.5): pure helpers + headless wiring —
 * permission overrides, max-turns alias, system-prompt layering, TTFT.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { splitToolList, minDefined, withSystemPromptOverrides, runOnce } from './run.js';
import type { ProviderAdapter, StreamEvent } from '../agent/provider-adapter.js';

function scriptedAdapter(events: StreamEvent[][]): ProviderAdapter {
  let i = 0;
  return {
    id: 'mock',
    async *stream() {
      if (i < events.length) {
        for (const ev of events[i++]) yield ev;
      }
    },
  };
}

/** Capture stdout writes into a string for the duration of fn(). */
async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; value: T }> {
  const chunks: Buffer[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // @ts-expect-error — overloads are not worth modelling
  process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return true;
  };
  try {
    const value = await fn();
    return { out: Buffer.concat(chunks).toString('utf8'), value };
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
}

describe('run flag helpers', () => {
  it('splitToolList handles strings, arrays, commas, blanks', () => {
    expect(splitToolList(undefined)).toEqual([]);
    expect(splitToolList('a, b ,,c')).toEqual(['a', 'b', 'c']);
    expect(splitToolList(['a', 'b,c'])).toEqual(['a', 'b', 'c']);
  });

  it('minDefined takes the smaller cap', () => {
    expect(minDefined(undefined, undefined)).toBeUndefined();
    expect(minDefined(5, undefined)).toBe(5);
    expect(minDefined(undefined, 7)).toBe(7);
    expect(minDefined(5, 3)).toBe(3);
  });

  it('withSystemPromptOverrides replaces, appends, or passes through', () => {
    const base = () => ({ system: 'base', suffix: 'sfx' });
    expect(withSystemPromptOverrides(base, {})).toBe(base);
    expect(withSystemPromptOverrides(base, { replace: 'R' })({ cwd: '/x' })).toBe('R');
    expect(withSystemPromptOverrides(base, { replace: 'R', append: 'A' })({ cwd: '/x' })).toBe('R\n\nA');
    expect(withSystemPromptOverrides(base, { append: 'A' })({ cwd: '/x' })).toEqual({ system: 'base\n\nA', suffix: 'sfx' });
    expect(withSystemPromptOverrides(() => 'plain', { append: 'A' })({ cwd: '/x' })).toEqual({ system: 'plain\n\nA' });
  });
});

describe('runOnce flag wiring', () => {
  it('--disallowed-tools blocks the tool without executing it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-flags-'));
    try {
      const probe = path.join(dir, 'probe.txt');
      const adapter = scriptedAdapter([
        [
          { kind: 'message_start' },
          { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
          { kind: 'tool_call_delta', id: 'c1', argsJson: JSON.stringify({ path: probe, content: 'x' }) },
          { kind: 'tool_call_end', id: 'c1' },
          { kind: 'message_end', finishReason: 'tool_calls' },
        ],
        [
          { kind: 'message_start' },
          { kind: 'text_delta', text: 'done' },
          { kind: 'message_end', finishReason: 'stop' },
        ],
      ]);
      const code = await runOnce({
        task: 'write probe', cwd: dir, model: 'mock', maxSteps: 4,
        adapter, output: 'silent', bare: true, persist: false, abortOnSigint: false,
        disallowedTools: ['write_file'],
      });
      expect(code).toBe(0);
      await expect(fs.stat(probe)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('result envelope and cost carry ttft_ms/total_ms (2.5)', async () => {
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'hi' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const { out } = await captureStdout(() => runOnce({
      task: 't', cwd: process.cwd(), model: 'mock', adapter,
      output: 'json', bare: true, persist: false, abortOnSigint: false,
    }));
    const lines = out.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const result = lines.find((e) => e.kind === 'result');
    expect(result).toMatchObject({ status: 'complete' });
    expect(typeof result.ttft_ms).toBe('number');
    expect(typeof result.total_ms).toBe('number');
    expect(result.total_ms).toBeGreaterThanOrEqual(result.ttft_ms);
    const cost = lines.find((e) => e.kind === 'cost');
    expect(typeof cost.ttft_ms).toBe('number');
    expect(typeof cost.total_ms).toBe('number');
  });

  it('--add-dir lets file tools reach outside cwd; without it the jail holds', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-adddir-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-adddir-out-'));
    try {
      const target = path.join(outside, 'note.txt');
      const script = [
        [
          { kind: 'message_start' },
          { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
          { kind: 'tool_call_delta', id: 'c1', argsJson: JSON.stringify({ path: target, content: 'hi' }) },
          { kind: 'tool_call_end', id: 'c1' },
          { kind: 'message_end', finishReason: 'tool_calls' },
        ],
        [
          { kind: 'message_start' },
          { kind: 'text_delta', text: 'done' },
          { kind: 'message_end', finishReason: 'stop' },
        ],
      ] as StreamEvent[][];
      const base = { task: 'write outside', cwd: dir, model: 'mock', maxSteps: 4, output: 'silent', bare: true, persist: false, abortOnSigint: false } as const;
      const allowed = await runOnce({ ...base, adapter: scriptedAdapter(script) as ProviderAdapter, addDir: [outside] });
      expect(allowed).toBe(0);
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe('hi');
      await fs.rm(target, { force: true });
      const denied = await runOnce({ ...base, adapter: scriptedAdapter(script) as ProviderAdapter });
      expect(denied).toBe(0);
      await expect(fs.stat(target)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("permissionMode plan blocks writes that default allows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-planmode-'));
    try {
      const target = path.join(dir, 'x.txt');
      const adapter = scriptedAdapter([
        [
          { kind: 'message_start' },
          { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
          { kind: 'tool_call_delta', id: 'c1', argsJson: JSON.stringify({ path: target, content: 'x' }) },
          { kind: 'tool_call_end', id: 'c1' },
          { kind: 'message_end', finishReason: 'tool_calls' },
        ],
        [
          { kind: 'message_start' },
          { kind: 'text_delta', text: 'done' },
          { kind: 'message_end', finishReason: 'stop' },
        ],
      ]);
      const code = await runOnce({
        task: 'write', cwd: dir, model: 'mock', maxSteps: 4,
        adapter, output: 'silent', bare: true, persist: false, abortOnSigint: false,
        permissionMode: 'plan',
      });
      expect(code).toBe(0);
      await expect(fs.stat(target)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
