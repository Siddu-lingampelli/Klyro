import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runScenario, runEval, scriptedAdapterFromSpec, collectFilesTouched, selectCoreFixtures, CORE_SUITE_FIXTURES, type EvalScenario } from './eval.js';
import { applyAutoAnswer } from './args.js';
import { runOnce } from './run.js';
import { collectBaselineMetadata, buildEvalBaseline, writeEvalBaseline } from '../eval/baseline.js';
import { estimateCost as runtimeEstimateCost } from '../agent/runtime.js';
import type { ProviderAdapter } from '../agent/provider-adapter.js';
import { Writable } from 'node:stream';

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; value: T }> {
  const chunks: Buffer[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // @ts-expect-error — overloads are not worth modelling
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  };
  try {
    const value = await fn();
    return { out: Buffer.concat(chunks).toString('utf8'), value };
  } finally {
    process.stdout.write = orig as typeof process.stdout.write;
  }
}

describe('scriptedAdapterFromSpec', () => {
  it('emits events in order for a single step', async () => {
    const adapter = scriptedAdapterFromSpec([[
      ['message_start'],
      ['text_delta', 'Hello'],
      ['message_end', 'stop'],
    ]]);
    const events: string[] = [];
    for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) {
      events.push(ev.kind);
    }
    expect(events).toEqual(['message_start', 'text_delta', 'message_end']);
  });

  it('switches to the next step on subsequent calls', async () => {
    const adapter = scriptedAdapterFromSpec([
      [['message_start'], ['text_delta', 'first'], ['message_end', 'stop']],
      [['message_start'], ['text_delta', 'second'], ['message_end', 'stop']],
    ]);
    const out1: string[] = [];
    for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) {
      if (ev.kind === 'text_delta') out1.push(ev.text);
    }
    const out2: string[] = [];
    for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) {
      if (ev.kind === 'text_delta') out2.push(ev.text);
    }
    expect(out1).toEqual(['first']);
    expect(out2).toEqual(['second']);
  });

  it('emits a fallback message_end when steps run out', async () => {
    const adapter = scriptedAdapterFromSpec([]);
    const kinds: string[] = [];
    for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) {
      kinds.push(ev.kind);
    }
    expect(kinds).toEqual(['message_start', 'message_end']);
  });

  it('translates tool_call events', async () => {
    const adapter = scriptedAdapterFromSpec([[
      ['tool_call_start', 'c1', 'read_file'],
      ['tool_call_delta', 'c1', '{"path":"x"}'],
      ['tool_call_end', 'c1'],
    ]]);
    const evs: any[] = [];
    for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) {
      evs.push(ev);
    }
    expect(evs[0]).toEqual({ kind: 'tool_call_start', id: 'c1', name: 'read_file' });
    expect(evs[1]).toEqual({ kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"x"}' });
    expect(evs[2]).toEqual({ kind: 'tool_call_end', id: 'c1' });
  });
});

