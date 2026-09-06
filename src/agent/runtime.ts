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
import { verify, diagnosticForModel } from '../verification/engine.js';
import { detectVerifyCommand } from '../verification/auto.js';
import { EventBus, globalBus } from '../events/bus.js';
import { TraceWriter } from '../trace/writer.js';

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
  /** Alias for maxSteps (3.5) */
  maxTurns?: number;
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
  /**
   * Level 8 — verification config. When enabled and the agent has edited
   * files, the runtime auto-runs a verification command after the agent
   * claims completion, feeds failure diagnostics back, and retries up to
   * maxRepairAttempts.
   */
  verify?: {
    enabled?: boolean;
    command?: string;
    maxRepairAttempts?: number;
    timeoutMs?: number;
  };
  /**
   * Level 9 — persistence. When a SessionStore is provided, every message
   * and observation is checkpointed through it. This enables resume after
   * interrupt and history inspection.
   */
  persist?: {
    store?: import('../persistence/store.js').SessionStore;
    sessionId?: string;
  };
}

/** A single plan step emitted by the agent. */
export interface PlanStep {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
  /** Optional files the step will touch (for L6 diff). */
  files?: string[];
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
  | { kind: 'aborted' }
  | { kind: 'plan_update'; plan: PlanStep[] }
  | { kind: 'file_changed'; path: string; op: 'created' | 'modified' | 'deleted' }
  | { kind: 'verification_failed'; step: string; reason: string }
  | { kind: 'verification_started'; command: string }
  | { kind: 'verification_succeeded'; command: string }
  | { kind: 'repair_started'; attempt: number; maxAttempts: number; reason: string }
  | { kind: 'checkpoint_saved'; sessionId: string };

export interface RunResult {
  status: 'complete' | 'max_steps' | 'aborted' | 'no_final' | 'verify_failed';
  steps: number;
  toolCalls: number;
  finalText: string;
  transcript: Message[];
  usage: { input: number; output: number };
  /** Number of policy-driven user prompts the user accepted. */
  repairs?: number;
  /** Verification outcome (Level 8) */
  verification?: { ok: boolean; command?: string; attempts: number; failureType?: string };
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
  const maxSteps = opts.maxTurns ?? opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const transcript: Message[] = (() => {
    if (opts.initialTranscript) {
      const base = [...opts.initialTranscript];
      // Avoid duplicating task when resuming a session that already ends with same task
      const last = base[base.length - 1];
      if (last?.role === 'user') {
        const lastText = (last.content as { kind: string; text?: string }[])
          .filter((b) => b.kind === 'text')
          .map((b) => b.text ?? '')
          .join('');
        if (lastText === opts.task) return base;
      }
      return [...base, { role: 'user', content: [text(opts.task)] }];
    }
    return [{ role: 'user', content: [text(opts.task)] }];
  })();
  const usage = { input: 0, output: 0 };
  let steps = 0;
  let toolCallCount = 0;
  let finalText = '';
  let repairs = 0;
  let verificationAttempts = 0;
  let hasEdits = false;
  const emit = opts.onEvent;
  const telemetry = new RuntimeTelemetry();
  telemetry.setMaxSteps(maxSteps);

  // 3.1 — Event bus + TraceWriter
  const bus: EventBus = (deps as unknown as { bus?: EventBus }).bus ?? globalBus;
  let tracer: TraceWriter | undefined;
  if (opts.persist?.sessionId) {
    tracer = new TraceWriter(opts.persist.sessionId);
    await tracer.init().catch(() => undefined);
  }
  const emitKlyro = (ev: import('../events/catalog.js').KlyroEvent) => {
    bus.emit(ev);
    tracer?.write(ev).catch(() => undefined);
  };
  const closeTracer = async (): Promise<void> => {
    try { await tracer?.close(); } catch { /* ignore */ }
  };

  // Level 9 — persistence helpers
  const store = opts.persist?.store;
  const sessionId = opts.persist?.sessionId;
  async function checkpoint(msg?: Message, obs?: { toolCallId: string; toolName: string; input: unknown; output: unknown; isError: boolean }): Promise<void> {
    if (!store || !sessionId) return;
    try {
      if (msg) {
        await store.appendMessage(sessionId, { role: msg.role as 'user' | 'assistant' | 'tool' | 'system', content: msg.content, ts: Date.now() });
      }
      if (obs) {
        await store.appendObservation(sessionId, {
          toolCallId: obs.toolCallId,
          toolName: obs.toolName,
          input: obs.input,
          output: obs.output,
          isError: obs.isError,
          startedAt: Date.now(),
          finishedAt: Date.now(),
        });
      }
      emit?.({ kind: 'checkpoint_saved', sessionId });
    } catch {
      // best-effort — don't crash runtime on persistence failure
    }
  }

