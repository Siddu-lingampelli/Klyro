import { describe, it, expect, vi, afterEach } from 'vitest';
import { run, defaultSystemPrompt, estimateCost } from './runtime.js';
import { ToolRegistry } from '../tools/registry.js';
import * as fs from 'node:fs';
import { readFileTool } from '../tools/fs/read-file.js';
import { writeFileTool } from '../tools/fs/write-file.js';
import { shellExecTool } from '../tools/shell/shell-exec.js';
import { PolicyEngine, builtinRules, DEFAULT_POLICY_CONFIG } from '../policy/engine.js';
import { DenyAllApprovalPrompt } from '../policy/approval.js';
import type { ProviderAdapter, StreamEvent } from './provider-adapter.js';
import type { ToolContext } from '../tools/types.js';
import type { Message } from './message.js';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Mock adapter that returns a scripted sequence of StreamEvents. Lets us
 * drive the runtime loop deterministically without a real provider.
 */
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

const tmp = os.tmpdir();
const cwd = path.join(tmp, 'klyro-rt-' + Math.random().toString(36).slice(2));

describe('runtime', () => {
  it('completes when assistant returns text-only final answer', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'Task done.' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const r = await run(
      { task: 'say hi', cwd, model: 'mock', maxSteps: 3, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(r.status).toBe('complete');
    expect(r.finalText).toBe('Task done.');
  });

  it('emits thinking deltas but keeps them out of the final text', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'thinking_delta', text: 'considering options…' },
        { kind: 'text_delta', text: 'Final answer.' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const seen: string[] = [];
    const r = await run(
      {
        task: 'say hi', cwd, model: 'mock', maxSteps: 3, nonInteractive: true,
        onEvent: (ev) => { if (ev.kind === 'thinking_delta') seen.push(ev.text); },
      },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(r.status).toBe('complete');
    expect(seen).toEqual(['considering options…']);
    expect(r.finalText).toBe('Final answer.');
    expect(r.transcript.some((m) => JSON.stringify(m.content).includes('considering'))).toBe(false);
  });

  it('executes a tool call then completes', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
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
        { kind: 'text_delta', text: 'wrote x.txt' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const r = await run(
      { task: 'write x.txt', cwd, model: 'mock', maxSteps: 3, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(r.status).toBe('complete');
    expect(r.toolCalls).toBe(1);
  });

  it('runs concurrencySafe tools in parallel but commits results in call order', async () => {
    const { z } = await import('zod');
    const { defineTool } = await import('../tools/types.js');
    // Both tools block until released: if execution were sequential, the
    // second execute would never start before the first finished.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started: string[] = [];
    const mkProbe = (name: string) => defineTool({
      name,
      description: 'parallelism probe',
      inputSchema: z.object({}),
      permission: 'read' as const,
      isConcurrencySafe: true,
      execute: async () => {
        started.push(name);
        await gate;
        return { ok: true as const, value: { name } };
      },
    });
    const reg = new ToolRegistry().register(mkProbe('probe_a')).register(mkProbe('probe_b'));
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'probe_a' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'tool_call_start', id: 'c2', name: 'probe_b' },
        { kind: 'tool_call_delta', id: 'c2', argsJson: '{}' },
        { kind: 'tool_call_end', id: 'c2' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'done' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const task = run(
      { task: 'probe', cwd, model: 'mock', maxSteps: 3, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    // Let the runtime reach the parallel execute phase, then assert overlap.
    await new Promise((r) => setTimeout(r, 100));
    expect(started.sort()).toEqual(['probe_a', 'probe_b']);
    release();
    const r = await task;
    expect(r.status).toBe('complete');
    expect(r.toolCalls).toBe(2);
    // Transcript order matches call order despite concurrent execution.
    const toolMsgs = r.transcript.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBe(2);
    expect(JSON.stringify(toolMsgs[0])).toContain('probe_a');
    expect(JSON.stringify(toolMsgs[1])).toContain('probe_b');
  });

  it('feeds policy denial back as a tool_result', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"../escape.txt","content":"x"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'OK' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const r = await run(
      { task: 'escape', cwd, model: 'mock', maxSteps: 3, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(r.status).toBe('complete');
    // The tool_result for c1 must be a policy denial.
    const toolMsg = r.transcript.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const block = toolMsg!.content[0] as { kind: string; isError?: boolean; output: unknown };
    expect(block.kind).toBe('tool_result');
    expect(block.isError).toBe(true);
  });

  it('returns max_steps when the model never finishes', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    // Always emit a tool call; never finalize.
    const adapter = scriptedAdapter(
      Array.from({ length: 10 }, () => [
        { kind: 'message_start' } as StreamEvent,
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' } as StreamEvent,
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"a.txt","content":"x"}' } as StreamEvent,
        { kind: 'tool_call_end', id: 'c1' } as StreamEvent,
        { kind: 'message_end', finishReason: 'tool_calls' } as StreamEvent,
      ]),
    );
    const r = await run(
      { task: 'loop', cwd, model: 'mock', maxSteps: 3, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(r.status).toBe('max_steps');
    expect(r.steps).toBe(3);
  });

  it('returns aborted when signal aborts', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const ac = new AbortController();
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream() {
        ac.abort();
        yield { kind: 'message_start' };
      },
    };
    const r = await run(
      { task: 'abort', cwd, model: 'mock', maxSteps: 3, nonInteractive: true, signal: ac.signal },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(r.status).toBe('aborted');
  });

  it('emits onEvent for text deltas, tool call lifecycle, and final text', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'Hel' },
        { kind: 'text_delta', text: 'lo' },
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"x.txt","content":"y"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: ' done' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const kinds: string[] = [];
    await run(
      {
        task: 'x', cwd, model: 'mock', maxSteps: 3, nonInteractive: true,
        onEvent: (ev) => { kinds.push(ev.kind); },
      },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    // Expected sequence: step_start, text_delta, text_delta, tool_call_start,
    // tool_call_delta, tool_call_end, policy_decision, tool_result, step_end,
    // step_start, text_delta, final_text, step_end
    expect(kinds[0]).toBe('step_start');
    expect(kinds).toContain('text_delta');
    expect(kinds).toContain('tool_call_start');
    expect(kinds).toContain('tool_call_delta');
    expect(kinds).toContain('tool_call_end');
    expect(kinds).toContain('policy_decision');
    expect(kinds).toContain('tool_result');
    expect(kinds).toContain('final_text');
    const lastIdx = kinds.lastIndexOf('final_text');
    expect(kinds.slice(lastIdx + 1)).toEqual(['step_end']);
  });

  it('uses initialTranscript as the seed and appends task as a new user turn', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    // Capture what the adapter actually receives as the first messages.
    let received: Message[] | undefined;
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream(req) {
        received = req.messages;
        yield { kind: 'message_start' };
        yield { kind: 'text_delta', text: 'resumed' };
        yield { kind: 'message_end', finishReason: 'stop' };
      },
    };
    const prior: Message[] = [
      { role: 'user', content: [{ kind: 'text', text: 'first turn' }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'first answer' }] },
    ];
    await run(
      {
        task: 'second turn',
        cwd,
        model: 'mock',
        maxSteps: 1,
        nonInteractive: true,
        initialTranscript: prior,
      },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(received).toBeDefined();
    // The runtime must send the prior 2 messages + the new task + the
    // assistant response it will generate (snapshotted before the loop
    // appends it to the local transcript).
    expect(received!.length).toBeGreaterThanOrEqual(3);
    expect(received![0]?.content[0]).toMatchObject({ kind: 'text', text: 'first turn' });
    expect(received![1]?.content[0]).toMatchObject({ kind: 'text', text: 'first answer' });
    expect(received![2]?.content[0]).toMatchObject({ kind: 'text', text: 'second turn' });
  });

  it('starts with just the task when initialTranscript is omitted (no regression)', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    let received: Message[] | undefined;
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream(req) {
        received = req.messages;
        yield { kind: 'message_start' };
        yield { kind: 'text_delta', text: 'ok' };
        yield { kind: 'message_end', finishReason: 'stop' };
      },
    };
    await run(
      { task: 'only', cwd, model: 'mock', maxSteps: 1, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(received).toBeDefined();
    // The captured snapshot is what the adapter sees at the start of the
    // step. Before the loop pushes the assistant response, the seed is
    // just the single user message.
    expect(received!.length).toBeGreaterThanOrEqual(1);
    expect(received![0]?.content[0]).toMatchObject({ kind: 'text', text: 'only' });
  });
});

describe('runtime: repair ledger, verify modes, overflow, drain', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function freshDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-rt2-'));
    tmpDirs.push(d);
    return d;
  }
  function stdDeps(adapter: ProviderAdapter) {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    return { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt };
  }
  function countingAdapter(batches: StreamEvent[][], counter: { calls: number }): ProviderAdapter {
    let i = 0;
    return {
      id: 'mock',
      async *stream() {
        counter.calls++;
        const batch = batches[i++];
        if (batch) for (const ev of batch) yield ev;
      },
    };
  }
  /** Verify command that exits 1 (printing plain 'boom') for the first
   * `fails` invocations, then exits 0. Plain output keeps detect() at
   * 'unknown' so classify() yields 'introduced' (not pre-existing). */
  function failThenPassCommand(dir: string, fails: number): string {
    const counter = path.join(dir, 'count.txt').replace(/\\/g, '/');
    fs.writeFileSync(counter, '0');
    return `${JSON.stringify(process.execPath)} -e "var fs=require('fs');var n=parseInt(fs.readFileSync('${counter}','utf8'),10);fs.writeFileSync('${counter}',String(n+1));if(n<${fails}){console.error('boom');process.exit(1)}"`;
  }
  function writeThenDone(): StreamEvent[][] {
    return [
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
    ];
  }

  it('attributes repairTokens on a fail-then-pass strict run', async () => {
    const dir = freshDir();
    // Invocations before the repair turn: baseline(1) + verify#1(1) +
    // flaky-rerun(1) = 3 failures; the post-repair verify then passes.
    const command = failThenPassCommand(dir, 3);
    const counter = { calls: 0 };
    const adapter = countingAdapter([...writeThenDone(), [
      { kind: 'message_start' },
      { kind: 'text_delta', text: 'fixed' },
      { kind: 'message_end', finishReason: 'stop' },
    ]], counter);
    const r = await run(
      { task: 'write it', cwd: dir, model: 'mock', maxSteps: 6, nonInteractive: true, verify: { enabled: true, command, maxRepairAttempts: 3 } },
      stdDeps(adapter),
    );
    expect(r.status).toBe('complete');
    expect(r.verification?.ok).toBe(true);
    expect(r.verification?.attempts).toBe(1);
    expect(r.verification?.repairTokens).toBeDefined();
    expect(r.verification!.repairTokens!.input + r.verification!.repairTokens!.output).toBeGreaterThan(0);
    expect(counter.calls).toBe(3);
  });

  it("verify off skips the pipeline (verification undefined, no repair)", async () => {
    const dir = freshDir();
    const counter = { calls: 0 };
    const adapter = countingAdapter(writeThenDone(), counter);
    const kinds: string[] = [];
    const r = await run(
      {
        task: 'write it', cwd: dir, model: 'mock', maxSteps: 4, nonInteractive: true,
        verify: { enabled: true, command: failThenPassCommand(dir, 999), mode: 'off' },
        onEvent: (ev) => { kinds.push(ev.kind); },
      },
      stdDeps(adapter),
    );
    expect(r.status).toBe('complete');
    expect(r.verification).toBeUndefined();
    expect(counter.calls).toBe(2);
    expect(kinds).not.toContain('verification_started');
  });

  it('verify advisory reports failure once and completes without repair turns', async () => {
    const dir = freshDir();
    const counter = { calls: 0 };
    const adapter = countingAdapter(writeThenDone(), counter);
    const kinds: string[] = [];
    const r = await run(
      {
        task: 'write it', cwd: dir, model: 'mock', maxSteps: 4, nonInteractive: true,
        verify: { enabled: true, command: failThenPassCommand(dir, 999), mode: 'advisory' },
        onEvent: (ev) => { kinds.push(ev.kind); },
      },
      stdDeps(adapter),
    );
    expect(r.status).toBe('complete');
    expect(r.verification?.ok).toBe(false);
    expect(counter.calls).toBe(2);
    expect(kinds).not.toContain('repair_started');
  });

  it('verify advisory success completes ok', async () => {
    const dir = freshDir();
    const counter = { calls: 0 };
    const adapter = countingAdapter(writeThenDone(), counter);
    const r = await run(
      {
        task: 'write it', cwd: dir, model: 'mock', maxSteps: 4, nonInteractive: true,
        verify: { enabled: true, command: failThenPassCommand(dir, 0), mode: 'advisory' },
      },
      stdDeps(adapter),
    );
    expect(r.status).toBe('complete');
    expect(r.verification?.ok).toBe(true);
    expect(counter.calls).toBe(2);
  });

  it('verify strict exhausts repairs into verify_failed', async () => {
    const dir = freshDir();
    const counter = { calls: 0 };
    const adapter = countingAdapter(writeThenDone(), counter);
    const r = await run(
      {
        task: 'write it', cwd: dir, model: 'mock', maxSteps: 4, nonInteractive: true,
        verify: { enabled: true, command: failThenPassCommand(dir, 999), maxRepairAttempts: 1 },
      },
      stdDeps(adapter),
    );
    expect(r.status).toBe('verify_failed');
    expect(r.verification?.ok).toBe(false);
    expect(r.verification?.attempts).toBe(1);
  });

  it('retries the request once after REQUEST_TOO_LARGE then completes', async () => {
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream() {
        calls++;
        if (calls === 1) {
          yield { kind: 'error', code: 'REQUEST_TOO_LARGE', message: 'context too big', retryable: false };
          return;
        }
        yield { kind: 'message_start' };
        yield { kind: 'text_delta', text: 'recovered' };
        yield { kind: 'message_end', finishReason: 'stop' };
      },
    };
    const r = await run(
      { task: 'x', cwd, model: 'mock', maxSteps: 3, nonInteractive: true },
      stdDeps(adapter),
    );
    expect(r.status).toBe('complete');
    expect(r.finalText).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('fails normally on a second REQUEST_TOO_LARGE', async () => {
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream() {
        calls++;
        yield { kind: 'error', code: 'REQUEST_TOO_LARGE', message: 'still too big', retryable: false };
      },
    };
    const r = await run(
      { task: 'x', cwd, model: 'mock', maxSteps: 3, nonInteractive: true },
      stdDeps(adapter),
    );
    expect(r.status).toBe('no_final');
    expect(calls).toBe(2);
  });

  it('injects drained subtask completions as user messages', async () => {
    const dir = freshDir();
    const bridge = {
      drainCompletions: () => [{
        taskId: 't-1',
        agentName: 'explorer',
        status: 'succeeded',
        durationMs: 12,
        finalText: 'mapped the repo',
        changedFiles: ['a.ts'],
      }],
    } as unknown as import('./orchestrator.js').AgentSpawnBridge;
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"y.txt","content":"hi"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'done' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const r = await run(
      { task: 'probe', cwd: dir, model: 'mock', maxSteps: 3, nonInteractive: true, agentBridge: bridge },
      stdDeps(adapter),
    );
    expect(r.status).toBe('complete');
    expect(JSON.stringify(r.transcript)).toContain('Subtask t-1 (explorer) succeeded: mapped the repo');
  });
});

