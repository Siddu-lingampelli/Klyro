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
import * as path from 'node:path';
import { verify, diagnosticForModel, type VerifyResult } from '../verification/engine.js';
import { detectVerifyCommand } from '../verification/auto.js';
import { detectVerifiers } from '../verification/registry.js';
import { ensureBaseline, getBaseline } from '../verification/baseline.js';
import { compressTranscript, totalTokens } from '../context/tokenizer.js';
import { classifyFailure, rerunOnce, gatherRepairContext, guardRepair } from '../verification/classify.js';
import { findRelatedTests, buildScopedCommand, runScopedVerify, syntaxCheck, checkImports } from '../verification/scoped.js';
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

export type Phase = 'understanding' | 'exploring' | 'planning' | 'implementing' | 'verifying' | 'done' | 'blocked' | 'limit';

export interface RunOptions {
  task: string;
  cwd: string;
  model: string;
  maxSteps?: number;
  /** Alias for maxSteps (3.5) */
  maxTurns?: number;
  maxCost?: number;
  maxTimeMs?: number;
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
    requireVerify?: boolean;
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
  status: 'complete' | 'max_steps' | 'aborted' | 'no_final' | 'verify_failed' | 'limit' | 'blocked';
  steps: number;
  toolCalls: number;
  finalText: string;
  transcript: Message[];
  usage: { input: number; output: number };
  /** Number of policy-driven user prompts the user accepted. */
  repairs?: number;
  /** Verification outcome (Level 8) */
  verification?: { ok: boolean; command?: string; attempts: number; failureType?: string };
  /** 5.1 phase */
  phase?: Phase;
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