  // Persist initial user message
  if (store && sessionId && transcript.length > 0) {
    // Fire-and-forget initial checkpoint (don't await to block loop start)
    void checkpoint(transcript[transcript.length - 1]);
  }

  outer: while (steps < maxSteps) {
    if (opts.signal?.aborted) {
      emit?.({ kind: 'aborted' });
      if (store && sessionId) {
        try { await store.setStatus(sessionId, 'aborted', finalText); } catch { /* ignore */ }
      }
      await closeTracer();
      return { status: 'aborted', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs, verification: hasEdits ? { ok: false, attempts: verificationAttempts } : undefined };
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
        if (store && sessionId) {
          try { await store.setStatus(sessionId, 'aborted', textBuf); } catch { /* ignore */ }
        }
        await closeTracer();
        return {
          status: 'no_final',
          steps,
          toolCalls: toolCallCount,
          finalText: textBuf,
          transcript,
          usage,
          repairs,
          verification: hasEdits ? { ok: false, attempts: verificationAttempts } : undefined,
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
    const assistantMsg: Message = { role: 'assistant', content: assistantContent };
    transcript.push(assistantMsg);
    await checkpoint(assistantMsg);

    // No tool calls → potential completion (Level 8 verify gate)
    if (opts.signal?.aborted) {
      finalText = textBuf;
      emit?.({ kind: 'aborted' });
      if (store && sessionId) {
        try { await store.setStatus(sessionId, 'aborted', finalText); } catch { /* ignore */ }
      }
      await closeTracer();
      return { status: 'aborted', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs, verification: hasEdits ? { ok: false, attempts: verificationAttempts } : undefined };
    }
    if (finalizedCalls.length === 0) {
      finalText = textBuf;
      // Level 8 — Verification + Autonomous Repair
      const verifyEnabled = opts.verify?.enabled !== false;
      const verifyCmd = opts.verify?.command ?? detectVerifyCommand(opts.cwd);
      const maxRepairs = opts.verify?.maxRepairAttempts ?? 3;
      if (verifyEnabled && hasEdits && verifyCmd && verificationAttempts < maxRepairs) {
        emit?.({ kind: 'verification_started', command: verifyCmd });
        let vResult: Awaited<ReturnType<typeof verify>> | undefined;
        try {
          vResult = await verify({ cwd: opts.cwd, command: verifyCmd, timeoutMs: opts.verify?.timeoutMs });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          vResult = { ok: false, exitCode: -1, stdout: '', stderr: msg, failure: { type: 'unknown', files: [], raw: msg, exitCode: -1 } };
        }
        if (vResult.ok) {
          emit?.({ kind: 'verification_succeeded', command: verifyCmd });
          emit?.({ kind: 'final_text', text: finalText });
          emit?.({ kind: 'step_end', step: steps });
          if (store && sessionId) {
            try { await store.setStatus(sessionId, 'complete', finalText); } catch { /* ignore */ }
          }
          await closeTracer();
          return { status: 'complete', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs, verification: { ok: true, command: verifyCmd, attempts: verificationAttempts } };
        }
        // Failure → repair loop
        verificationAttempts++;
        const diagnostic = diagnosticForModel(vResult);
        const failureType = vResult.failure?.type ?? 'unknown';
        emit?.({ kind: 'verification_failed', step: String(steps), reason: diagnostic.slice(0, 800) });
        emit?.({ kind: 'repair_started', attempt: verificationAttempts, maxAttempts: maxRepairs, reason: diagnostic.slice(0, 400) });
        telemetry.recordError(`verify_${failureType}`);
        const repairMsg: Message = {
          role: 'user',
          content: [text(`Verification failed (attempt ${verificationAttempts}/${maxRepairs}) running \`${verifyCmd}\`:\n\n${diagnostic}\n\nPlease analyze the failure, re-read the failing files, and repair the code. Focus on the error above.`)],
        };
        transcript.push(repairMsg);
        await checkpoint(repairMsg);
        if (store && sessionId) {
          try { await store.setStatus(sessionId, 'verify_failed', finalText); } catch { /* ignore */ }
        }
        if (verificationAttempts >= maxRepairs) {
          emit?.({ kind: 'final_text', text: finalText });
          emit?.({ kind: 'step_end', step: steps });
          await closeTracer();
          return { status: 'verify_failed', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs, verification: { ok: false, command: verifyCmd, attempts: verificationAttempts, failureType } };
        }
        emit?.({ kind: 'step_end', step: steps });
        continue; // -> next iteration lets model repair
      }
      emit?.({ kind: 'final_text', text: finalText });
      emit?.({ kind: 'step_end', step: steps });
      if (store && sessionId) {
        try { await store.setStatus(sessionId, 'complete', finalText); } catch { /* ignore */ }
      }
      await closeTracer();
      return { status: 'complete', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs, verification: hasEdits ? { ok: true, attempts: verificationAttempts } : undefined };
    }

    // 3.1 — emit turn events
    emitKlyro({ type: 'turn.start', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', turn: steps, model: opts.model });

    // Execute each tool call (after policy) — 3.5 parallel if all concurrencySafe
    const toolCtx: ToolContext = {
      cwd: opts.cwd,
      env: process.env,
      signal: opts.signal,
      nonInteractive: opts.nonInteractive,
      sessionId,
    };
    const allSafe = finalizedCalls.length > 1 && finalizedCalls.every((c) => deps.registry.get(c.name)?.isConcurrencySafe !== false);
    const runOne = async (call: typeof finalizedCalls[number]): Promise<void> => {
      // Use per-call handling without continue (runOne is not a loop)
      const decision = await deps.policy.evaluate(
        { name: call.name, input: call.input },
        { cwd: opts.cwd, nonInteractive: opts.nonInteractive },
      );
      emit?.({ kind: 'policy_decision', id: call.id, name: call.name, action: decision.action, ...(decision.action !== 'allow' ? { reason: (decision as { reason?: string }).reason } : {}) });
      // Mirror to KlyroEvent bus
      emitKlyro({ type: 'permission.decision', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', callId: call.id, action: decision.action, ...(decision.action !== 'allow' ? { reason: (decision as { reason?: string }).reason } : {}) } as import('../events/catalog.js').KlyroEvent);

      if (decision.action === 'deny') {
        const denyMsg: Message = {
          role: 'tool',
          content: [
            mkToolResult(call.id, call.name, { error: 'POLICY_DENIED', reason: decision.reason }, true),
          ],
        };
        transcript.push(denyMsg);
        await checkpoint(denyMsg, { toolCallId: call.id, toolName: call.name, input: call.input, output: { error: 'POLICY_DENIED', reason: decision.reason }, isError: true });
        emitKlyro({ type: 'tool.result', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', callId: call.id, name: call.name, output: { error: 'POLICY_DENIED' }, isError: true, latencyMs: 0 });
        telemetry.recordToolError(call, 'policy_denied');
        emit?.({ kind: 'tool_result', id: call.id, name: call.name, output: { error: 'POLICY_DENIED', reason: decision.reason }, isError: true, latencyMs: 0 });
        return;
      }

      if (decision.action === 'ask') {
        emitKlyro({ type: 'permission.ask', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', callId: call.id, name: call.name, reason: decision.reason });
        const choice = await deps.approval.ask({
          toolName: call.name,
          reason: decision.reason,
          summary: summarizeToolCall(call),
        });
        // Approval UI in TUI handles y/a/A/n/e/? — e edits input, ? explains
        if (choice === 'deny') {
          const denyMsg2: Message = {
            role: 'tool',
            content: [
              mkToolResult(call.id, call.name, { error: 'POLICY_DENIED', reason: 'user denied' }, true),
            ],
          };
          transcript.push(denyMsg2);
          await checkpoint(denyMsg2, { toolCallId: call.id, toolName: call.name, input: call.input, output: { error: 'POLICY_DENIED', reason: 'user denied' }, isError: true });
          telemetry.recordToolError(call, 'user_denied');
          emit?.({ kind: 'tool_result', id: call.id, name: call.name, output: { error: 'POLICY_DENIED', reason: 'user denied' }, isError: true, latencyMs: 0 });
          return;
        }
        // Handle 'edit' choice: for now treat as allow with edited input (future: re-prompt)
        repairs++;
      }

      const t0 = Date.now();
      emitKlyro({ type: 'tool.call', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', callId: call.id, name: call.name, input: call.input });
      const obs = await deps.registry.execute(call.name, call.input, toolCtx);
      const latencyMs = Date.now() - t0;
      const output = obs.ok ? redactOutput(obs.value) : redactOutput({ error: obs.error });
      const toolMsg: Message = {
        role: 'tool',
        content: [mkToolResult(call.id, call.name, output, !obs.ok)],
      };
      transcript.push(toolMsg);
      await checkpoint(toolMsg, { toolCallId: call.id, toolName: call.name, input: call.input, output, isError: !obs.ok });
      if (obs.ok) {
        telemetry.recordToolCall(call, latencyMs, false);
        if (call.name === 'write_file' || call.name === 'edit_file') hasEdits = true;
      } else {
        const code = String((obs.error as { code?: string; message?: string })?.code ?? 'tool_error');
        telemetry.recordToolCall(call, latencyMs, true);
        telemetry.recordError(`${code}: ${call.name}`);
      }
      emitKlyro({ type: 'tool.result', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', callId: call.id, name: call.name, output, isError: !obs.ok, latencyMs });
      emit?.({ kind: 'tool_result', id: call.id, name: call.name, output, isError: !obs.ok, latencyMs });
      if (obs.ok) {
        const fileChanged = inferFileChanged(call.name, call.input, obs.value);
        if (fileChanged) {
          emit?.({ kind: 'file_changed', path: fileChanged.path, op: fileChanged.op });
          emitKlyro({ type: 'file.changed', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', path: fileChanged.path, op: fileChanged.op });
          // 4.5 — checkpoint snapshot after each mutation
          try {
            const { snapshot } = await import('../checkpoints/store.js');
            await snapshot(opts.cwd, [fileChanged.path]);
          } catch { /* ignore */ }
        }
      }
    };

    // 3.5 — parallel if all concurrencySafe, sequential otherwise
    if (allSafe) {
      await Promise.all(finalizedCalls.map((c) => { toolCallCount++; return runOne(c); }));
    } else {
      for (const call of finalizedCalls) {
        toolCallCount++;
        await runOne(call);
        // 3.5 — cancellation: if signal aborted mid-tools, stop
        if (opts.signal?.aborted) break;
      }
    }
    emit?.({ kind: 'step_end', step: steps });
    emitKlyro({ type: 'turn.end', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', turn: steps });
    // Level 9 — checkpoint status after each step
    if (store && sessionId) {
      try { await store.setStatus(sessionId, 'open'); } catch { /* ignore */ }
    }
  }

  if (opts.signal?.aborted) {
    emit?.({ kind: 'aborted' });
    if (store && sessionId) {
      try { await store.setStatus(sessionId, 'aborted', finalText); } catch { /* ignore */ }
    }
    await closeTracer();
    return { status: 'aborted', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs, verification: hasEdits ? { ok: false, attempts: verificationAttempts } : undefined };
  }
  emit?.({ kind: 'final_text', text: finalText });
  if (store && sessionId) {
    try { await store.setStatus(sessionId, 'max_steps', finalText); } catch { /* ignore */ }
  }
  await closeTracer();
  return { status: 'max_steps', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs, verification: hasEdits ? { ok: false, attempts: verificationAttempts } : undefined };
}

function redactOutput(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (v && typeof v === 'object') return v; // structured outputs are not redacted wholesale
  return v;
}

/**
 * Best-effort inference of "this tool call changed a file" for the
 * file_changed event. Returns null when we don't have a clear answer.
 *
 * Today: write_file, edit_file, write_file (truncate via empty content).
 * Tomorrow: shell_exec that ran `rm` or `git mv` would need to grep
 * the output, but that's out of scope.
 */
function inferFileChanged(
  toolName: string,
  input: Record<string, unknown>,
  output: unknown,
): { path: string; op: 'created' | 'modified' | 'deleted' } | null {
  const inPath = typeof input.path === 'string' ? input.path : null;
  if (!inPath) return null;
  if (toolName === 'write_file' || toolName === 'edit_file') {
    // Distinguish create vs modify by the output shape: write_file returns
    // { path, bytesWritten }; edit_file returns { path, replacements, diff }.
    // Both are "modified" semantically; we don't have the pre-state easily
    // from inside the runtime. A more precise implementation would stat the
    // file before/after the call. For now: treat both as 'modified'.
    return { path: inPath, op: 'modified' };
  }
  return null;
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
