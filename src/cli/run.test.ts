import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runOnce, loadTranscript } from './run.js';
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
  const sink = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); cb(); },
  });
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

describe('runOnce', () => {
  it('returns 0 and streams final text for a one-shot completed task', async () => {
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'Hello, ' },
        { kind: 'text_delta', text: 'world.' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const code = await runOnce({
      task: 'say hi',
      cwd: process.cwd(),
      model: 'mock',
      adapter,
      abortOnSigint: false,
    });
    expect(code).toBe(0);
  });

  it('returns 3 when the agent hits max_steps', async () => {
    // Always emits a tool call so the loop never converges.
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream() {
        yield { kind: 'message_start' };
        yield { kind: 'tool_call_start', id: 'c1', name: 'shell_exec' };
        yield { kind: 'tool_call_delta', id: 'c1', argsJson: '{"command":"echo hi"}' };
        yield { kind: 'tool_call_end', id: 'c1' };
        yield { kind: 'message_end', finishReason: 'tool_calls' };
      },
    };
    const code = await runOnce({
      task: 'loop',
      cwd: process.cwd(),
      model: 'mock',
      adapter,
      maxSteps: 2,
      abortOnSigint: false,
    });
    expect(code).toBe(3);
  });

  describe('--output json', () => {
    it('emits one JSON object per line per RuntimeEvent', async () => {
      const adapter = scriptedAdapter([
        [
          { kind: 'message_start' },
          { kind: 'text_delta', text: 'hi' },
          { kind: 'message_end', finishReason: 'stop' },
        ],
      ]);
      const { out } = await captureStdout(() => runOnce({
        task: 'test',
        cwd: process.cwd(),
        model: 'mock',
        adapter,
        output: 'json',
        abortOnSigint: false,
      }));
      const lines = out.split('\n').filter((l) => l.length > 0);
      // Every line should parse as JSON
      const parsed = lines.map((l) => JSON.parse(l));
      // Should contain at least one text_delta event
      const textDeltas = parsed.filter((e) => e.kind === 'text_delta');
      expect(textDeltas.length).toBeGreaterThan(0);
      expect(textDeltas[0].text).toBe('hi');
      // Should end with a final marker
      const final = parsed[parsed.length - 1];
      expect(final.kind).toBe('final');
    });

    it('emits no human-readable text in json mode', async () => {
      const adapter = scriptedAdapter([
        [
          { kind: 'message_start' },
          { kind: 'text_delta', text: 'silent' },
          { kind: 'message_end', finishReason: 'stop' },
        ],
      ]);
      const { out } = await captureStdout(() => runOnce({
        task: 'test',
        cwd: process.cwd(),
        model: 'mock',
        adapter,
        output: 'json',
        abortOnSigint: false,
      }));
      // No [step ...] / [tool ...] / "klyro:" prefixes
      expect(out).not.toContain('[step');
      expect(out).not.toContain('[tool]');
      expect(out).not.toContain('klyro:');
    });
  });

  describe('--output silent', () => {
    it('emits no streaming output at all', async () => {
      const adapter = scriptedAdapter([
        [
          { kind: 'message_start' },
          { kind: 'text_delta', text: 'should not appear' },
          { kind: 'message_end', finishReason: 'stop' },
        ],
      ]);
      const { out } = await captureStdout(() => runOnce({
        task: 'test',
        cwd: process.cwd(),
        model: 'mock',
        adapter,
        output: 'silent',
        abortOnSigint: false,
      }));
      expect(out).not.toContain('should not appear');
      expect(out).not.toContain('[step');
    });
  });

  describe('--dry-run', () => {
    it('prints the prompt assembly as JSON and exits 0 without calling the model', async () => {
      const stream = vi.fn(async function* () {
        // should never be called
        yield { kind: 'message_start' as const };
      });
      const adapter: ProviderAdapter = { id: 'mock', stream };
      const { out, value } = await captureStdout(() => runOnce({
        task: 'inspect this',
        cwd: process.cwd(),
        model: 'mock-model',
        adapter,
        dryRun: true,
        abortOnSigint: false,
      }));
      expect(value).toBe(0);
      expect(stream).not.toHaveBeenCalled();
      const report = JSON.parse(out.trim());
      expect(report.kind).toBe('dry_run');
      expect(report.model).toBe('mock-model');
      expect(report.task).toBe('inspect this');
      expect(report.toolCount).toBeGreaterThan(0);
      expect(Array.isArray(report.toolNames)).toBe(true);
      expect(report.toolNames).toContain('read_file');
      expect(report.toolNames).toContain('shell_exec');
      expect(Array.isArray(report.policyRules)).toBe(true);
      expect(typeof report.systemPrompt).toBe('string');
      expect(report.systemPrompt.length).toBeGreaterThan(0);
    });
  });

  describe('--resume', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-resume-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('seeds the model with the prior transcript plus the new task', async () => {
      const prior = [
        { role: 'user', content: [{ kind: 'text', text: 'first' }] },
        { role: 'assistant', content: [{ kind: 'text', text: 'first answer' }] },
      ];
      const file = path.join(tmpDir, 'session.json');
      fs.writeFileSync(file, JSON.stringify({ transcript: prior }));

      let received: any[] | undefined;
      const adapter: ProviderAdapter = {
        id: 'mock',
        async *stream(req) {
          received = req.messages as any[];
          yield { kind: 'message_start' };
          yield { kind: 'text_delta', text: 'resumed' };
          yield { kind: 'message_end', finishReason: 'stop' };
        },
      };
      const code = await runOnce({
        task: 'continue here',
        cwd: process.cwd(),
        model: 'mock',
        adapter,
        resumePath: file,
        abortOnSigint: false,
      });
      expect(code).toBe(0);
      expect(received).toBeDefined();
      // Snapshotted before the loop appends the assistant response: prior
      // 2 messages + new task. The runtime may push more after the snapshot
      // is taken, so we only assert on what the seed should look like.
      expect(received!.length).toBeGreaterThanOrEqual(3);
      expect(received![0]?.content[0]?.text).toBe('first');
      expect(received![1]?.content[0]?.text).toBe('first answer');
      expect(received![2]?.content[0]?.text).toBe('continue here');
    });

    it('throws a descriptive error when the file does not exist (CLI catches and prints)', async () => {
      // runOnce propagates loadTranscript errors; the CLI command in
      // index.ts wraps the call in try/catch and prints the message to
      // stderr. Tests that want to verify the CLI behavior exercise
      // index.ts; here we verify the underlying throw is informative.
      await expect(runOnce({
        task: 'x',
        cwd: process.cwd(),
        model: 'mock',
        adapter: scriptedAdapter([[{ kind: 'message_start' }, { kind: 'text_delta', text: 'nope' }, { kind: 'message_end', finishReason: 'stop' }]]),
        resumePath: path.join(tmpDir, 'does-not-exist.json'),
        abortOnSigint: false,
      })).rejects.toThrow(/cannot read transcript file/);
    });
  });
});