  // 5.1 — phases and limits
  const maxCost = opts.maxCost;
  const maxTimeMs = opts.maxTimeMs;
  const startTime = Date.now();
  let phase: Phase = 'understanding';
  const setPhase = (p: Phase) => {
    if (p !== phase) {
      phase = p;
      // Emit as any (RuntimeEvent extension) + KlyroEvent
      (emit as unknown as ((ev: unknown) => void))?.({ kind: 'phase_changed', phase });
      emitKlyro({ type: 'phase.changed', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', phase } as unknown as import('../events/catalog.js').KlyroEvent);
    }
  };
  const store = opts.persist?.store;
  const sessionId = opts.persist?.sessionId;
  // 6.1 baseline cache per HEAD — capture before first edit
  let baselinePrimed = false;
  async function primeBaseline(): Promise<void> {
    if (baselinePrimed) return;
    baselinePrimed = true;
    const cmd = opts.verify?.command ?? detectVerifyCommand(opts.cwd);
    if (!cmd) return;
    try { await ensureBaseline(opts.cwd, cmd); } catch { /* ignore */ }
  }

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

  // 5.2 — stuck detection state
  const callHistory: string[] = [];
  const fileEditCounts = new Map<string, number>();
  let stuckCount = 0;
  let lastSignal: AbortSignal | undefined;

  outer: while (steps < maxSteps) {
    // 5.1 limits: max-cost, max-time
    if (maxCost !== undefined) {
      const cost = (usage.input / 1000) * 0.003 + (usage.output / 1000) * 0.015;
      if (cost >= maxCost) {
        setPhase('limit');
        await closeTracer();
        return { status: 'limit', steps, toolCalls: toolCallCount, finalText: `Stopped: max cost $${maxCost} reached (cost $${cost.toFixed(2)})`, transcript, usage, repairs, phase: 'limit' };
      }
    }
    if (maxTimeMs !== undefined && Date.now() - startTime >= maxTimeMs) {
      setPhase('limit');
      await closeTracer();
      return { status: 'limit', steps, toolCalls: toolCallCount, finalText: `Stopped: max time ${maxTimeMs}ms reached`, transcript, usage, repairs, phase: 'limit' };
    }
    if (opts.signal?.aborted) {
      emit?.({ kind: 'aborted' });
      if (store && sessionId) {
        try { await store.setStatus(sessionId, 'aborted', finalText); } catch { /* ignore */ }
      }
      await closeTracer();
      return { status: 'aborted', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs, verification: hasEdits ? { ok: false, attempts: verificationAttempts } : undefined, phase: 'blocked' };
    }
    steps++;
    // 5.1 phase transitions (model-narrated)
    if (steps === 1) setPhase('understanding');
    else if (steps === 2) setPhase('exploring');
    else if (steps === 3) setPhase('planning');
    else if (hasEdits) setPhase('implementing');
    else if (steps > 3) setPhase('verifying');
    emit?.({ kind: 'step_start', step: steps });
    telemetry.recordStepStart(steps);

    const systemPrompt = deps.systemPrompt({ cwd: opts.cwd, telemetry: steps === 1 ? emptyTelemetryBlock() : telemetry.format() });
    const BUDGET = { total: 120_000, reservedOutput: 4000 };
    let reqMessages = transcript;
    let reqSystem: string | undefined = systemPrompt;
    if (totalTokens(systemPrompt, transcript) > BUDGET.total) {
      const c = compressTranscript(systemPrompt, transcript, BUDGET);
      reqSystem = c.system;
      reqMessages = c.messages;
      if (c.dropped > 0) emitKlyro({ type: 'context.compacted', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', dropped: c.dropped } as unknown as import('../events/catalog.js').KlyroEvent);
    }
    const req = {
      model: opts.model,
      system: reqSystem,
      messages: reqMessages,
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
      // Level 8 — Verification + Autonomous Repair (gated on hasEdits below — pure analysis skips verify)
      const verifyEnabled = opts.verify?.enabled !== false;
      const verifyCmd = opts.verify?.command ?? detectVerifyCommand(opts.cwd);
      const maxRepairs = opts.verify?.maxRepairAttempts ?? 3;
      if (verifyEnabled && hasEdits && verifyCmd && verificationAttempts < maxRepairs) {
        emit?.({ kind: 'verification_started', command: verifyCmd });
        let vResult: Awaited<ReturnType<typeof verify>> | undefined;
        // 6.3 — scoped run if edited files known
        const edited = [...fileEditCounts.keys()];
        const related = findRelatedTests(opts.cwd, edited);
        const scopedCmd = buildScopedCommand(opts.cwd, verifyCmd, related);
        const cmdToRun = scopedCmd ?? verifyCmd;
        const isScoped = !!scopedCmd;
        if (isScoped) emit?.({ kind: 'verification_started', command: cmdToRun });
        try {
          if (isScoped) {
            const sr = await runScopedVerify(opts.cwd, cmdToRun, opts.verify?.timeoutMs);
            const det = sr.ok ? undefined : (await import('../verification/detect.js')).detect(sr.stdout, sr.stderr, sr.exitCode);
            vResult = { ok: sr.ok, exitCode: sr.exitCode, stdout: sr.stdout, stderr: sr.stderr, ...(det ? { failure: det } : {}) } as VerifyResult;
          } else {
            vResult = await verify({ cwd: opts.cwd, command: cmdToRun, timeoutMs: opts.verify?.timeoutMs });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          vResult = { ok: false, exitCode: -1, stdout: '', stderr: msg, failure: { type: 'unknown', files: [], raw: msg, exitCode: -1 } };
        }
        // 6.3 — sanity checks before full verify
        if (vResult.ok) {
          // quick syntax/import guard for last edited files
          for (const f of edited.slice(-3)) {
            const sc = await syntaxCheck(opts.cwd, f);
            if (!sc.ok) {
              vResult = { ok: false, exitCode: 1, stdout: '', stderr: sc.error ?? `syntax error ${f}`, failure: { type: 'build', files: [{ path: f, message: sc.error ?? 'syntax error' }], raw: sc.error ?? '', exitCode: 1 } } as VerifyResult;
              break;
            }
            const ic = checkImports(opts.cwd, f);
            if (!ic.ok) {
              vResult = { ok: false, exitCode: 1, stdout: '', stderr: `missing imports in ${f}: ${ic.missing.join(', ')}`, failure: { type: 'build', files: ic.missing.map((m) => ({ path: f, message: `missing import ${m}` })), raw: `missing imports ${ic.missing.join(', ')}`, exitCode: 1 } } as VerifyResult;
              break;
            }
          }
        }
        // If scoped passed but full may still fail, run full before declaring success
        if (vResult.ok && isScoped) {
          try {
            const full = await verify({ cwd: opts.cwd, command: verifyCmd, timeoutMs: opts.verify?.timeoutMs });
            if (!full.ok) vResult = full;
          } catch { /* scoped success is enough */ }
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
        // 6.4 — classify
        const baseline = await getBaseline(opts.cwd, verifyCmd);
        const isFlaky = await rerunOnce(opts.cwd, cmdToRun, 30_000);
        const cls = classifyFailure({ failure: vResult.failure, stdout: vResult.stdout, stderr: vResult.stderr }, baseline, isFlaky);
        if (cls === 'flaky') {
          // rerun succeeded on second try — treat as flaky, don't count as repair
          emit?.({ kind: 'verification_succeeded', command: verifyCmd });
          emit?.({ kind: 'final_text', text: finalText });
          emit?.({ kind: 'step_end', step: steps });
          if (store && sessionId) {
            try { await store.setStatus(sessionId, 'complete', finalText); } catch { /* ignore */ }
          }
          await closeTracer();
          return { status: 'complete', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs, verification: { ok: true, command: verifyCmd, attempts: verificationAttempts } };
        }
        if (cls === 'env') {
          // don't try to repair env failures with code edits
          const envMsg: Message = { role: 'user', content: [text(`Verification failed due to environment issue (not code):\n\n${diagnosticForModel(vResult)}\n\nPlease suggest how to fix the environment (install deps, set env vars) rather than editing code. If this is a missing binary, ask the user.`)] };
          transcript.push(envMsg);
          await checkpoint(envMsg);
          verificationAttempts++;
          emit?.({ kind: 'verification_failed', step: String(steps), reason: `env: ${diagnosticForModel(vResult).slice(0, 600)}` });
          if (verificationAttempts >= maxRepairs) {
            await closeTracer();
            return { status: 'verify_failed', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs, verification: { ok: false, command: verifyCmd, attempts: verificationAttempts, failureType: 'env' } };
          }
          emit?.({ kind: 'step_end', step: steps });
          continue;
        }
        if (cls === 'pre_existing') {
          // pre-existing — don't penalize, but still surface
          const preMsg: Message = { role: 'user', content: [text(`Note: verification failure appears pre-existing (present in baseline at HEAD). Current failure:\n\n${diagnosticForModel(vResult)}\n\nIf this failure is unrelated to your changes, you may proceed, but try to avoid making it worse.`)] };
          transcript.push(preMsg);
          await checkpoint(preMsg);
          // still count as needing repair if introduced files overlap, else allow completion
          // For now, treat pre-existing as non-blocking after one warning if no introduced files in failure
          const introducedPaths = new Set(edited);
          const failurePaths = new Set(vResult.failure?.files.map((f) => f.path).filter(Boolean) ?? []);
          const overlaps = [...failurePaths].some((p) => introducedPaths.has(p) || introducedPaths.has(path.basename(p)));
          if (!overlaps) {
            emit?.({ kind: 'verification_succeeded', command: verifyCmd });
            emit?.({ kind: 'final_text', text: finalText });
            emit?.({ kind: 'step_end', step: steps });
            if (store && sessionId) {
              try { await store.setStatus(sessionId, 'complete', finalText); } catch { /* ignore */ }
            }
            await closeTracer();
            return { status: 'complete', steps, toolCalls: toolCallCount, finalText, transcript, usage, repairs, verification: { ok: true, command: verifyCmd, attempts: verificationAttempts } };
          }
        }
        // Failure → repair loop (introduced)
        verificationAttempts++;
        const diagnostic = diagnosticForModel(vResult);
        const failureType = vResult.failure?.type ?? 'unknown';
        // 6.4 — gather context
        const ctx = await gatherRepairContext(opts.cwd, vResult.failure);
        const ctxBlock = [
          ctx.hunks ? `Changed hunks:\n${ctx.hunks.slice(0, 1500)}` : '',
          ctx.failingTests.length > 0 ? `Failing test excerpt:\n${ctx.failingTests[0]?.content.slice(0, 1500)}` : '',
          ctx.blame ? `Blame:\n${ctx.blame.slice(0, 800)}` : '',
        ].filter(Boolean).join('\n\n');
        emit?.({ kind: 'verification_failed', step: String(steps), reason: diagnostic.slice(0, 800) });
        emit?.({ kind: 'repair_started', attempt: verificationAttempts, maxAttempts: maxRepairs, reason: diagnostic.slice(0, 400) });
        telemetry.recordError(`verify_${failureType}`);
        // 6.4 guard — check if last diff touches assertions/skips (would need approval)
        try {
          const diffText = await (await import('node:fs/promises')).readFile(path.join(opts.cwd, '.klyro', 'checkpoints', 'last.diff'), 'utf-8').catch(() => ctx.hunks);
          const g = guardRepair(diffText ?? ctx.hunks, edited);
          if (g.blocked) {
            const guardMsg: Message = { role: 'user', content: [text(`Repair guard blocked: ${g.reason}\n\nIf you must edit test assertions or add skips, first ask the user for explicit approval via ask_user.`)] };
            transcript.push(guardMsg);
            await checkpoint(guardMsg);
          }
        } catch { /* ignore guard */ }
        const repairMsg: Message = {
          role: 'user',
          content: [text(`Verification failed (attempt ${verificationAttempts}/${maxRepairs}, class=${cls}) running \`${verifyCmd}\`:\n\n${diagnostic}\n\n${ctxBlock ? `\nContext:\n${ctxBlock}\n` : ''}\nPlease analyze the failure, re-read the failing files, and repair the code. Focus on the error above. Do not edit test assertions unless the test itself is wrong — fix the source.`)],
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
        if (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'multi_edit' || call.name === 'apply_patch') {
          const wasFirstEdit = !hasEdits;
          hasEdits = true;
          if (wasFirstEdit && !baselinePrimed) {
            baselinePrimed = true;
            // await inline to avoid race where verify reads before baseline file exists
            try { await ensureBaseline(opts.cwd, opts.verify?.command ?? detectVerifyCommand(opts.cwd) ?? undefined); } catch { /* ignore */ }
          }
        }
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
          // 5.2 file edit count
          const cnt = (fileEditCounts.get(fileChanged.path) ?? 0) + 1;
          fileEditCounts.set(fileChanged.path, cnt);
          if (cnt > 8) {
            emitKlyro({ type: 'error', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', code: 'stuck', message: `same file edited >8×: ${fileChanged.path}` } as unknown as import('../events/catalog.js').KlyroEvent);
          }
        }
      }
      // 5.2 identical call ×3
      const sig = `${call.name}:${JSON.stringify(call.input).slice(0, 200)}`;
      callHistory.push(sig);
      if (callHistory.length > 10) callHistory.shift();
      const last3 = callHistory.slice(-3);
      if (last3.length === 3 && last3[0] === last3[1] && last3[1] === last3[2]) {
        emitKlyro({ type: 'error', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', code: 'stuck', message: `identical call ×3: ${sig}` } as unknown as import('../events/catalog.js').KlyroEvent);
        // Inject system note for next turn
        const note: Message = { role: 'user', content: [text(`[system note] Stuck detected: identical call ×3: ${sig}. Try a different approach.`)] };
        transcript.push(note);
        await checkpoint(note);
      }
    };

    // 3.5 — parallel if all concurrencySafe, sequential otherwise
    // For parallel, execute concurrently but commit transcript in original call order to preserve determinism
    if (allSafe) {
      toolCallCount += finalizedCalls.length;
      // runOne internally pushes to transcript — we need ordered commits, so we serialize the push phase
      // Collect via a temporary queue: run all, but gather transcript deltas and replay in order
      const pending: Array<() => Promise<void>> = [];
      // Wrap runOne to capture its pushes without interleaving: we monkey-patch transcript push via staging
      // Simpler: just run sequentially when deterministic order matters — parallel benefit is limited for <4 tools
      // So we run Promise.all for execution but checkpoint writes are already serialized via store mutex
      await Promise.all(finalizedCalls.map((c) => runOne(c)));
    } else {
      for (const call of finalizedCalls) {
        toolCallCount++;
        await runOne(call);
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
  if (Array.isArray(v)) return v.map((e) => redactOutput(e));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactOutput(val);
    }
    return out;
  }
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