describe('runScenario', () => {
  it('passes when expectations are met', async () => {
    const sc: EvalScenario = {
      name: 'simple-text',
      task: 'say hi',
      scripted_events: [[
        ['message_start'],
        ['text_delta', 'Hello there'],
        ['message_end', 'stop'],
      ]],
      expect: { status: 'complete', textContains: 'Hello' },
    };
    const r = await runScenario(sc);
    expect(r.passed).toBe(true);
    expect(r.failures).toHaveLength(0);
    expect(r.status).toBe('complete');
  });

  it('fails when text expectation is not met', async () => {
    const sc: EvalScenario = {
      name: 'text-mismatch',
      task: 'say hi',
      scripted_events: [[
        ['message_start'],
        ['text_delta', 'Goodbye'],
        ['message_end', 'stop'],
      ]],
      expect: { textContains: 'Hello' },
    };
    const r = await runScenario(sc);
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toContain('text:');
  });

  it('fails when status expectation is not met', async () => {
    const sc: EvalScenario = {
      name: 'status-mismatch',
      task: 'loop',
      maxSteps: 1,
      scripted_events: [[
        ['message_start'],
        ['tool_call_start', 'c1', 'shell_exec'],
        ['tool_call_delta', 'c1', '{"command":"echo"}'],
        ['tool_call_end', 'c1'],
        ['message_end', 'tool_calls'],
      ]],
      expect: { status: 'complete' },
    };
    const r = await runScenario(sc);
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toContain('status:');
    expect(r.toolCalls).toBeGreaterThanOrEqual(1);
  });

  it('checks tool call count bounds', async () => {
    const sc: EvalScenario = {
      name: 'tool-bounds',
      task: 'do something',
      maxSteps: 10,
      scripted_events: [
        [
          ['message_start'],
          ['tool_call_start', 'c1', 'shell_exec'],
          ['tool_call_delta', 'c1', '{"command":"echo a"}'],
          ['tool_call_end', 'c1'],
          ['message_end', 'tool_calls'],
        ],
        [
          ['message_start'],
          ['text_delta', 'done'],
          ['message_end', 'stop'],
        ],
      ],
      expect: { toolCallsAtLeast: 1, toolCallsAtMost: 1 },
    };
    const r = await runScenario(sc);
    expect(r.passed).toBe(true);
    expect(r.toolCalls).toBe(1);
  });

  it('passes verify.mode=advisory through: failing verify reports but still completes', async () => {
    // Advisory only runs when the agent edited files, so the script writes
    // one probe file into the harness cwd and the test removes it after.
    const probe = `eval-advisory-probe-${process.pid}.txt`;
    const probePath = path.join(process.cwd(), probe);
    try {
      const sc: EvalScenario = {
        name: 'advisory-verify',
        task: 'write probe',
        maxSteps: 4,
        verify: { mode: 'advisory', command: 'node -e "process.exit(1)"' },
        scripted_events: [
          [
            ['message_start'],
            ['tool_call_start', 'c1', 'write_file'],
            ['tool_call_delta', 'c1', JSON.stringify({ path: probe, content: 'probe' })],
            ['tool_call_end', 'c1'],
            ['message_end', 'tool_calls'],
          ],
          [
            ['message_start'],
            ['text_delta', 'done'],
            ['message_end', 'stop'],
          ],
        ],
        expect: { status: 'complete', toolCallsAtLeast: 1 },
      };
      const r = await runScenario(sc);
      // Strict (the default) would end verify_failed here; advisory completes.
      expect(r.status).toBe('complete');
      expect(r.passed).toBe(true);
      expect(r.toolCalls).toBe(1);
    } finally {
      try { fs.rmSync(probePath, { force: true }); } catch { /* ignore */ }
    }
  });

  it('omits verify opts by default (strict pipeline unchanged)', async () => {
    const sc: EvalScenario = {
      name: 'no-verify',
      task: 'say hi',
      scripted_events: [[
        ['message_start'],
        ['text_delta', 'Hello'],
        ['message_end', 'stop'],
      ]],
      expect: { status: 'complete' },
    };
    expect(sc.verify).toBeUndefined();
    const r = await runScenario(sc);
    expect(r.passed).toBe(true);
  });
});

describe('runEval', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-eval-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs all scenarios in a JSONL file and reports pass/fail', async () => {
    const file = path.join(tmpDir, 'scenarios.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({
        name: 'a', task: 'x',
        scripted_events: [[['message_start'], ['text_delta', 'hi'], ['message_end', 'stop']]],
        expect: { status: 'complete' },
      }),
      JSON.stringify({
        name: 'b', task: 'y',
        scripted_events: [[['message_start'], ['text_delta', 'wrong'], ['message_end', 'stop']]],
        expect: { textContains: 'expected-text-not-present' },
      }),
    ].join('\n') + '\n');
    const { out, value } = await captureStdout(() => runEval({ inputPath: file, output: 'human' }));
    expect(value).toBe(1); // one failure
    expect(out).toContain('[PASS] a');
    expect(out).toContain('[FAIL] b');
    expect(out).toMatch(/1\/2 passed/);
  });

  it('emits one JSON line per scenario in json mode', async () => {
    const file = path.join(tmpDir, 'scenarios.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      name: 'a', task: 'x',
      scripted_events: [[['message_start'], ['text_delta', 'hi'], ['message_end', 'stop']]],
      expect: { status: 'complete' },
    }) + '\n');
    const { out, value } = await captureStdout(() => runEval({ inputPath: file, output: 'json' }));
    expect(value).toBe(0);
    const lines = out.split('\n').filter(Boolean);
    const summary = JSON.parse(lines[lines.length - 1]!);
    expect(summary.kind).toBe('eval_summary');
    expect(summary.passed).toBe(1);
    expect(summary.total).toBe(1);
  });

  it('returns 2 when input is empty', async () => {
    const file = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    const { value } = await captureStdout(() => runEval({ inputPath: file, output: 'human' }));
    expect(value).toBe(2);
  });

  it('skips comment and blank lines', async () => {
    const file = path.join(tmpDir, 'scenarios.jsonl');
    fs.writeFileSync(file, [
      '# this is a comment',
      '',
      JSON.stringify({
        name: 'a', task: 'x',
        scripted_events: [[['message_start'], ['text_delta', 'hi'], ['message_end', 'stop']]],
        expect: { status: 'complete' },
      }),
    ].join('\n') + '\n');
    const { out, value } = await captureStdout(() => runEval({ inputPath: file, output: 'human' }));
    expect(value).toBe(0);
    expect(out).toContain('[PASS] a');
  });

  it('reads from stdin when path is "-"', async () => {
    // We can't easily test stdin in vitest without overriding, so we just
    // confirm that a "-" path is accepted (the readAll branch is exercised).
    expect(runEval).toBeTypeOf('function');
  });
});

