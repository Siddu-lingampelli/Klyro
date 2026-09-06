/**
 * Agent runtime — the core autonomous loop.
 *
 * Loop:
 *   1. Build a CallRequest from the current transcript + system prompt.
 *   2. Stream from the provider; collect text + tool calls.
 *   3. If the assistant produced no tool calls, treat as final answer.
 *   4. Otherwise, evaluate policy for each call, execute (or deny), feed
 *      tool_results back as the next user message.
 *   5. Repeat up to maxSteps. Cap at maxSteps to avoid runaway costs.
 *
 * Stream cancellation: pass `signal` to abort mid-step.
 *
 * The runtime is intentionally provider-agnostic — it only sees the
 * normalized StreamEvent shape from ProviderAdapter.
 */

import type { ProviderAdapter, StreamEvent, ToolDefinition } from './provider-adapter.js';
import type { Message, ToolUseBlock } from './message.js';
import { text, toolUse, toolResult as mkToolResult } from './message.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { ApprovalPrompt } from '../policy/approval.js';
import { redact } from '../policy/secret-redactor.js';
import { RuntimeTelemetry, emptyTelemetryBlock, summarizeToolCall } from '../context/level7.js';

export interface RuntimeDeps {
  adapter: ProviderAdapter;
  registry: ToolRegistry;
  policy: PolicyEngine;
  approval: ApprovalPrompt;
  /**
   * Build a system prompt given cwd + the current Level-7 runtime telemetry.
   * The telemetry block is a compact, in-memory summary of the run so far
   * (step count, last tool calls, recent errors). Injected as part of the
   * system prompt so the model can see its own state mid-run.
   */
  systemPrompt: (ctx: { cwd: string; telemetry?: string }) => string;
}

export interface RunOptions {
  task: string;
  cwd: string;
  model: string;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  nonInteractive: boolean;
  /**
   * Optional pre-existing transcript to seed the conversation. When set,
   * the runtime skips the initial `[{role:'user', content:[text(task)]}]`
   * and starts with this list instead. Used for `--resume` and tests.
   *
   * If provided AND `task` is set, the task is appended as a new user
   * message at the end (so resume+continue works naturally).
   */
  initialTranscript?: Message[];
  /**
   * Optional hook for live UIs (e.g. the TUI). Fires for every observable
   * event the runtime processes: text deltas, tool-call boundaries,
   * policy decisions, observation results, and step boundaries. Callers
   * that don't pass it pay zero cost.
   */
  onEvent?: (ev: RuntimeEvent) => void;
}

/** High-level event stream the runtime emits. Safe for UI consumption. */
export type RuntimeEvent =
  | { kind: 'step_start'; step: number }
  | { kind: 'step_end'; step: number }
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_call_start'; id: string; name: string }
  | { kind: 'tool_call_delta'; id: string; argsJson: string }
  | { kind: 'tool_call_end'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'policy_decision'; id: string; name: string; action: 'allow' | 'ask' | 'deny'; reason?: string }
  | { kind: 'tool_result'; id: string; name: string; output: unknown; isError: boolean; latencyMs: number }
  | { kind: 'usage'; input: number; output: number }
  | { kind: 'final_text'; text: string }
  | { kind: 'aborted' };

export interface RunResult {
  status: 'complete' | 'max_steps' | 'aborted' | 'no_final';
  steps: number;
  toolCalls: number;
  finalText: string;
  transcript: Message[];
  usage: { input: number; output: number };
  /** Number of policy-driven user prompts the user accepted. */
  repairs?: number;
}

const DEFAULT_MAX_STEPS = 30;

/** Convert a registry of tools into ToolDefinitions for the provider. */
export function toolDefinitions(registry: ToolRegistry): ToolDefinition[] {
  return registry.toOpenAITools().map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
  }));
}

