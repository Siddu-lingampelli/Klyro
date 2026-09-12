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
import { patternForCall } from '../policy/patterns.js';
import { RuntimeTelemetry, emptyTelemetryBlock, summarizeToolCall } from '../context/level7.js';
import * as path from 'node:path';
import { verify, diagnosticForModel, type VerifyResult } from '../verification/engine.js';
import { detectVerifyCommand } from '../verification/auto.js';
import { detectVerifiers } from '../verification/registry.js';
import { ensureBaseline, getBaseline } from '../verification/baseline.js';
import { compressTranscript, totalTokens, calibrateEstimate, transcriptCharLength } from '../context/tokenizer.js';
import { ratesFor, isAnthropicModel } from '../providers/model-info.js';
import { classifyFailure, rerunOnce, gatherRepairContext, guardRepair } from '../verification/classify.js';
import { findRelatedTests, buildScopedCommand, runScopedVerify, syntaxCheck, checkImports } from '../verification/scoped.js';
import { EventBus, globalBus } from '../events/bus.js';
import type { KlyroEvent } from '../events/catalog.js';
import { TraceWriter } from '../trace/writer.js';
import { loadHooks, runHook, type Hook } from '../cli/hooks.js';

/**
 * Verification mode. The canonical definition lives in verification/engine.ts
 * (sibling-owned: `export type VerifyMode = 'strict'|'advisory'|'off'`). It is
 * resolved conditionally here so this file typechecks regardless of sibling
 * landing order — and converges to the sibling type automatically once the
 * sibling export exists.
 */
export type VerifyMode = typeof import('../verification/engine.js') extends { VerifyMode: infer V } ? V : 'strict' | 'advisory' | 'off';

export interface RuntimeDeps {
  adapter: ProviderAdapter;
  /**
   * Ordered failover adapters (L15). When the active adapter ends a step
   * with a terminal provider error, the runtime swaps to the next entry
   * and re-issues the step (bounded by chain length, never loops).
   * Optional — single-adapter callers behave exactly as before.
   */
  failoverAdapters?: ProviderAdapter[];
  registry: ToolRegistry;
  policy: PolicyEngine;
  approval: ApprovalPrompt;
  /**
   * Build a system prompt given cwd + the current Level-7 runtime telemetry.
   *
   * TELEMETRY SPLIT: the fn may return either a plain string (legacy —
   * telemetry already concatenated, cache-unfriendly) or
   * `{system, suffix}` where `suffix` is the volatile telemetry block.
   * The runtime forwards both halves via CallRequest (`system` +
   * `systemSuffix`) so adapters can keep the suffix out of the cacheable
   * prefix (Anthropic array form) or concatenate it (OpenAI — unchanged).
   * Both shapes are accepted so custom fns keep compiling.
   */
  systemPrompt: SystemPromptFn;
}

/** Split system-prompt result: stable prefix + volatile telemetry suffix. */
export interface SystemPromptResult {
  system: string;
  suffix?: string;
}

export type SystemPromptFn = (ctx: { cwd: string; telemetry?: string }) => string | SystemPromptResult;

/** Normalize either systemPrompt shape into {system, suffix}. */
export function resolveSystemPrompt(
  fn: SystemPromptFn,
  ctx: { cwd: string; telemetry?: string },
): { system: string; suffix?: string } {
  const r = fn(ctx);
  return typeof r === 'string' ? { system: r } : { system: r.system, suffix: r.suffix };
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
    /** Verification mode (default 'strict'). 'off' skips the pipeline;
     * 'advisory' runs verify once on completion without repair turns. */
    mode?: VerifyMode;
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
  /**
   * Orchestration context (P0). Present for any agent that is itself managed
   * by an AgentOrchestrator — so a child knows who its parent is, how deep the
   * call stack is, which tools it may use, and which task/session it belongs to.
   */
  parentContext?: {
    taskId?: string;
    parentTaskId?: string;
    sessionId: string;
    depth: number;
    maxDepth: number;
    allowedTools?: ReadonlySet<string>;
    /** Path allow-set inherited from the parent (sibling C contract). */
    allowedPaths?: readonly string[];
    model?: string;
  };
  /**
   * Delegation bridge (P0). Present on the root run so the model can call
   * spawn_agent / task_list / task_get. The tool layer reads it from the
   * ToolContext.
   */
  agentBridge?: import('./orchestrator.js').AgentSpawnBridge;
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
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'tool_call_start'; id: string; name: string }
  | { kind: 'tool_call_delta'; id: string; argsJson: string }
  | { kind: 'tool_call_end'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'policy_decision'; id: string; name: string; action: 'allow' | 'ask' | 'deny'; reason?: string }
  | { kind: 'tool_result'; id: string; name: string; output: unknown; isError: boolean; latencyMs: number }
  | { kind: 'usage'; input: number; output: number; estimated?: boolean; cacheRead?: number; cacheWrite?: number }
  | { kind: 'final_text'; text: string }
  | { kind: 'aborted' }
  | { kind: 'plan_update'; plan: PlanStep[] }
  | { kind: 'file_changed'; path: string; op: 'created' | 'modified' | 'deleted' }
  | { kind: 'verification_failed'; step: string; reason: string }
  | { kind: 'verification_started'; command: string }
  | { kind: 'verification_succeeded'; command: string }
  | { kind: 'repair_started'; attempt: number; maxAttempts: number; reason: string }
  | { kind: 'checkpoint_saved'; sessionId: string }
  | { kind: 'status'; message: string }
  | { kind: 'budget_warning'; ratio: number; threshold: number }
  | { kind: 'provider_failover'; from: string; to: string; reason: string }
  | { kind: 'model_override'; requested: string; effective: string };