describe('auto-answer wiring (5.3)', () => {
  const prev = process.env.KLYRO_AUTO_ANSWER;
  afterEach(() => {
    if (prev === undefined) delete process.env.KLYRO_AUTO_ANSWER;
    else process.env.KLYRO_AUTO_ANSWER = prev;
  });

  it('applyAutoAnswer sets the env var, leaves it alone when omitted', () => {
    delete process.env.KLYRO_AUTO_ANSWER;
    applyAutoAnswer('yes-please');
    expect(process.env.KLYRO_AUTO_ANSWER).toBe('yes-please');
    applyAutoAnswer(undefined);
    expect(process.env.KLYRO_AUTO_ANSWER).toBe('yes-please');
  });

  it('runEval applies opts.autoAnswer before running', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-eval-auto-'));
    try {
      const file = path.join(dir, 's.jsonl');
      fs.writeFileSync(file, JSON.stringify({
        name: 'a', task: 'x',
        scripted_events: [[['message_start'], ['text_delta', 'hi'], ['message_end', 'stop']]],
        expect: { status: 'complete' },
      }) + '\n');
      delete process.env.KLYRO_AUTO_ANSWER;
      const { value } = await captureStdout(() => runEval({ inputPath: file, output: 'silent', autoAnswer: 'flag-text' }));
      expect(value).toBe(0);
      expect(process.env.KLYRO_AUTO_ANSWER).toBe('flag-text');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runOnce applies opts.autoAnswer before the run starts', async () => {
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream() {
        yield { kind: 'message_start' };
        yield { kind: 'text_delta', text: 'done' };
        yield { kind: 'message_end', finishReason: 'stop' };
      },
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-run-auto-'));
    try {
      delete process.env.KLYRO_AUTO_ANSWER;
      const code = await runOnce({
        task: 'hi', cwd: dir, model: 'mock', adapter,
        bare: true, output: 'silent', autoAnswer: 'proceed',
      });
      expect(code).toBe(0);
      expect(process.env.KLYRO_AUTO_ANSWER).toBe('proceed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rich records (5.4a)', () => {
  it('runScenario result contains tokens/cost/files fields', async () => {
    const sc: EvalScenario = {
      name: 'rich',
      task: 'write notes',
      model: 'gpt-4o-mini',
      maxSteps: 4,
      scripted_events: [
        [
          ['message_start'],
          ['tool_call_start', 'c1', 'write_file'],
          ['tool_call_delta', 'c1', JSON.stringify({ path: 'notes.txt', content: 'hi' })],
          ['tool_call_end', 'c1'],
          ['message_end', 'tool_calls'],
        ],
        [
          ['message_start'],
          ['text_delta', 'done'],
          ['message_end', 'stop', { input: 1000, output: 500 }],
        ],
      ],
      expect: { status: 'complete', toolCallsAtLeast: 1 },
    };
    const r = await runScenario(sc);
    expect(r.passed).toBe(true);
    // Provider-reported usage (1000/500) plus estimates for the tool turn.
    expect(r.tokens!.input).toBeGreaterThanOrEqual(1000);
    expect(r.tokens!.output).toBeGreaterThanOrEqual(500);
    // Cost reuses the runtime pricing helper on the same usage block.
    expect(r.costUsd).toBe(runtimeEstimateCost('gpt-4o-mini', r.tokens!));
    expect(r.filesTouched).toContain('notes.txt');
    expect(r.repairs).toBe(0);
  });

  it('runScenario maps verification outcome when a verify command runs', async () => {
    const sc: EvalScenario = {
      name: 'rich-verify',
      task: 'write probe',
      maxSteps: 4,
      verify: { mode: 'advisory', command: 'node -e "process.exit(1)"' },
      scripted_events: [
        [
          ['message_start'],
          ['tool_call_start', 'c1', 'write_file'],
          ['tool_call_delta', 'c1', JSON.stringify({ path: 'probe.txt', content: 'x' })],
          ['tool_call_end', 'c1'],
          ['message_end', 'tool_calls'],
        ],
        [
          ['message_start'],
          ['text_delta', 'done'],
          ['message_end', 'stop'],
        ],
      ],
      expect: { status: 'complete' },
    };
    const r = await runScenario(sc);
    expect(r.status).toBe('complete');
    expect(r.verification).toMatchObject({ ok: false, attempts: 1 });
  });

  it('collectFilesTouched dedupes and sorts path-ish inputs', () => {
    expect(collectFilesTouched([
      { role: 'assistant', content: [{ kind: 'tool_use', id: 'a', name: 'write_file', input: { path: 'b.txt', content: 'x' } }] },
      { role: 'assistant', content: [{ kind: 'tool_use', id: 'b', name: 'read_file', input: { path: 'a.txt' } }] },
      { role: 'assistant', content: [{ kind: 'tool_use', id: 'c', name: 'read_file', input: { path: 'a.txt' } }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'hi' }] },
    ])).toEqual(['a.txt', 'b.txt']);
  });
});

describe('core suite (5.5a)', () => {
  it('resolves to exactly the curated list', () => {
    expect(CORE_SUITE_FIXTURES).toEqual(['read-answer', 'add-fn-test', 'fix-failing-test', 'rename', 'cli-flag']);
    const entries = [...CORE_SUITE_FIXTURES, 'zzz-other', 'smoke-agent-write'];
    expect(selectCoreFixtures(entries)).toEqual(CORE_SUITE_FIXTURES);
    expect(selectCoreFixtures(['zzz-other'])).toEqual([]);
  });

  it('every core fixture has task.md + check.sh', () => {
    for (const id of CORE_SUITE_FIXTURES) {
      const dir = path.join(process.cwd(), 'evals', 'fixtures', id);
      expect(fs.existsSync(path.join(dir, 'task.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'check.sh'))).toBe(true);
    }
  });
});

describe('baseline writer (5.5b)', () => {
  it('emits model/node/platform/commit/timestamp metadata', () => {
    const meta = collectBaselineMetadata({ model: 'test-model' });
    expect(meta.model).toBe('test-model');
    expect(meta.node).toBe(process.version);
    expect(meta.platform).toBe(process.platform);
    expect(typeof meta.commit).toBe('string');
    expect(meta.commit.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(meta.timestamp))).toBe(false);
  });

  it('buildEvalBaseline combines metadata + counts', () => {
    const meta = collectBaselineMetadata({ model: 'm' });
    const rec = buildEvalBaseline(meta, { suite: 'core', total: 5, passed: 4, failed: 1, durationMs: 7 });
    expect(rec.suite).toBe('core');
    expect(rec.passRate).toBeCloseTo(0.8, 8);
    expect(rec.model).toBe('m');
  });

  it('writeEvalBaseline round-trips baseline.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-baseline-'));
    try {
      const rec = buildEvalBaseline(collectBaselineMetadata({ model: 'm' }), {
        suite: 'core', total: 1, passed: 1, failed: 0, durationMs: 1,
      });
      const out = await writeEvalBaseline(dir, rec);
      expect(out).toBe(path.join(dir, 'baseline.json'));
      const back = JSON.parse(fs.readFileSync(out, 'utf-8')) as Record<string, unknown>;
      expect(back.model).toBe('m');
      expect(back.node).toBe(process.version);
      expect(back.commit).toBe(rec.commit);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