describe('loadTranscript', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-load-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a valid transcript file', () => {
    const file = path.join(tmpDir, 't.json');
    fs.writeFileSync(file, JSON.stringify({
      transcript: [
        { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ kind: 'text', text: 'hello' }] },
      ],
    }));
    const t = loadTranscript(file);
    expect(t.length).toBe(2);
    expect(t[0]?.role).toBe('user');
  });

  it('throws on missing transcript field', () => {
    const file = path.join(tmpDir, 't.json');
    fs.writeFileSync(file, JSON.stringify({ task: 'x' }));
    expect(() => loadTranscript(file)).toThrow(/missing required field 'transcript'/);
  });

  it('throws on malformed message shape', () => {
    const file = path.join(tmpDir, 't.json');
    fs.writeFileSync(file, JSON.stringify({ transcript: [{ role: 'user' }] }));
    expect(() => loadTranscript(file)).toThrow(/malformed message/);
  });

  it('throws on invalid JSON', () => {
    const file = path.join(tmpDir, 't.json');
    fs.writeFileSync(file, '{not json');
    expect(() => loadTranscript(file)).toThrow(/not valid JSON/);
  });

  it('throws on missing file', () => {
    expect(() => loadTranscript(path.join(tmpDir, 'nope.json'))).toThrow(/cannot read transcript/);
  });

  it('throws when top-level is not an object', () => {
    const file = path.join(tmpDir, 't.json');
    fs.writeFileSync(file, JSON.stringify([{ role: 'user', content: [] }]));
    expect(() => loadTranscript(file)).toThrow(/must be a JSON object/);
  });
});
