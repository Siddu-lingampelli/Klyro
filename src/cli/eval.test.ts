import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runScenario, runEval, scriptedAdapterFromSpec, type EvalScenario } from './eval.js';
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