export interface RunResult {
  status: 'complete' | 'max_steps' | 'aborted' | 'no_final' | 'verify_failed' | 'limit' | 'blocked' | 'stuck';
  steps: number;
  toolCalls: number;
  finalText: string;
  transcript: Message[];
  /** Whether any file-mutating tool ran (drives --require-verify semantics). */
  hasEdits: boolean;
  usage: { input: number; output: number; estimated?: boolean; cacheRead?: number; cacheWrite?: number };
  /** Number of policy-driven user prompts the user accepted. */
  repairs?: number;
  /** Verification outcome (Level 8) */
  verification?: { ok: boolean; command?: string; attempts: number; failureType?: string; repairTokens?: { input: number; output: number } };
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

// Model-aware cost estimation, single-sourced from the
// providers/model-info.ts rate table (local/unknown models are $0).
// Cache-aware: for Anthropic-family models (isAnthropicModel), cacheRead
// bills at 0.1× the input rate and cacheWrite at 1.25×; all other
// families ignore cache counters (discounted billing, unmodeled).
/** Estimate USD cost of a usage block given the model name. */
export function estimateCost(
  model: string,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): number {
  const { input: inRate, output: outRate } = ratesFor(model);
  const base = (usage.input / 1000) * inRate + (usage.output / 1000) * outRate;
  if (!isAnthropicModel(model)) return base;
  const read = ((usage.cacheRead ?? 0) / 1000) * inRate * 0.1;
  const write = ((usage.cacheWrite ?? 0) / 1000) * inRate * 1.25;
  return base + read + write;
}

/**
 * Parallel fan-out cap: approved concurrencySafe tool calls execute in
 * sequential chunks of at most this size. Commit order stays identical
 * (commits run sequentially after execution), so the transcript reads as
 * if the calls ran in order.
 */
export const MAX_PARALLEL_TOOLS = 8;

/** Progressive budget-warning thresholds (fraction of maxCost), fired once each per run. */
export const BUDGET_WARNING_THRESHOLDS = [0.4, 0.7, 0.9] as const;

// PERF-002: Memoized token counting cache.
let tokenCache: { lastRef: Message[] | null; lastSystem: string | undefined; lastCount: number } = {
  lastRef: null,
  lastSystem: undefined,
  lastCount: 0,
};

/** Memoized totalTokens � only recomputes when transcript ref or system changes. */
function cachedTotalTokens(system: string | undefined, messages: Message[]): number {
  if (tokenCache.lastRef === messages && tokenCache.lastSystem === system) {
    return tokenCache.lastCount;
  }
  const count = totalTokens(system, messages);
  tokenCache = { lastRef: messages, lastSystem: system, lastCount: count };
  return count;
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
  const usage: { input: number; output: number; estimated?: boolean; cacheRead?: number; cacheWrite?: number } = { input: 0, output: 0 };
  /** Emit one `budget_warning` per threshold the cost ratio has crossed. */
  const checkBudgetWarnings = (): void => {
    if (maxCost === undefined || maxCost <= 0) return;
    const ratio = estimateCost(opts.model, usage) / maxCost;
    for (const threshold of BUDGET_WARNING_THRESHOLDS) {
      if (ratio >= threshold && !firedBudgetWarnings.has(threshold)) {
        firedBudgetWarnings.add(threshold);
        emit?.({ kind: 'budget_warning', ratio, threshold });
      }
    }
  };
  let steps = 0;
  let toolCallCount = 0;
  let finalText = '';
  let repairs = 0;
  let verificationAttempts = 0;
  let hasEdits = false;
  // Overflow recovery: at most one compress-and-retry per run.
  let overflowRetried = false;
  // Repair ledger + guard: set from the first verification failure until a
  // verification passes. repairUsageStart snapshots usage at failure time so
  // every verification payload can attribute its repairTokens delta.
  let inRepairTurn = false;
  let repairUsageStart: { input: number; output: number } | undefined;
  const verifyMode: VerifyMode = opts.verify?.mode ?? 'strict';
  const markRepairStarted = (): void => {
    if (!repairUsageStart) repairUsageStart = { input: usage.input, output: usage.output };
    inRepairTurn = true;
  };
  const repairTokensNow = (): { input: number; output: number } | undefined =>
    repairUsageStart
      ? { input: usage.input - repairUsageStart.input, output: usage.output - repairUsageStart.output }
      : undefined;
  /** Attach repairTokens to a verification payload when a repair ledger exists. */
  const withRepairTokens = <V extends { ok: boolean; command?: string; attempts: number; failureType?: string }>(
    v: V,
  ): V & { repairTokens?: { input: number; output: number } } => {
    const rt = repairTokensNow();
    return rt ? { ...v, repairTokens: rt } : v;
  };
  const emit = opts.onEvent;
  const telemetry = new RuntimeTelemetry();
  telemetry.setMaxSteps(maxSteps);

  // Model-override surfacing (informational): when a parent/orchestrator
  // context carries a model override, emit it once so UIs can show which
  // model actually serves this run.
  if (opts.parentContext?.model) {
    emit?.({ kind: 'model_override', requested: opts.model, effective: opts.parentContext.model });
  }

  // Hooks engine: loaded once per run. Zero-cost fast path — when no hooks
  // file exists, both lists are empty and every hook call site is skipped.
  let runHooks: Hook[] = [];
  try {
    runHooks = loadHooks(opts.cwd);
  } catch {
    runHooks = [];
  }
  const preHooks = runHooks.filter((h) => h.event === 'preToolUse');
  const postHooks = runHooks.filter((h) => h.event === 'postToolUse');

  // L15 failover chain: the active adapter starts as deps.adapter; each
  // terminal provider error consumes one fallback. Bounded — never loops.
  let activeAdapter: ProviderAdapter = deps.adapter;
  const failoverQueue: ProviderAdapter[] = [...(deps.failoverAdapters ?? [])];

  // 3.1 — Event bus + TraceWriter
  const bus: EventBus = (deps as unknown as { bus?: EventBus }).bus ?? globalBus;
  let tracer: TraceWriter | undefined;
  if (opts.persist?.sessionId) {
    tracer = new TraceWriter(opts.persist.sessionId);
    await tracer.init().catch(() => undefined);
  }
  const emitKlyro = (ev: KlyroEvent) => {
    bus.emit(ev);
    tracer?.write(ev).catch(() => undefined);
  };
  const closeTracer = async (): Promise<void> => {
    try { await tracer?.close(); } catch { /* ignore */ }
  };

  // 5.1 — phases and limits
  const maxCost = opts.maxCost;
  const maxTimeMs = opts.maxTimeMs;
  // Progressive budget warnings: fire once per threshold per run when the
  // cost ratio crosses 0.4 / 0.7 / 0.9 of maxCost (checker defined after
  // `usage` is declared below).
  const firedBudgetWarnings = new Set<number>();
  const startTime = Date.now();
  let phase: Phase = 'understanding';
  const setPhase = (p: Phase) => {
    if (p !== phase) {
      phase = p;
      // Emit as any (RuntimeEvent extension) + KlyroEvent
      (emit as unknown as ((ev: unknown) => void))?.({ kind: 'phase_changed', phase });
      emitKlyro({ type: 'phase.changed', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', phase });
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
  let stuckTriggers = 0;
  let stuckAbort = false;

  outer: while (steps < maxSteps) {
    // 5.1 limits: max-cost, max-time
    if (maxCost !== undefined) {
      const cost = estimateCost(opts.model, usage);
      if (cost >= maxCost) {
        setPhase('limit');
        await closeTracer();
        return { status: 'limit', steps, toolCalls: toolCallCount, finalText: `Stopped: max cost $${maxCost} reached (cost $${cost.toFixed(2)})`, transcript, hasEdits, usage, repairs, phase: 'limit' };
      }
    }
    if (maxTimeMs !== undefined && Date.now() - startTime >= maxTimeMs) {
      setPhase('limit');
      await closeTracer();
      return { status: 'limit', steps, toolCalls: toolCallCount, finalText: `Stopped: max time ${maxTimeMs}ms reached`, transcript, hasEdits, usage, repairs, phase: 'limit' };
    }
    if (opts.signal?.aborted) {
      emit?.({ kind: 'aborted' });
      if (store && sessionId) {
        try { await store.setStatus(sessionId, 'aborted', finalText); } catch { /* ignore */ }
      }
      await closeTracer();
      return { status: 'aborted', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: hasEdits ? withRepairTokens({ ok: false, attempts: verificationAttempts }) : undefined, phase: 'blocked' };
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

    const { system: stableSystem, suffix: telemetrySuffix } = resolveSystemPrompt(deps.systemPrompt, {
      cwd: opts.cwd,
      telemetry: steps === 1 ? emptyTelemetryBlock() : telemetry.format(),
    });
    // Budget accounting sees what the model sees (prefix + suffix); the
    // request itself keeps the halves split for cache-friendly adapters.
    const systemForBudget = telemetrySuffix ? `${stableSystem}\n\n${telemetrySuffix}` : stableSystem;
    const BUDGET = { total: 120_000, reservedOutput: 4000 };
    let reqMessages = transcript;
    let reqSystem: string | undefined = stableSystem;
    let reqSuffix: string | undefined = telemetrySuffix;
    if (cachedTotalTokens(systemForBudget, transcript) > BUDGET.total) {
      const c = compressTranscript(systemForBudget, transcript, BUDGET);
      reqSystem = c.system;
      reqSuffix = undefined; // telemetry is regenerable — drop it under pressure
      reqMessages = c.messages;
      tokenCache = { lastRef: null, lastSystem: undefined, lastCount: 0 };
      if (c.dropped > 0) emitKlyro({ type: 'context.compacted', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', dropped: c.dropped });
    }
    const req = {
      model: opts.parentContext?.model ?? opts.model,
      system: reqSystem,
      ...(reqSuffix ? { systemSuffix: reqSuffix } : {}),
      messages: reqMessages,
      tools: toolDefinitions(deps.registry),
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };

    const events = activeAdapter.stream(req);
    let textBuf = '';
    // Thinking is ephemeral: streamed to the UI live, never stored in the
    // transcript, and cleared when the turn's answer completes.
    let thinkingBuf = '';
    const pendingToolCalls = new Map<string, { id: string; name: string; argsJson: string }>();
    let lastFinishReason: string | undefined;
    // Set when this step's request must be re-issued after overflow recovery.
    let overflowRetryPending = false;
    // Set when a terminal provider error consumed a failover adapter — the
    // step is re-issued against the next adapter without consuming budget.
    let failoverPending = false;
    let failoverFrom = '';
    let failoverTo = '';
    let failoverReason = '';

    for await (const ev of events) {
      if (opts.signal?.aborted) break outer;
      if (ev.kind === 'text_delta') {
        textBuf += ev.text;
        emit?.({ kind: 'text_delta', text: ev.text });
      } else if (ev.kind === 'thinking_delta') {
        thinkingBuf += ev.text;
        emit?.({ kind: 'thinking_delta', text: ev.text });
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
          if (ev.usage.cacheRead !== undefined) usage.cacheRead = (usage.cacheRead ?? 0) + ev.usage.cacheRead;
          if (ev.usage.cacheWrite !== undefined) usage.cacheWrite = (usage.cacheWrite ?? 0) + ev.usage.cacheWrite;
          telemetry.recordUsage(ev.usage.input, ev.usage.output);
          // R3 — calibrate the local chars/4 heuristic toward the real
          // per-character ratio this provider/model reports, so future budget
          // checks (and overflow recovery) estimate accurately.
          calibrateEstimate(transcriptCharLength(systemForBudget, reqMessages), ev.usage.input);
          emit?.({
            kind: 'usage', input: usage.input, output: usage.output,
            ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
            ...(usage.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
          });
          checkBudgetWarnings();
        } else {
          // Providers that omit usage (Ollama, vLLM, proxies): estimate from
          // the actual request + generated output so cost accounting never
          // silently records zero. Marked estimated for the UI/debugging.
          const est = estimateTurnUsage(systemForBudget, reqMessages, textBuf, pendingToolCalls);
          usage.input += est.input;
          usage.output += est.output;
          usage.estimated = true;
          telemetry.recordUsage(est.input, est.output);
          emit?.({ kind: 'usage', input: usage.input, output: usage.output, estimated: true });
          checkBudgetWarnings();
        }
      } else if (ev.kind === 'error') {
        // Overflow recovery: on the first REQUEST_TOO_LARGE of a run,
        // aggressively compact the transcript and re-issue the request once.
        // A second occurrence fails normally (returned as no_final below).
        if (ev.code === 'REQUEST_TOO_LARGE' && !overflowRetried) {
          overflowRetried = true;
          overflowRetryPending = true;
          telemetry.recordError('overflow_retry');
          emitKlyro({ type: 'error', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', code: 'REQUEST_TOO_LARGE', message: 'context overflow — aggressively compacting transcript and retrying the request once' });
          try {
            const compacted = compressTranscript(reqSystem, transcript, { total: 30_000, reservedOutput: 4000 });
            if (compacted.messages.length < transcript.length || compacted.dropped > 0) {
              transcript.splice(0, transcript.length, ...compacted.messages);
            } else {
              // Transcript already fits the aggressive budget — force it
              // strictly smaller so the retry cannot repeat the overflow.
              const halved = Math.max(4000, Math.floor(totalTokens(reqSystem, transcript) / 2));
              const smaller = compressTranscript(reqSystem, transcript, { total: halved, reservedOutput: 4000 });
              transcript.splice(0, transcript.length, ...smaller.messages);
            }
            tokenCache = { lastRef: null, lastSystem: undefined, lastCount: 0 };
          } catch { /* ignore — retry with the transcript as-is */ }
          break;
        }
        // L15 failover: a terminal provider error swaps to the next chained
        // adapter and re-issues the step (bounded by chain length). Context
        // overflow is excluded — it owns its own recovery above. By the time
        // an error reaches the runtime, per-adapter retries are exhausted,
        // so any provider error here is terminal for the active adapter.
        if (failoverQueue.length > 0) {
          const next = failoverQueue.shift()!;
          failoverPending = true;
          failoverFrom = activeAdapter.id;
          failoverTo = next.id;
          failoverReason = `${ev.code}: ${ev.message}`.slice(0, 300);
          activeAdapter = next;
          telemetry.recordError(`failover: ${ev.code}`);
          emit?.({ kind: 'provider_failover', from: failoverFrom, to: failoverTo, reason: failoverReason });
          emit?.({ kind: 'status', message: `provider ${failoverFrom} failed (${ev.code}) — failing over to ${failoverTo}` });
          emitKlyro({ type: 'error', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', code: ev.code, message: `failing over ${failoverFrom} → ${failoverTo}: ${ev.message.slice(0, 200)}` });
          break;
        }
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
          hasEdits,
          usage,
          repairs,
          verification: hasEdits ? withRepairTokens({ ok: false, attempts: verificationAttempts }) : undefined,
        };
      }
    }

    // Overflow recovery lands here via `break`: re-issue the same step
    // without consuming the step budget.
    if (overflowRetryPending) {
      overflowRetryPending = false;
      steps--;
      emit?.({ kind: 'step_end', step: steps + 1 });
      continue outer;
    }

    // Failover lands here via `break`: discard the failed attempt's partial
    // output and re-issue the same step against the next adapter, again
    // without consuming the step budget.
    if (failoverPending) {
      failoverPending = false;
      textBuf = '';
      thinkingBuf = '';
      pendingToolCalls.clear();
      lastFinishReason = undefined;
      steps--;
      emit?.({ kind: 'step_end', step: steps + 1 });
      continue outer;
    }

    // Build the assistant message. Tool calls are finalized here: JSON is
    // parsed and schema-validated BEFORE policy/execution. Malformed calls
    // become structured MALFORMED_TOOL_CALL results — garbage arguments must
    // never reach a real tool.
    const assistantContent: Message['content'] = [];
    if (textBuf) assistantContent.push(text(textBuf));
    const finalizedCalls: ToolUseBlock[] = [];
    let hadInvalidTool = false;
    for (const tc of pendingToolCalls.values()) {
      const validated = validateFinalizedCall(deps.registry, tc.id, tc.name, tc.argsJson);
      if (!validated.ok) {
        hadInvalidTool = true;
        // Record the model's tool_use (empty input — safe to replay to any
        // provider) and answer it immediately with a structured error.
        assistantContent.push(toolUse(tc.id, tc.name, {}));
        emit?.({ kind: 'tool_call_end', id: tc.id, name: tc.name, input: {} });
        const errMsg: Message = {
          role: 'tool',
          content: [mkToolResult(tc.id, tc.name, validated.output, true)],
        };
        transcript.push(errMsg);
        await checkpoint(errMsg, {
          toolCallId: tc.id, toolName: tc.name,
          input: { raw: redact(tc.argsJson).slice(0, 500) }, output: validated.output, isError: true,
        });
        let attempted: Record<string, unknown> = {};
        try {
          attempted = JSON.parse(tc.argsJson) as Record<string, unknown>;
        } catch {
          attempted = {};
        }
        telemetry.recordToolError(toolUse(tc.id, tc.name, attempted), validated.code);
        emitKlyro({ type: 'tool.result', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', callId: tc.id, name: tc.name, output: validated.output, isError: true, latencyMs: 0 });
        emit?.({ kind: 'tool_result', id: tc.id, name: tc.name, output: validated.output, isError: true, latencyMs: 0 });
        continue;
      }
      finalizedCalls.push(toolUse(tc.id, tc.name, validated.input));
      assistantContent.push(toolUse(tc.id, tc.name, validated.input));
      emit?.({ kind: 'tool_call_end', id: tc.id, name: tc.name, input: validated.input });
    }
    const assistantMsg: Message = { role: 'assistant', content: assistantContent };
    transcript.push(assistantMsg);
    await checkpoint(assistantMsg);
    // Invalidate token cache since transcript changed
    tokenCache = { lastRef: null, lastSystem: undefined, lastCount: 0 };

    // No tool calls → potential completion (Level 8 verify gate)
    if (opts.signal?.aborted) {
      finalText = textBuf;
      emit?.({ kind: 'aborted' });
      if (store && sessionId) {
        try { await store.setStatus(sessionId, 'aborted', finalText); } catch { /* ignore */ }
      }
      await closeTracer();
      return { status: 'aborted', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: hasEdits ? withRepairTokens({ ok: false, attempts: verificationAttempts }) : undefined };
    }
    if (finalizedCalls.length === 0) {
      if (hadInvalidTool) {
        // The model attempted a tool call that failed validation; the error is
        // already a tool_result in the transcript — loop so the model can
        // repair next turn instead of treating an answerable error as a
        // completion. Bounded by maxSteps and stuck detection (P0-3).
        emit?.({ kind: 'step_end', step: steps });
        continue;
      }
      finalText = textBuf;
      // Verify modes: 'off' skips the pipeline entirely (verification stays
      // undefined, no repair turns). 'advisory' runs verify once on
      // completion and reports the outcome without repair turns. 'strict'
      // (default) runs the full pipeline with autonomous repair below.
      if (verifyMode === 'off') {
        emit?.({ kind: 'final_text', text: finalText });
        emit?.({ kind: 'step_end', step: steps });
        if (store && sessionId) {
          try { await store.setStatus(sessionId, 'complete', finalText); } catch { /* ignore */ }
        }
        await closeTracer();
        return { status: 'complete', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: undefined };
      }
      if (verifyMode === 'advisory') {
        const advisoryCmd = opts.verify?.command ?? detectVerifyCommand(opts.cwd);
        if (opts.verify?.enabled !== false && hasEdits && advisoryCmd) {
          emit?.({ kind: 'verification_started', command: advisoryCmd });
          let advisoryResult: VerifyResult;
          try {
            // CONTRACT (a): sessionId passthrough to the verify engine.
            advisoryResult = await verify({ cwd: opts.cwd, command: advisoryCmd, timeoutMs: opts.verify?.timeoutMs, ...(sessionId ? { sessionId } : {}) });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            advisoryResult = { ok: false, exitCode: -1, stdout: '', stderr: msg, failure: { type: 'unknown', files: [], raw: msg, exitCode: -1 } };
          }
          verificationAttempts++;
          if (advisoryResult.ok) {
            inRepairTurn = false;
            emit?.({ kind: 'verification_succeeded', command: advisoryCmd });
            emit?.({ kind: 'final_text', text: finalText });
            emit?.({ kind: 'step_end', step: steps });
            if (store && sessionId) {
              try { await store.setStatus(sessionId, 'complete', finalText); } catch { /* ignore */ }
            }
            await closeTracer();
            return { status: 'complete', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: withRepairTokens({ ok: true, command: advisoryCmd, attempts: verificationAttempts }) };
          }
          const advisoryFailure = advisoryResult.failure?.type ?? 'unknown';
          markRepairStarted();
          emit?.({ kind: 'verification_failed', step: String(steps), reason: diagnosticForModel(advisoryResult).slice(0, 800) });
          emit?.({ kind: 'final_text', text: finalText });
          emit?.({ kind: 'step_end', step: steps });
          if (store && sessionId) {
            try { await store.setStatus(sessionId, 'complete', finalText); } catch { /* ignore */ }
          }
          await closeTracer();
          return { status: 'complete', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: withRepairTokens({ ok: false, command: advisoryCmd, attempts: verificationAttempts, failureType: advisoryFailure }) };
        }
        // No verify applicable (disabled, no edits, or no command) — fall
        // through to the normal completion return below.
      }
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
        // 6.3 — cheap sanity checks FIRST (fail fast before the suite runs).
        // (Previously these ran after a green verify — pure waste.)
        let sanityVResult: VerifyResult | undefined;
        for (const f of edited.slice(-3)) {
          const sc = await syntaxCheck(opts.cwd, f);
          if (!sc.ok) {
            sanityVResult = { ok: false, exitCode: 1, stdout: '', stderr: sc.error ?? `syntax error ${f}`, failure: { type: 'build', files: [{ path: f, message: sc.error ?? 'syntax error' }], raw: sc.error ?? '', exitCode: 1 } } as VerifyResult;
            break;
          }
          const ic = checkImports(opts.cwd, f);
          if (!ic.ok) {
            sanityVResult = { ok: false, exitCode: 1, stdout: '', stderr: `missing imports in ${f}: ${ic.missing.join(', ')}`, failure: { type: 'build', files: ic.missing.map((m) => ({ path: f, message: `missing import ${m}` })), raw: `missing imports ${ic.missing.join(', ')}`, exitCode: 1 } } as VerifyResult;
            break;
          }
        }
        if (sanityVResult) {
          vResult = sanityVResult;
        } else {
          try {
            if (isScoped) {
              const sr = await runScopedVerify(opts.cwd, cmdToRun, opts.verify?.timeoutMs);
              const det = sr.ok ? undefined : (await import('../verification/detect.js')).detect(sr.stdout, sr.stderr, sr.exitCode);
              vResult = { ok: sr.ok, exitCode: sr.exitCode, stdout: sr.stdout, stderr: sr.stderr, ...(det ? { failure: det } : {}) } as VerifyResult;
            } else {
              vResult = await verify({ cwd: opts.cwd, command: cmdToRun, timeoutMs: opts.verify?.timeoutMs, ...(sessionId ? { sessionId } : {}) });
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vResult = { ok: false, exitCode: -1, stdout: '', stderr: msg, failure: { type: 'unknown', files: [], raw: msg, exitCode: -1 } };
          }
        }
        // If scoped passed but full may still fail, run full before declaring success
        if (vResult.ok && isScoped) {
          try {
            const full = await verify({ cwd: opts.cwd, command: verifyCmd, timeoutMs: opts.verify?.timeoutMs, ...(sessionId ? { sessionId } : {}) });
            if (!full.ok) vResult = full;
          } catch { /* scoped success is enough */ }
        }
        if (vResult.ok) {
          inRepairTurn = false;
          emit?.({ kind: 'verification_succeeded', command: verifyCmd });
          emit?.({ kind: 'final_text', text: finalText });
          emit?.({ kind: 'step_end', step: steps });
          if (store && sessionId) {
            try { await store.setStatus(sessionId, 'complete', finalText); } catch { /* ignore */ }
          }
          await closeTracer();
          return { status: 'complete', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: withRepairTokens({ ok: true, command: verifyCmd, attempts: verificationAttempts }) };
        }
        // 6.4 — classify
        const baseline = await getBaseline(opts.cwd, verifyCmd);
        const isFlaky = await rerunOnce(opts.cwd, cmdToRun, opts.verify?.timeoutMs ?? 45_000);
        const cls = classifyFailure({ failure: vResult.failure, stdout: vResult.stdout, stderr: vResult.stderr }, baseline, isFlaky);
        if (cls === 'flaky') {
          // rerun succeeded on second try — treat as flaky, don't count as repair
          inRepairTurn = false;
          emit?.({ kind: 'verification_succeeded', command: verifyCmd });
          emit?.({ kind: 'final_text', text: finalText });
          emit?.({ kind: 'step_end', step: steps });
          if (store && sessionId) {
            try { await store.setStatus(sessionId, 'complete', finalText); } catch { /* ignore */ }
          }
          await closeTracer();
          return { status: 'complete', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: withRepairTokens({ ok: true, command: verifyCmd, attempts: verificationAttempts }) };
        }
        if (cls === 'env') {
          // don't try to repair env failures with code edits
          const envMsg: Message = { role: 'user', content: [text(`Verification failed due to environment issue (not code):\n\n${diagnosticForModel(vResult)}\n\nPlease suggest how to fix the environment (install deps, set env vars) rather than editing code. If this is a missing binary, ask the user.`)] };
          transcript.push(envMsg);
          await checkpoint(envMsg);
          verificationAttempts++;
          markRepairStarted();
          emit?.({ kind: 'verification_failed', step: String(steps), reason: `env: ${diagnosticForModel(vResult).slice(0, 600)}` });
          if (verificationAttempts >= maxRepairs) {
            await closeTracer();
            return { status: 'verify_failed', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: withRepairTokens({ ok: false, command: verifyCmd, attempts: verificationAttempts, failureType: 'env' }) };
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
            inRepairTurn = false;
            emit?.({ kind: 'verification_succeeded', command: verifyCmd });
            emit?.({ kind: 'final_text', text: finalText });
            emit?.({ kind: 'step_end', step: steps });
            if (store && sessionId) {
              try { await store.setStatus(sessionId, 'complete', finalText); } catch { /* ignore */ }
            }
            await closeTracer();
            return { status: 'complete', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: withRepairTokens({ ok: true, command: verifyCmd, attempts: verificationAttempts }) };
          }
        }
        // Failure → repair loop (introduced)
        verificationAttempts++;
        markRepairStarted();
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
          return { status: 'verify_failed', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: withRepairTokens({ ok: false, command: verifyCmd, attempts: verificationAttempts, failureType }) };
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
      return { status: 'complete', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: hasEdits ? withRepairTokens({ ok: true, attempts: verificationAttempts }) : undefined };
    }

    // 3.1 — emit turn events
    emitKlyro({ type: 'turn.start', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', turn: steps, model: opts.model });

    // Execute each tool call (after policy) — 3.5 parallel if all concurrencySafe
    // Extended context carries sibling-C contract fields (agentAllowedPaths,
    // repairGuard) via an intersection so this file compiles whether or not
    // the sibling has landed those members on ToolContext yet.
    type ExtendedToolContext = ToolContext & {
      agentAllowedPaths?: readonly string[];
      repairGuard?: { denyTestEdits: boolean };
    };
    const toolCtx: ExtendedToolContext = {
      cwd: opts.cwd,
      env: process.env,
      signal: opts.signal,
      nonInteractive: opts.nonInteractive,
      sessionId,
      ...(opts.agentBridge ? { agentBridge: opts.agentBridge } : {}),
      ...(opts.parentContext?.taskId
        ? { parentTaskId: opts.parentContext.parentTaskId ?? opts.parentContext.taskId }
        : {}),
      agentDepth: opts.parentContext?.depth ?? 0,
      agentMaxDepth: opts.parentContext?.maxDepth ?? 1,
      ...(opts.parentContext?.allowedTools ? { agentAllowedTools: opts.parentContext.allowedTools } : {}),
      ...(opts.parentContext?.allowedPaths ? { agentAllowedPaths: opts.parentContext.allowedPaths } : {}),
      ...(opts.parentContext?.model ?? opts.model ? { agentModel: opts.parentContext?.model ?? opts.model } : {}),
      repairGuard: { denyTestEdits: inRepairTurn },
    };
    const allSafe = finalizedCalls.length > 1 && finalizedCalls.every((c) => deps.registry.get(c.name)?.isConcurrencySafe !== false);
    // Gate phase: policy decision + approval prompt for one call. Runs
    // sequentially (approval UI is one-modal-at-a-time). Commits deny/user-deny
    // results immediately — gate runs in call order so these stay ordered.
    // Returns true when the call is approved for execution.
    const gateCall = async (call: typeof finalizedCalls[number]): Promise<boolean> => {
      const decision = await deps.policy.evaluate(
        { name: call.name, input: call.input },
        { cwd: opts.cwd, nonInteractive: opts.nonInteractive },
      );
      emit?.({ kind: 'policy_decision', id: call.id, name: call.name, action: decision.action, ...(decision.action !== 'allow' ? { reason: (decision as { reason?: string }).reason } : {}) });
      // Mirror to KlyroEvent bus
      if (decision.action === 'allow') {
        emitKlyro({ type: 'permission.decision', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', callId: call.id, action: 'allow' });
      } else {
        emitKlyro({ type: 'permission.decision', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', callId: call.id, action: decision.action, reason: (decision as { reason?: string }).reason });
      }

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
        return false;
      }

      if (decision.action === 'ask') {
        emitKlyro({ type: 'permission.ask', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', callId: call.id, name: call.name, reason: decision.reason });
        const choice = await deps.approval.ask({
          toolName: call.name,
          reason: decision.reason,
          summary: summarizeToolCall(call),
          input: call.input,
          pattern: patternForCall(call.name, call.input),
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
          return false;
        }
        // Handle 'edit' choice: for now treat as allow with edited input (future: re-prompt)
        repairs++;
      }
      return true;
    };

    // Execute phase: run the tool with no transcript writes, so concurrent
    // executions can't interleave. A throw here becomes a tool error (an
    // executor crash must never kill the step).
    const execTool = async (
      call: typeof finalizedCalls[number],
    ): Promise<{ obs: import('../tools/types.js').ToolResult<unknown>; latencyMs: number }> => {
      const t0 = Date.now();
      emitKlyro({ type: 'tool.call', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', callId: call.id, name: call.name, input: call.input });
      // Hooks: every preToolUse hook runs before execution. A non-zero exit
      // denies the tool with POLICY_DENIED — the real tool never runs.
      if (preHooks.length > 0) {
        for (const hook of preHooks) {
          let exitCode: number | null = -1;
          let detail = '';
          try {
            const r = await runHook(hook, { toolName: call.name, input: call.input });
            exitCode = r.exitCode;
            detail = (r.stderr || r.stdout || '').slice(0, 300);
          } catch (err) {
            detail = String(err instanceof Error ? err.message : err).slice(0, 300);
          }
          if (exitCode !== 0) {
            const reason = `hook ${hook.name} denied: ${detail || 'hook failed'}`;
            emit?.({ kind: 'policy_decision', id: call.id, name: call.name, action: 'deny', reason });
            emitKlyro({ type: 'permission.decision', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', callId: call.id, action: 'deny', reason });
            const latencyMs = Date.now() - t0;
            return {
              obs: { ok: false, error: { code: 'POLICY_DENIED', message: reason } } as import('../tools/types.js').ToolResult<unknown>,
              latencyMs,
            };
          }
        }
      }
      let obs: import('../tools/types.js').ToolResult<unknown>;
      try {
        obs = await deps.registry.execute(call.name, call.input, toolCtx);
      } catch (err) {
        obs = { ok: false, error: { code: 'EXEC_CRASH', message: err instanceof Error ? err.message : String(err) } } as import('../tools/types.js').ToolResult<unknown>;
      }
      const latencyMs = Date.now() - t0;
      return { obs, latencyMs };
    };

    // 5.2 stuck termination (P0-3): the FIRST detection injects one
    // "change approach" synthetic message for the next model turn; the SECOND
    // detection aborts the automated loop with a `stuck` status so a repeated
    // tool loop never burns unbounded tokens. Covers both signals: identical
    // call ×3 and same-file edited >8×.
    const markStuck = async (msg: string): Promise<void> => {
      stuckTriggers++;
      emitKlyro({ type: 'error', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', code: 'stuck', message: msg });
      if (stuckTriggers === 1) {
        const note: Message = { role: 'user', content: [text(`[system note] Stuck detected: ${msg}. Stop repeating the same action; change approach.`)] };
        transcript.push(note);
        await checkpoint(note);
      } else {
        stuckAbort = true;
      }
    };

    // Commit phase: fold one execution result into the transcript, in original
    // call order. The only writer — call sequentially, never concurrently.
    const commitResult = async (
      call: typeof finalizedCalls[number],
      obs: import('../tools/types.js').ToolResult<unknown>,
      latencyMs: number,
    ): Promise<void> => {
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
            await markStuck(`same file edited >8×: ${fileChanged.path}`);
          }
        }
      }
      // 5.2 identical call ×3
      const sig = `${call.name}:${JSON.stringify(call.input).slice(0, 200)}`;
      callHistory.push(sig);
      if (callHistory.length > 10) callHistory.shift();
      const last3 = callHistory.slice(-3);
      if (last3.length === 3 && last3[0] === last3[1] && last3[1] === last3[2]) {
        await markStuck(`identical call ×3: ${sig}`);
      }
      // Hooks: postToolUse hooks are best-effort — failures warn on stderr
      // plus a bus event, and never fail the turn.
      if (postHooks.length > 0) {
        for (const hook of postHooks) {
          try {
            const r = await runHook(hook, { toolName: call.name, input: call.input });
            if (!r.ok || r.exitCode !== 0) {
              const msg = `klyro: hooks: postToolUse ${hook.name} failed (exit ${String(r.exitCode)}): ${(r.stderr || r.stdout || '').slice(0, 200)}\n`;
              try { process.stderr.write(msg); } catch { /* ignore */ }
              emitKlyro({ type: 'error', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', code: 'hook_failed', message: msg.slice(0, 300) });
            }
          } catch (err) {
            const msg = `klyro: hooks: postToolUse ${hook.name} error: ${String(err instanceof Error ? err.message : err).slice(0, 200)}\n`;
            try { process.stderr.write(msg); } catch { /* ignore */ }
            emitKlyro({ type: 'error', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', code: 'hook_failed', message: msg.slice(0, 300) });
          }
        }
      }
    };

    // Sequential path: gate → execute → commit per call, in order.
    const runOne = async (call: typeof finalizedCalls[number]): Promise<void> => {
      if (!(await gateCall(call))) return;
      const { obs, latencyMs } = await execTool(call);
      await commitResult(call, obs, latencyMs);
    };

    // 3.5 — parallel when every call is concurrencySafe, sequential otherwise.
    // Gate runs sequentially in both paths (approval UI is one-at-a-time).
    // Parallel path executes concurrently but commits in original call order,
    // so the transcript reads exactly as if the calls ran in order (this is
    // what the old BUG-002 sequential fallback was protecting).
    if (allSafe) {
      const approved: typeof finalizedCalls = [];
      for (const call of finalizedCalls) {
        toolCallCount++;
        if (await gateCall(call)) approved.push(call);
        if (opts.signal?.aborted) break;
      }
      if (approved.length > 0 && !opts.signal?.aborted) {
        // Fan-out cap: execute in sequential chunks of MAX_PARALLEL_TOOLS.
        // Commits below stay in original call order, so the transcript is
        // unaffected by the chunking.
        const settled: PromiseSettledResult<{ obs: import('../tools/types.js').ToolResult<unknown>; latencyMs: number }>[] = [];
        for (let off = 0; off < approved.length; off += MAX_PARALLEL_TOOLS) {
          if (opts.signal?.aborted) break;
          const chunk = approved.slice(off, off + MAX_PARALLEL_TOOLS);
          settled.push(...await Promise.allSettled(chunk.map((c) => execTool(c))));
        }
        for (let i = 0; i < settled.length; i++) {
          const s = settled[i]!;
          if (s.status === 'fulfilled') {
            await commitResult(approved[i]!, s.value.obs, s.value.latencyMs);
          } else {
            await commitResult(
              approved[i]!,
              { ok: false, error: { code: 'EXEC_CRASH', message: String(s.reason) } } as import('../tools/types.js').ToolResult<unknown>,
              0,
            );
          }
        }
      }
    } else {
      for (const call of finalizedCalls) {
        toolCallCount++;
        await runOne(call);
        if (opts.signal?.aborted) break;
      }
    }
    // P0 — drain finished sub-agent completions into parent visibility.
    // drainCompletions is OPTIONAL on the bridge — guarded with `?.` so
    // older bridges without it simply yield nothing.
    try {
      const completions = opts.agentBridge?.drainCompletions?.() ?? [];
      for (const c of completions) {
        const body = c.finalText ?? c.error?.message ?? '';
        const msg: Message = { role: 'user', content: [text(`Subtask ${c.taskId} (${c.agentName}) ${c.status}: ${body.slice(0, 500)}`)] };
        transcript.push(msg);
        await checkpoint(msg);
      }
    } catch { /* ignore — completions are best-effort visibility */ }
    emit?.({ kind: 'step_end', step: steps });
    emitKlyro({ type: 'turn.end', ts: Date.now(), sessionId: sessionId ?? 'ephemeral', turn: steps });
    // Level 9 — checkpoint status after each step
    if (store && sessionId) {
      try { await store.setStatus(sessionId, 'open'); } catch { /* ignore */ }
    }
    // 5.2 — terminate the automated loop once stuck recurs after the note
    if (stuckAbort) break;
  }

  if (opts.signal?.aborted) {
    emit?.({ kind: 'aborted' });
    if (store && sessionId) {
      try { await store.setStatus(sessionId, 'aborted', finalText); } catch { /* ignore */ }
    }
    await closeTracer();
    return { status: 'aborted', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: hasEdits ? withRepairTokens({ ok: false, attempts: verificationAttempts }) : undefined };
  }

  // 5.2 — stuck termination (P0-3): bounded stop instead of unbounded token burn.
  if (stuckAbort) {
    emit?.({ kind: 'final_text', text: finalText });
    if (store && sessionId) {
      try { await store.setStatus(sessionId, 'stuck', finalText); } catch { /* ignore */ }
    }
    await closeTracer();
    return { status: 'stuck', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: hasEdits ? withRepairTokens({ ok: false, attempts: verificationAttempts }) : undefined };
  }

  emit?.({ kind: 'final_text', text: finalText });
  if (store && sessionId) {
    try { await store.setStatus(sessionId, 'max_steps', finalText); } catch { /* ignore */ }
  }
  await closeTracer();
  return { status: 'max_steps', steps, toolCalls: toolCallCount, finalText, transcript, hasEdits, usage, repairs, verification: hasEdits ? withRepairTokens({ ok: false, attempts: verificationAttempts }) : undefined };
}

/**
 * Estimate usage for a turn whose provider omitted it (Ollama, vLLM,
 * proxies). Input is measured from the actual request via the tokenizer;
 * output is a chars/4 heuristic over generated text + tool arguments.
 */
function estimateTurnUsage(
  system: string | undefined,
  messages: Message[],
  textOut: string,
  toolCalls: Map<string, { argsJson: string }>,
): { input: number; output: number } {
  let argsChars = 0;
  for (const tc of toolCalls.values()) argsChars += tc.argsJson.length;
  return {
    input: totalTokens(system, messages),
    output: Math.max(1, Math.ceil((textOut.length + argsChars) / 4)),
  };
}

type FinalizedValidation =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; code: string; output: { code: string; tool: string; message: string; retryable: boolean } };

/**
 * Validate one assembled tool call before it reaches policy or execution.
 * Returns the parsed+schema-validated input, or a structured error output
 * (MALFORMED_TOOL_CALL / UNKNOWN_TOOL) that the runtime records as a tool
 * result without executing anything.
 */
function validateFinalizedCall(
  registry: ToolRegistry,
  id: string,
  name: string,
  argsJson: string,
): FinalizedValidation {
  void id;
  let parsed: unknown = {};
  if (argsJson.trim()) {
    try {
      parsed = JSON.parse(argsJson);
    } catch {
      return {
        ok: false,
        code: 'MALFORMED_TOOL_CALL',
        output: {
          code: 'MALFORMED_TOOL_CALL',
          tool: name,
          message: 'Tool arguments were incomplete or invalid JSON. Re-issue the call with complete arguments.',
          retryable: true,
        },
      };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'MALFORMED_TOOL_CALL',
      output: {
        code: 'MALFORMED_TOOL_CALL',
        tool: name,
        message: 'Tool arguments must be a JSON object. Re-issue the call with complete arguments.',
        retryable: true,
      },
    };
  }
  const tool = registry.get(name);
  if (!tool) {
    return {
      ok: false,
      code: 'UNKNOWN_TOOL',
      output: {
        code: 'MALFORMED_TOOL_CALL',
        tool: name,
        message: `Unknown tool "${name}". Use one of the available tools.`,
        retryable: true,
      },
    };
  }
  const checked = tool.inputSchema.safeParse(parsed);
  if (!checked.success) {
    const first = checked.error.issues[0];
    const detail = first ? ` (${first.path.join('.') || 'input'}: ${first.message})` : '';
    return {
      ok: false,
      code: 'MALFORMED_TOOL_CALL',
      output: {
        code: 'MALFORMED_TOOL_CALL',
        tool: name,
        message: `Tool arguments failed validation${detail}. Re-issue the call with correct arguments.`,
        retryable: true,
      },
    };
  }
  return { ok: true, input: parsed as Record<string, unknown> };
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
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'multi_edit') {
    // Distinguish create vs modify by the output shape: write_file returns
    // { path, bytesWritten }; edit_file returns { path, replacements, diff }.
    // Both are "modified" semantically; we don't have the pre-state easily
    // from inside the runtime. A more precise implementation would stat the
    // file before/after the call. For now: treat both as 'modified'.
    return { path: inPath, op: 'modified' };
  }
  if (toolName === 'apply_patch') {
    // apply_patch has no path input — infer from its patchedFiles output.
    const files = (output as { patchedFiles?: unknown })?.patchedFiles;
    if (Array.isArray(files) && typeof files[0] === 'string') {
      return { path: files[0], op: 'modified' };
    }
    return null;
  }
  return null;
}

export function defaultSystemPrompt(ctx: { cwd: string; telemetry?: string }): SystemPromptResult {
  const base = [
    'You are Klyro, an autonomous coding harness. You solve the user\'s task by',
    'calling tools in a loop. Prefer the smallest change that solves the task.',
    'When you have finished, produce a short final text answer (no tool calls).',
    'Do not invent file paths. Do not call tools outside the working directory.',
  ].join(' ');
  if (ctx.telemetry) {
    return {
      system: base,
      suffix: ctx.telemetry + '\n\nUse the telemetry above to avoid repeating the same failing call and to keep within the step budget.',
    };
  }
  return { system: base };
}
