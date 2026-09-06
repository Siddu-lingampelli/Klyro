import { describe, it, expect, vi } from 'vitest';
import { run, defaultSystemPrompt } from './runtime.js';
import { ToolRegistry } from '../tools/registry.js';
import { readFileTool } from '../tools/fs/read-file.js';
import { writeFileTool } from '../tools/fs/write-file.js';
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
