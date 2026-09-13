import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runOnce, loadTranscript, shouldForceExit } from './run.js';
import { ConfigSchema, resolveProviderChain } from './config.js';
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

  it('returns 7 when the agent hits max_steps', async () => {
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
    expect(code).toBe(7);
  });

  it('returns 5 when the provider errors with no final answer', async () => {
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream() {
        yield { kind: 'error', code: 'BAD_REQUEST', message: 'nope', retryable: false };
      },
    };
    const code = await runOnce({
      task: 'boom',
      cwd: process.cwd(),
      model: 'mock',
      adapter,
      abortOnSigint: false,
    });
    expect(code).toBe(5);
  });

  it('returns 7 when the agent gets stuck in a repeated loop', async () => {
    // Identical tool call ×3 twice → stuck abort.
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
      maxSteps: 12,
      abortOnSigint: false,
    });
    expect(code).toBe(7);
  });

  it('returns 8 when verification fails after repairs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-verifyfail-'));
    try {
      const adapter = scriptedAdapter([
        [
          { kind: 'message_start' },
          { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
          { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"x.txt","content":"hello"}' },
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
        task: 'write it',
        cwd: dir,
        model: 'mock',
        adapter,
        verify: true,
        verifyCommand: 'node -e "process.exit(1)"',
        maxRepairAttempts: 1,
        abortOnSigint: false,
      });
      expect(code).toBe(8);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forwards the L7 telemetry block as systemSuffix on every step', async () => {
    const seen: Array<{ system: string | undefined; suffix: string | undefined }> = [];
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream(req) {
        seen.push({ system: req.system, suffix: req.systemSuffix });
        if (seen.length === 1) {
          yield { kind: 'message_start' };
          yield { kind: 'tool_call_start', id: 'c1', name: 'shell_exec' };
          yield { kind: 'tool_call_delta', id: 'c1', argsJson: '{"command":"echo hi"}' };
          yield { kind: 'tool_call_end', id: 'c1' };
          yield { kind: 'message_end', finishReason: 'tool_calls' };
        } else {
          yield { kind: 'message_start' };
          yield { kind: 'text_delta', text: 'done' };
          yield { kind: 'message_end', finishReason: 'stop' };
        }
      },
    };
    await runOnce({
      task: 'telemetry-e2e',
      cwd: process.cwd(),
      model: 'mock',
      adapter,
      abortOnSigint: false,
    });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    // Step 1 placeholder; step 2 has the real telemetry line — both as suffix.
    expect(seen[0]?.suffix).toMatch(/no telemetry yet/);
    expect(seen[1]?.suffix).toMatch(/# Runtime telemetry/);
    expect(seen[1]?.suffix).toMatch(/shell_exec echo hi/);
    expect(seen[1]?.system).not.toMatch(/# Runtime telemetry/);
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
      // Legacy final marker still present, then the stable result envelope last.
      expect(parsed.some((e) => e.kind === 'final')).toBe(true);
      const last = parsed[parsed.length - 1];
      expect(last.kind).toBe('result');
      expect(last.status).toBe('complete');
      expect(last.text).toBe('hi');
      expect(typeof last.cost_usd).toBe('number');
      expect(last.usage).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
      expect(typeof last.exit_code).toBe('number');
    });

    it('emits a stable result envelope with cost and usage', async () => {
      const adapter = scriptedAdapter([
        [
          { kind: 'message_start' },
          { kind: 'text_delta', text: 'done' },
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
      const parsed = out.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
      const last = parsed[parsed.length - 1];
      expect(last).toMatchObject({ kind: 'result', status: 'complete', steps: 1 });
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
    it('prints the prompt assembly as JSON and exits 0 without calling the model', async () => {      const stream = vi.fn(async function* () {
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

    it('redacts secrets in task and systemPrompt (sk-ant-XXX → [REDACTED])', async () => {
      const rawKey = 'sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX';
      const adapter: ProviderAdapter = { id: 'mock', stream: vi.fn(async function* () { yield { kind: 'message_start' as const }; }) };
      const { out, value } = await captureStdout(() => runOnce({
        task: `use key ${rawKey} now`,
        cwd: process.cwd(),
        model: 'mock-model',
        adapter,
        dryRun: true,
        abortOnSigint: false,
      }));
      expect(value).toBe(0);
      const report = JSON.parse(out.trim());
      expect(report.task).toContain('[REDACTED');
      expect(report.task).not.toContain(rawKey);
      expect(out).not.toContain(rawKey);
    });
  });

  describe('--bare', () => {
    it('skips MCP, hooks, context, and persistence for deterministic runs', async () => {
      let sawSystem: string | undefined;
      const adapter: ProviderAdapter = {
        id: 'mock',
        async *stream(req) {
          sawSystem = req.system;
          yield { kind: 'message_start' };
          yield { kind: 'text_delta', text: 'bare ok' };
          yield { kind: 'message_end', finishReason: 'stop' };
        },
      };
      const code = await runOnce({
        task: 'bare test',
        cwd: process.cwd(),
        model: 'mock',
        adapter,
        bare: true,
        abortOnSigint: false,
      });
      expect(code).toBe(0);
      // Base prompt only: no L6 context block, no memory block, no KLYRO.md.
      expect(sawSystem ?? '').not.toContain('<context>');
      expect(sawSystem ?? '').not.toContain('<memory>');
      expect(sawSystem ?? '').not.toContain('<KLYRO.md>');
    });
  });

  describe('--agent', () => {
    it('returns 2 for an unknown agent without touching the network', async () => {
      const stream = vi.fn(async function* () {
        yield { kind: 'message_start' as const };
      });
      const adapter: ProviderAdapter = { id: 'mock', stream };
      const code = await runOnce({
        task: 'do things',
        cwd: process.cwd(),
        model: 'mock-model',
        adapter,
        agent: 'no-such-agent',
        abortOnSigint: false,
      });
      expect(code).toBe(2);
      expect(stream).not.toHaveBeenCalled();
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

describe('shouldForceExit (double-Ctrl+C)', () => {
  it('forces exit only when the previous SIGINT is within 1500ms', () => {
    expect(shouldForceExit(undefined, 1000)).toBe(false);
    expect(shouldForceExit(0, 1499)).toBe(true);
    expect(shouldForceExit(0, 1500)).toBe(false);
    expect(shouldForceExit(0, 5000)).toBe(false);
    expect(shouldForceExit(1000, 1000)).toBe(true);
  });
});

describe('providers.failover config + resolveProviderChain', () => {
  const ENV_KEY = 'KLYRO_TEST_FAILOVER_KEY';
  beforeEach(() => { process.env[ENV_KEY] = 'fallback-secret'; });
  afterEach(() => { delete process.env[ENV_KEY]; });

  it('accepts a valid failover list in the zod schema', () => {
    const res = ConfigSchema.safeParse({
      providers: {
        failover: [
          { provider: 'anthropic', apiKeyEnv: ENV_KEY },
          { provider: 'openai', baseURL: 'http://localhost:11434/v1', apiKey: 'local' },
        ],
      },
    });
    expect(res.success).toBe(true);
  });

  it('rejects invalid failover entries (exit-3 validation)', () => {
    expect(ConfigSchema.safeParse({ providers: { failover: [{ provider: 'bogus' }] } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ providers: { failover: 'nope' } }).success).toBe(false);
    expect(ConfigSchema.safeParse({}).success).toBe(true);
  });

  it('resolves primary + failover entries and skips missing-key entries', async () => {
    const chain = await resolveProviderChain(process.cwd(), {
      provider: 'openai',
      apiKey: 'primary-key',
      baseUrl: 'http://primary/v1',
      providers: {
        failover: [
          { provider: 'anthropic', apiKeyEnv: ENV_KEY },
          // No key anywhere — skipped with a stderr reason.
          { provider: 'openai', baseURL: 'http://dead/v1' },
        ],
      },
    });
    expect(chain.length).toBe(2);
    expect(chain[0]).toMatchObject({ provider: 'openai', apiKey: 'primary-key', baseURL: 'http://primary/v1' });
    expect(chain[1]).toMatchObject({ provider: 'anthropic', apiKey: 'fallback-secret' });
  });

  it('resolves apiKeyEnv from the environment', async () => {
    const chain = await resolveProviderChain(process.cwd(), {
      provider: 'openai',
      apiKey: 'primary-key',
      providers: { failover: [{ provider: 'anthropic', baseURL: 'https://api.anthropic.com', apiKeyEnv: ENV_KEY }] },
    });
    expect(chain[1]?.apiKey).toBe('fallback-secret');
    expect(chain[1]?.baseURL).toBe('https://api.anthropic.com');
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