describe('runtime: level-7 telemetry', () => {
  it('injects the telemetry block as systemSuffix on step 2 (stable system stays clean)', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const seen: Array<{ system: string | undefined; suffix: string | undefined }> = [];
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream(req) {
        seen.push({ system: req.system, suffix: req.systemSuffix });
        if (seen.length === 1) {
          // Step 1: emit a tool call, then end.
          yield { kind: 'message_start' };
          yield { kind: 'tool_call_start', id: 'c1', name: 'write_file' };
          yield { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"x.txt","content":"y"}' };
          yield { kind: 'tool_call_end', id: 'c1' };
          yield { kind: 'message_end', finishReason: 'tool_calls', usage: { input: 100, output: 20 } };
        } else {
          // Step 2: final answer.
          yield { kind: 'message_start' };
          yield { kind: 'text_delta', text: 'done' };
          yield { kind: 'message_end', finishReason: 'stop' };
        }
      },
    };
    const r = await run(
      { task: 'telemetry', cwd, model: 'mock', maxSteps: 4, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(r.status).toBe('complete');
    expect(seen).toHaveLength(2);
    // Step 1 has the "no telemetry yet" placeholder as the suffix.
    expect(seen[0]?.suffix).toMatch(/no telemetry yet/);
    // Step 2 must include the prior tool call in its telemetry suffix.
    expect(seen[1]?.suffix).toMatch(/# Runtime telemetry/);
    expect(seen[1]?.suffix).toMatch(/Step 2/);
    expect(seen[1]?.suffix).toMatch(/tool calls: 1/);
    expect(seen[1]?.suffix).toMatch(/write_file x\.txt/);
    expect(seen[1]?.suffix).toMatch(/tokens: 100 in \/ 20 out/);
    // The stable system prefix stays telemetry-free (cache-friendly split).
    expect(seen[1]?.system).not.toMatch(/# Runtime telemetry/);
    expect(seen[1]?.system).toMatch(/autonomous coding harness/);
  });

  it('records policy denials into the telemetry suffix visible to subsequent steps', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const seen: Array<{ system: string | undefined; suffix: string | undefined }> = [];
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream(req) {
        seen.push({ system: req.system, suffix: req.systemSuffix });
        if (seen.length === 1) {
          yield { kind: 'message_start' };
          yield { kind: 'tool_call_start', id: 'c1', name: 'write_file' };
          yield { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"../escape.txt","content":"x"}' };
          yield { kind: 'tool_call_end', id: 'c1' };
          yield { kind: 'message_end', finishReason: 'tool_calls' };
        } else {
          yield { kind: 'message_start' };
          yield { kind: 'text_delta', text: 'ok' };
          yield { kind: 'message_end', finishReason: 'stop' };
        }
      },
    };
    await run(
      { task: 'telemetry-deny', cwd, model: 'mock', maxSteps: 4, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(seen).toHaveLength(2);
    // Step 2 telemetry must reflect that the previous call was denied.
    expect(seen[1]?.suffix).toMatch(/write_file \.\.\/escape\.txt/);
    expect(seen[1]?.suffix).toMatch(/ERR/);
    expect(seen[1]?.suffix).toMatch(/Last error: policy_denied: write_file/);
    expect(seen[1]?.system).not.toMatch(/Last error/);
  });

  it('records user-deny (ask→deny) into the telemetry visible to subsequent steps', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool).register(shellExecTool);
    // shell_exec with a non-allowlisted command goes through 'ask' in
    // interactive mode. We run nonInteractive: false so the policy returns
    // 'ask', and use DenyAllApprovalPrompt so the user denies.
    const policy = new PolicyEngine(builtinRules(), { ...DEFAULT_POLICY_CONFIG, shellAllow: [] });
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
          yield { kind: 'text_delta', text: 'ok' };
          yield { kind: 'message_end', finishReason: 'stop' };
        }
      },
    };
    await run(
      { task: 'telemetry-ask-deny', cwd, model: 'mock', maxSteps: 4, nonInteractive: false },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(seen).toHaveLength(2);
    // The ask→deny branch records both the call (as error) and the user_denied kind.
    expect(seen[1]?.suffix).toMatch(/shell_exec echo hi/);
    expect(seen[1]?.suffix).toMatch(/Last error: user_denied: shell_exec/);
  });

  it('never executes malformed tool calls — structured MALFORMED_TOOL_CALL instead', async () => {
    const { z } = await import('zod');
    const { defineTool } = await import('../tools/types.js');
    let executed = 0;
    const reg = new ToolRegistry().register(defineTool({
      name: 'probe_exec',
      description: 'must not run',
      inputSchema: z.object({ path: z.string() }),
      permission: 'read' as const,
      isConcurrencySafe: true,
      execute: async () => { executed++; return { ok: true as const, value: {} }; },
    }));
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'probe_exec' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'ok' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const r = await run(
      { task: 'malformed', cwd, model: 'mock', maxSteps: 3, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(executed).toBe(0);
    expect(r.toolCalls).toBe(0);
    const toolMsgs = r.transcript.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBe(1);
    expect(JSON.stringify(toolMsgs[0])).toContain('MALFORMED_TOOL_CALL');
  });

  it('rejects schema-invalid arguments without executing', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"x.txt"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'ok' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const r = await run(
      { task: 'schemabad', cwd, model: 'mock', maxSteps: 3, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(r.toolCalls).toBe(0);
    expect(JSON.stringify(r.transcript)).toContain('MALFORMED_TOOL_CALL');
  });

  it('estimates usage when the provider omits it, flags estimated', async () => {
    const reg = new ToolRegistry().register(readFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'hello there' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const seen: Array<{ input: number; output: number; estimated?: boolean }> = [];
    const r = await run(
      {
        task: 'estimate me', cwd, model: 'mock', maxSteps: 2, nonInteractive: true,
        onEvent: (ev) => { if (ev.kind === 'usage') seen.push({ input: ev.input, output: ev.output, estimated: ev.estimated }); },
      },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(r.status).toBe('complete');
    expect(r.usage.input).toBeGreaterThan(0);
    expect(r.usage.output).toBeGreaterThan(0);
    expect(r.usage.estimated).toBe(true);
    expect(seen[0]?.estimated).toBe(true);
  });

  it('prefers provider-reported usage over estimates', async () => {
    const reg = new ToolRegistry().register(readFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'hi' },
        { kind: 'message_end', finishReason: 'stop', usage: { input: 100, output: 20 } },
      ],
    ]);
    const r = await run(
      { task: 'reported', cwd, model: 'mock', maxSteps: 2, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(r.usage).toMatchObject({ input: 100, output: 20 });
    expect(r.usage.estimated).toBeUndefined();
  });

  it('records tool execution errors (UNSUPPORTED tool) into the telemetry suffix', async () => {
    // Register only write_file but the model calls read_file → tool error.
    const reg = new ToolRegistry().register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const seen: Array<{ system: string | undefined; suffix: string | undefined }> = [];
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream(req) {
        seen.push({ system: req.system, suffix: req.systemSuffix });
        if (seen.length === 1) {
          yield { kind: 'message_start' };
          yield { kind: 'tool_call_start', id: 'c1', name: 'read_file' };
          yield { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"x.txt"}' };
          yield { kind: 'tool_call_end', id: 'c1' };
          yield { kind: 'message_end', finishReason: 'tool_calls' };
        } else {
          yield { kind: 'message_start' };
          yield { kind: 'text_delta', text: 'ok' };
          yield { kind: 'message_end', finishReason: 'stop' };
        }
      },
    };
    await run(
      { task: 'telemetry-tool-err', cwd, model: 'mock', maxSteps: 4, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(seen).toHaveLength(2);
    expect(seen[1]?.suffix).toMatch(/read_file x\.txt/);
    expect(seen[1]?.suffix).toMatch(/Last error: UNKNOWN_TOOL: read_file|UNKNOWN_TOOL/);
    expect(seen[1]?.suffix).toMatch(/errors: 1/);
  });

  it('sums cacheRead/cacheWrite across turns and keeps cost on input/output', async () => {
    const reg = new ToolRegistry().register(readFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'hi' },
        { kind: 'message_end', finishReason: 'stop', usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 30 } },
      ],
    ]);
    const usageEvents: Array<{ input: number; output: number; cacheRead?: number; cacheWrite?: number }> = [];
    const r = await run(
      {
        task: 'cached', cwd, model: 'mock', maxSteps: 2, nonInteractive: true,
        onEvent: (ev) => { if (ev.kind === 'usage') usageEvents.push({ input: ev.input, output: ev.output, ...(ev.cacheRead !== undefined ? { cacheRead: ev.cacheRead } : {}), ...(ev.cacheWrite !== undefined ? { cacheWrite: ev.cacheWrite } : {}) }); },
      },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(r.status).toBe('complete');
    expect(r.usage).toMatchObject({ input: 100, output: 20, cacheRead: 50, cacheWrite: 30 });
    expect(usageEvents[0]).toMatchObject({ cacheRead: 50, cacheWrite: 30 });
    // Cost ignores cache counters (discounted billing, unmodeled).
    expect(estimateCost('mock', r.usage)).toBe(estimateCost('mock', { input: 100, output: 20 }));
  });

  it('accepts a legacy string systemPrompt fn (backward compat)', async () => {
    const reg = new ToolRegistry().register(readFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    let received: { system?: string; suffix?: string } | undefined;
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream(req) {
        received = { system: req.system, suffix: req.systemSuffix };
        yield { kind: 'message_start' };
        yield { kind: 'text_delta', text: 'ok' };
        yield { kind: 'message_end', finishReason: 'stop' };
      },
    };
    const r = await run(
      { task: 'legacy', cwd, model: 'mock', maxSteps: 1, nonInteractive: true },
      {
        adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(),
        systemPrompt: ({ cwd: c }: { cwd: string; telemetry?: string }) => `legacy prompt cwd=${c}`,
      },
    );
    expect(r.status).toBe('complete');
    expect(received?.system).toBe(`legacy prompt cwd=${cwd}`);
    expect(received?.suffix).toBeUndefined();
  });
});