/** Run the autonomous loop. */
export async function run(opts: RunOptions, deps: RuntimeDeps): Promise<RunResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const transcript: Message[] = opts.initialTranscript
    ? [...opts.initialTranscript, { role: 'user', content: [text(opts.task)] }]
    : [{ role: 'user', content: [text(opts.task)] }];
  const usage = { input: 0, output: 0 };
  let steps = 0;
  let toolCallCount = 0;
  let finalText = '';
  let repairs = 0;
  const emit = opts.onEvent;
  const telemetry = new RuntimeTelemetry();
  telemetry.setMaxSteps(maxSteps);

  outer: while (steps < maxSteps) {
    if (opts.signal?.aborted) {
      emit?.({ kind: 'aborted' });
      return { status: 'aborted', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs };
    }
    steps++;
    emit?.({ kind: 'step_start', step: steps });
    telemetry.recordStepStart(steps);

    const req = {
      model: opts.model,
      system: deps.systemPrompt({ cwd: opts.cwd, telemetry: steps === 1 ? emptyTelemetryBlock() : telemetry.format() }),
      messages: transcript,
      tools: toolDefinitions(deps.registry),
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };

    const events = deps.adapter.stream(req);
    let textBuf = '';
    const pendingToolCalls = new Map<string, { id: string; name: string; argsJson: string }>();
    let lastFinishReason: string | undefined;

    for await (const ev of events) {
      if (opts.signal?.aborted) break outer;
      if (ev.kind === 'text_delta') {
        textBuf += ev.text;
        emit?.({ kind: 'text_delta', text: ev.text });
      } else if (ev.kind === 'tool_call_start') {
        pendingToolCalls.set(ev.id, { id: ev.id, name: ev.name, argsJson: '' });
        emit?.({ kind: 'tool_call_start', id: ev.id, name: ev.name });
      } else if (ev.kind === 'tool_call_delta') {
        const tc = pendingToolCalls.get(ev.id);
        if (tc) tc.argsJson += ev.argsJson;
        emit?.({ kind: 'tool_call_delta', id: ev.id, argsJson: ev.argsJson });
      } else if (ev.kind === 'tool_call_end') {
        // tool_calls are accumulated; finalization happens after stream.
      } else if (ev.kind === 'message_end') {
        lastFinishReason = ev.finishReason;
        if (ev.usage) {
          usage.input += ev.usage.input;
          usage.output += ev.usage.output;
          telemetry.recordUsage(ev.usage.input, ev.usage.output);
          emit?.({ kind: 'usage', input: usage.input, output: usage.output });
        }
      } else if (ev.kind === 'error') {
        telemetry.recordError(`stream_error: ${ev.code}`);
        return {
          status: 'no_final',
          steps,
          toolCalls: toolCallCount,
          finalText: textBuf,
          transcript,
          usage,
        };
      }
    }

    // Build the assistant message.
    const assistantContent: Message['content'] = [];
    if (textBuf) assistantContent.push(text(textBuf));
    const finalizedCalls: ToolUseBlock[] = [];
    for (const tc of pendingToolCalls.values()) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.argsJson || '{}');
      } catch {
        input = { _parse_error: true, raw: tc.argsJson };
      }
      finalizedCalls.push(toolUse(tc.id, tc.name, input));
      assistantContent.push(toolUse(tc.id, tc.name, input));
      emit?.({ kind: 'tool_call_end', id: tc.id, name: tc.name, input });
    }
    transcript.push({ role: 'assistant', content: assistantContent });

    // No tool calls → done.
    if (opts.signal?.aborted) {
      finalText = textBuf;
      emit?.({ kind: 'aborted' });
      return { status: 'aborted', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs };
    }
    if (finalizedCalls.length === 0) {
      finalText = textBuf;
      emit?.({ kind: 'final_text', text: finalText });
      emit?.({ kind: 'step_end', step: steps });
      return { status: 'complete', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs };
    }

    // Execute each tool call (after policy).
    const toolCtx: ToolContext = {
      cwd: opts.cwd,
      env: process.env,
      signal: opts.signal,
      nonInteractive: opts.nonInteractive,
    };
    for (const call of finalizedCalls) {
      toolCallCount++;
      const decision = await deps.policy.evaluate(
        { name: call.name, input: call.input },
        { cwd: opts.cwd, nonInteractive: opts.nonInteractive },
      );
      emit?.({ kind: 'policy_decision', id: call.id, name: call.name, action: decision.action, ...(decision.action !== 'allow' ? { reason: decision.reason } : {}) });

      if (decision.action === 'deny') {
        transcript.push({
          role: 'tool',
          content: [
            mkToolResult(call.id, call.name, { error: 'POLICY_DENIED', reason: decision.reason }, true),
          ],
        });
        telemetry.recordToolError(call, 'policy_denied');
        emit?.({ kind: 'tool_result', id: call.id, name: call.name, output: { error: 'POLICY_DENIED', reason: decision.reason }, isError: true, latencyMs: 0 });
        continue;
      }

      if (decision.action === 'ask') {
        const choice = await deps.approval.ask({
          toolName: call.name,
          reason: decision.reason,
          summary: summarizeToolCall(call),
        });
        if (choice === 'deny') {
          transcript.push({
            role: 'tool',
            content: [
              mkToolResult(call.id, call.name, { error: 'POLICY_DENIED', reason: 'user denied' }, true),
            ],
          });
          telemetry.recordToolError(call, 'user_denied');
          emit?.({ kind: 'tool_result', id: call.id, name: call.name, output: { error: 'POLICY_DENIED', reason: 'user denied' }, isError: true, latencyMs: 0 });
          continue;
        }
        repairs++;
      }

      const t0 = Date.now();
      const obs = await deps.registry.execute(call.name, call.input, toolCtx);
      const latencyMs = Date.now() - t0;
      const output = obs.ok ? redactOutput(obs.value) : redactOutput({ error: obs.error });
      transcript.push({
        role: 'tool',
        content: [mkToolResult(call.id, call.name, output, !obs.ok)],
      });
      if (obs.ok) {
        telemetry.recordToolCall(call, latencyMs, false);
      } else {
        const code = String((obs.error as { code?: string; message?: string })?.code ?? 'tool_error');
        telemetry.recordToolCall(call, latencyMs, true);
        telemetry.recordError(`${code}: ${call.name}`);
      }
      emit?.({ kind: 'tool_result', id: call.id, name: call.name, output, isError: !obs.ok, latencyMs });
    }
    emit?.({ kind: 'step_end', step: steps });
  }

  if (opts.signal?.aborted) {
    emit?.({ kind: 'aborted' });
    return { status: 'aborted', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs };
  }
  emit?.({ kind: 'final_text', text: finalText });
  return { status: 'max_steps', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs };
}

function redactOutput(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (v && typeof v === 'object') return v; // structured outputs are not redacted wholesale
  return v;
}

export function defaultSystemPrompt(ctx: { cwd: string; telemetry?: string }): string {
  const base = [
    'You are Klyro, an autonomous coding harness. You solve the user\'s task by',
    'calling tools in a loop. Prefer the smallest change that solves the task.',
    'When you have finished, produce a short final text answer (no tool calls).',
    'Do not invent file paths. Do not call tools outside the working directory.',
  ].join(' ');
  if (ctx.telemetry) {
    return base + '\n\n' + ctx.telemetry + '\n\nUse the telemetry above to avoid repeating the same failing call and to keep within the step budget.';
  }
  return base;
}
