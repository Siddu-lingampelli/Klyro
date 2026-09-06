import { describe, it, expect, vi } from 'vitest';
import { run, defaultSystemPrompt } from './runtime.js';
import { ToolRegistry } from '../tools/registry.js';
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

describe('runtime: level-7 telemetry', () => {
  it('injects the telemetry block into the system prompt on step 2 (after a tool call)', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const seenSystems: (string | undefined)[] = [];
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream(req) {
        seenSystems.push(req.system);
        if (seenSystems.length === 1) {
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
    expect(seenSystems).toHaveLength(2);
    // Step 1 has the "no telemetry yet" placeholder.
    expect(seenSystems[0]).toMatch(/no telemetry yet/);
    // Step 2 must include the prior tool call in its telemetry.
    expect(seenSystems[1]).toMatch(/# Runtime telemetry/);
    expect(seenSystems[1]).toMatch(/Step 2/);
    expect(seenSystems[1]).toMatch(/tool calls: 1/);
    expect(seenSystems[1]).toMatch(/write_file x\.txt/);
    expect(seenSystems[1]).toMatch(/tokens: 100 in \/ 20 out/);
  });

  it('records policy denials into the telemetry visible to subsequent steps', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const seenSystems: (string | undefined)[] = [];
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream(req) {
        seenSystems.push(req.system);
        if (seenSystems.length === 1) {
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
    expect(seenSystems).toHaveLength(2);
    // Step 2 telemetry must reflect that the previous call was denied.
    expect(seenSystems[1]).toMatch(/write_file \.\.\/escape\.txt/);
    expect(seenSystems[1]).toMatch(/ERR/);
    expect(seenSystems[1]).toMatch(/Last error: policy_denied: write_file/);
  });

  it('records user-deny (ask→deny) into the telemetry visible to subsequent steps', async () => {
    const reg = new ToolRegistry().register(readFileTool).register(writeFileTool).register(shellExecTool);
    // shell_exec with a non-allowlisted command goes through 'ask' in
    // interactive mode. We run nonInteractive: false so the policy returns
    // 'ask', and use DenyAllApprovalPrompt so the user denies.
    const policy = new PolicyEngine(builtinRules(), { ...DEFAULT_POLICY_CONFIG, shellAllow: [] });
    const seenSystems: (string | undefined)[] = [];
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream(req) {
        seenSystems.push(req.system);
        if (seenSystems.length === 1) {
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
    expect(seenSystems).toHaveLength(2);
    // The ask→deny branch records both the call (as error) and the user_denied kind.
    expect(seenSystems[1]).toMatch(/shell_exec echo hi/);
    expect(seenSystems[1]).toMatch(/Last error: user_denied: shell_exec/);
  });

  it('records tool execution errors (UNSUPPORTED tool) into the telemetry', async () => {
    // Register only write_file but the model calls read_file → tool error.
    const reg = new ToolRegistry().register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const seenSystems: (string | undefined)[] = [];
    const adapter: ProviderAdapter = {
      id: 'mock',
      async *stream(req) {
        seenSystems.push(req.system);
        if (seenSystems.length === 1) {
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
    expect(seenSystems).toHaveLength(2);
    expect(seenSystems[1]).toMatch(/read_file x\.txt/);
    expect(seenSystems[1]).toMatch(/Last error: UNKNOWN_TOOL: read_file|UNKNOWN_TOOL/);
    expect(seenSystems[1]).toMatch(/errors: 1/);
  });
});
