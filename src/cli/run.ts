/**
 * `klyro run "<prompt>"` — one-shot autonomous task. Runs the agent loop
 * to completion (or max_steps) and prints the final text. Non-interactive:
 * policy denies `ask` decisions rather than prompting the user.
 *
 * Streams text deltas to stdout as they arrive so the user sees progress
 * even on a long task. Tool calls and policy decisions go to stderr so
 * they don't pollute the captured `finalText` if the user pipes.
 */

import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout, stderr } from 'node:process';
import { httpChatAdapter } from '../agent/provider-adapter.js';
import type { VerifyMode } from '../agent/runtime.js';
import { anthropicAdapter } from '../agent/anthropic-adapter.js';
import { retryingAdapter } from '../agent/retry.js';
import { globalBus } from '../events/bus.js';
import { run } from '../agent/runtime.js';
import type { SystemPromptFn } from '../agent/runtime.js';
import type { Message } from '../agent/message.js';
import { builtinRegistry } from '../tools/registry.js';
import { builtinRules, clonePolicyConfig, PolicyEngine } from '../policy/engine.js';
import { DenyAllApprovalPrompt } from '../policy/approval.js';
import { redact } from '../policy/secret-redactor.js';
import { buildLevel6Context } from '../context/level6.js';
import { memoryBlock } from '../context/memory.js';
import { estimateCost } from '../providers/model-info.js';
import { getDefaultSessionStore, resolveSessionId } from '../persistence/session.js';
import * as fs from 'node:fs';

export interface RunCliOptions {
  task: string;
  cwd: string;
  model: string;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: SystemPromptFn;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  abortOnSigint?: boolean;
  /** Inject a custom adapter (used by tests). If omitted, httpChatAdapter is used. */
  adapter?: import('../agent/provider-adapter.js').ProviderAdapter;
  /**
   * Provider kind to use when no custom adapter is supplied. Default 'openai'.
   * Set to 'anthropic' to use the Anthropic Messages API adapter; in that
   * case `baseUrl` defaults to https://api.anthropic.com and the auth header
   * is sent as `x-api-key` (or `Authorization: Bearer` if `authHeader: 'bearer'`).
   */
  provider?: 'openai' | 'anthropic';
  /** When provider='anthropic', override the auth header. Default 'x-api-key'. */
  authHeader?: 'x-api-key' | 'Authorization';
  /**
   * Output mode:
   *   - 'human' (default): text deltas on stdout, tool/policy on stderr
   *   - 'json': one JSON object per line per RuntimeEvent on stdout
   *   - 'silent': no streaming output; only the final text printed at the end
   */
  output?: 'human' | 'json' | 'silent';
  /**
   * Dry-run: don't actually call the model. Print the request that would
   * be made (system prompt + tool definitions + first user message) and
   * exit 0. Useful for inspecting the prompt assembly and verifying wiring.
   */
  dryRun?: boolean;
  /**
   * Path to a JSON file containing a saved transcript to resume from.
   * The file must have shape `{transcript: Message[]}` and optionally
   * `task?: string`. If `task` is present, it's used as the new user
   * turn; if absent, `opts.task` is appended.
   */
  resumePath?: string;
  /** Level 8 — verification */
  verify?: boolean;
  verifyCommand?: string;
  maxRepairAttempts?: number;
  verifyTimeoutMs?: number;
  requireVerify?: boolean;
  /** Verification mode: strict (default) runs the full repair pipeline;
   * advisory reports once without repairs; off skips verification. */
  verifyMode?: VerifyMode;
  /** Level 9 — persistence */
  persist?: boolean;
  sessionId?: string;
  sessionsDir?: string;
  /**
   * Bare mode (`--bare`): skip MCP servers, all hooks, memory/KLYRO.md/L6
   * context, and session persistence for fast deterministic runs. The model
   * gets the base system prompt + tools only.
   */
  bare?: boolean;
  /** P1.4 — run the task under a named child-capable orchestrator context. */
  agent?: string;
  maxDepth?: number;
}

/**
 * Double-Ctrl+C detector (pure, exported for tests): the second SIGINT
 * within 1500ms of the first forces `process.exit(130)`. The live handler
 * below owns the timestamp closure; tests exercise only this predicate.
 */
export function shouldForceExit(lastSigintAt: number | undefined, now: number): boolean {
  return lastSigintAt !== undefined && now - lastSigintAt < 1500;
}

export async function runOnce(opts: RunCliOptions): Promise<number> {
  // P0.5 — load <cwd>/.env first so KLYRO_* vars resolve without `export`.
  // Never throws (missing file is a no-op); explicit env wins (no-clobber).
  try {
    const { loadDotenv } = await import('./dotenv.js');
    loadDotenv(opts.cwd);
  } catch { /* ignore */ }
  const output = opts.output ?? 'human';

  if (opts.dryRun) {
    return await dryRunReport(opts);
  }

  // Fresh read-guard scope per run (shared module state otherwise leaks across runs).
  try {
    const { clearReadHistory } = await import('../tools/fs/read-history.js');
    clearReadHistory();
  } catch { /* ignore */ }

  // P1.4 — validate --agent early so typos fail fast (exit 2) even without API keys.
  if (opts.agent) {
    const { listAllAgents } = await import('../agent/orchestrator.js');
    const _known = listAllAgents(opts.cwd);
    if (!_known.some((a) => a.id === opts.agent)) {
      stderr.write(`klyro: unknown agent: ${opts.agent} (known: ${_known.map((a) => a.id).join(', ')})\n`);
      return 2;
    }
  }

  // Box so retry telemetry (emitted before the session exists) picks up the
  // real sessionId once create/resume assigns it below.
  const sessionIdForRetry = { id: 'ephemeral' };
  const onRetryEmit = (info: { attempt: number; status: string; retryAfterMs?: number }): void => {
    globalBus.emit({
      type: 'provider.retry',
      ts: Date.now(),
      sessionId: sessionIdForRetry.id,
      attempt: info.attempt,
      status: info.status,
      ...(info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {}),
    });
  };
  let adapter = opts.adapter;
  let chain: import('./config.js').ResolvedProviderEntry[] = [];
  if (!adapter) {
    // Single source of truth: the provider chain (flags > merged config >
    // env > defaults) resolves the primary identically everywhere, so CLI
    // flags (--provider/--api-key/--base-url) and every key env source apply
    // to the primary and to each failover entry alike.
    const { resolveProviderChain } = await import('./config.js');
    chain = await resolveProviderChain(opts.cwd, {
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    });
    const primary = chain[0]!;
    const provider = primary.provider;
    const baseUrl = primary.baseURL;
    const apiKey = primary.apiKey;
    if (!apiKey) {
      stderr.write('klyro: KLYRO_API_KEY is not set (or pass --api-key)\n');
      return 2;
    }
    if (provider === 'anthropic') {
      adapter = retryingAdapter(anthropicAdapter({
        baseURL: baseUrl,
        apiKey,
        timeoutMs: opts.timeoutMs ?? 60_000,
        authHeader: opts.authHeader,
      }), { onRetry: onRetryEmit });
    } else {
      if (!baseUrl) {
        stderr.write('klyro: KLYRO_BASE_URL is not set (or pass --base-url)\n');
        return 2;
      }
      adapter = retryingAdapter(httpChatAdapter({ baseURL: baseUrl, apiKey, timeoutMs: opts.timeoutMs ?? 60_000 }), { onRetry: onRetryEmit });
    }
  }
  // L15 provider failover: extra chain entries (after the primary) become
  // fallback adapters for the runtime. Custom injected adapters (tests)
  // skip chain wiring. Failures resolving the chain never block the run.
  // (Chain already resolved above with CLI flags; reuse it — no second
  // resolution, no divergent key sources.)
  let failoverAdapters: import('../agent/provider-adapter.js').ProviderAdapter[] | undefined;
  if (!opts.adapter) {
    try {
      const fallbacks = chain.slice(1);
      if (fallbacks.length > 0) {
        const built: import('../agent/provider-adapter.js').ProviderAdapter[] = [];
        for (const entry of fallbacks) {
          if (!entry.apiKey) continue;
          const base = entry.provider === 'anthropic'
            ? anthropicAdapter({ baseURL: entry.baseURL, apiKey: entry.apiKey, timeoutMs: opts.timeoutMs ?? 60_000 })
            : entry.baseURL
              ? httpChatAdapter({ baseURL: entry.baseURL, apiKey: entry.apiKey, timeoutMs: opts.timeoutMs ?? 60_000 })
              : null;
          if (base) built.push(retryingAdapter(base, { onRetry: onRetryEmit }));
        }
        if (built.length > 0) {
          failoverAdapters = built;
          stderr.write(`klyro: failover chain: ${built.map((b) => b.id).join(' → ')}\n`);
        }
      }
    } catch { /* best-effort — single-provider run proceeds */ }
  }
  const registry = builtinRegistry();
  const policy = new PolicyEngine(builtinRules(), clonePolicyConfig());
  // Persisted "always allow" patterns apply to one-shot runs too.
  try {
    const { loadPermissionRules } = await import('./config.js');
    policy.applyRules(await loadPermissionRules(opts.cwd));
  } catch {
    /* ignore — engine defaults stand */
  }
  // Best-effort MCP tools: never fatal, never prompts (headless cannot
  // approve). Project-sourced servers auto-connect ONLY when their exact
  // spec hash is already in the McpTrust store (e.g. approved in a prior
  // REPL session); unknown specs are skipped with a warning.
  // --bare skips MCP entirely (deterministic, no subprocesses).
  let closeMcp: (() => Promise<void>) | undefined;
  if (!opts.bare) {
  try {
    const { loadAndRegisterMcp } = await import('../mcp/registry.js');
    const { McpTrust, hashSpec } = await import('../mcp/trust.js');
    const { loadMcpServers } = await import('../mcp/config.js');
    const mcpTrust = new McpTrust();
    const mcpSpecs = loadMcpServers(opts.cwd).servers;
    const mcp = await loadAndRegisterMcp({
      cwd: opts.cwd,
      registry,
      policy,
      approveProjectServer: async ({ name }: { name: string }) => {
        const spec = mcpSpecs[name];
        if (spec && mcpTrust.isTrusted(name, hashSpec(spec))) return true;
        stderr.write(`klyro: mcp project server "${name}" not in trust store (skipped — headless cannot prompt)\n`);
        return false;
      },
    });
    for (const e of mcp.errors) stderr.write(`klyro: mcp ${e.server}: ${e.message}\n`);
    if (mcp.registered.length > 0 && output === 'human') {
      stderr.write(`klyro: mcp tools: ${mcp.registered.join(', ')}\n`);
    }
    closeMcp = mcp.closeAll;
  } catch { /* ignore — MCP is optional */ }
  }
  const systemPrompt = await makeRunSystemPrompt(opts.cwd, opts.systemPrompt ?? defaultRunSystemPrompt, opts.bare);

  // Level 9 — session setup (create or resume). --bare skips persistence.
  const persistEnabled = opts.persist !== false && !opts.bare;
  let store: import('../persistence/store.js').SessionStore | undefined;
  let sessionId: string | undefined;
  let initialTranscript: Message[] | undefined;
  if (persistEnabled) {
    const { SessionStore } = await import('../persistence/store.js');
    const { getDefaultSessionStore } = await import('../persistence/session.js');
    store = opts.sessionsDir ? new SessionStore(opts.sessionsDir) : getDefaultSessionStore();
    if (opts.resumePath) {
      initialTranscript = loadTranscript(opts.resumePath);
    } else if (opts.sessionId) {
      const full = await resolveSessionId(store, opts.sessionId);
      if (!full) {
        stderr.write(`klyro: session not found: ${opts.sessionId}\n`);
        return 2;
      }
      sessionId = full;
      // M22 resume-lock warning (read-only probe — takeover proceeds anyway).
      try {
        const { readSessionLock } = await import('../persistence/store.js');
        const { getDefaultSessionsDir } = await import('../persistence/session.js');
        const lock = readSessionLock(opts.sessionsDir ?? getDefaultSessionsDir(), sessionId);
        if (lock.held && lock.alive) {
          stderr.write(`klyro: session ${sessionId.slice(0, 8)} is locked by live pid ${lock.pid ?? '?'} — taking over (proceeding anyway)\n`);
        }
      } catch { /* probe is best-effort; never block resume */ }
      const msgs = await store.loadMessages(sessionId);
      // Convert StoredMessage to Message
      initialTranscript = msgs.map((m) => ({ role: m.role as Message['role'], content: m.content as Message['content'] }));
      const rec = await store.get(sessionId);
      if (rec) {
        stderr.write(`klyro: resuming session ${sessionId.slice(0, 8)} — task: "${rec.task}"\n`);
      }
    } else if (opts.resumePath) {
      // already handled
    } else {
      // Create new session
      const rec = await store.create({ cwd: opts.cwd, task: opts.task, config: { model: opts.model, maxSteps: opts.maxSteps ?? 30 } });
      sessionId = rec.id;
      if (output !== 'silent' && output !== 'json') {
        stderr.write(`klyro: session ${sessionId.slice(0, 8)} created\n`);
      }
    }
  } else if (opts.resumePath) {
    initialTranscript = loadTranscript(opts.resumePath);
  }
  // Publish the real sessionId to retry telemetry (stays 'ephemeral' when
  // persistence is disabled or the session was never created).
  sessionIdForRetry.id = sessionId ?? 'ephemeral';

  const ac = new AbortController();
  // Double-Ctrl+C: first press aborts the run; a second press within
  // 1500ms forces process.exit(130) (shouldForceExit owns the predicate).
  let lastSigintAt: number | undefined;
  const onSigint = (): void => {
    const now = Date.now();
    if (shouldForceExit(lastSigintAt, now)) {
      stderr.write('\nklyro: SIGINT twice — forcing exit\n');
      process.exit(130);
      return;
    }
    lastSigintAt = now;
    stderr.write('\nklyro: SIGINT — aborting\n');
    ac.abort();
  };
  if (opts.abortOnSigint !== false) {
    process.once('SIGINT', onSigint);
  }
  const doneSigint = (): void => {
    process.removeListener('SIGINT', onSigint);
  };

  const verifyOpts = opts.verify === false
    ? { enabled: false as const }
    : {
        enabled: true as const,
        command: opts.verifyCommand,
        maxRepairAttempts: opts.maxRepairAttempts ?? 3,
        timeoutMs: opts.verifyTimeoutMs,
        requireVerify: opts.requireVerify,
        ...(opts.verifyMode ? { mode: opts.verifyMode } : {}),
      };

  let result: Awaited<ReturnType<typeof run>>;
  let endStatus = 'error';
  // P1.4 — if --agent is requested, stand up a parent orchestrator so the
  // model can call spawn_agent / task_list / task_get. The root run keeps
  // depth 0; children are capped at maxDepth (default 1 per r-6-10.fix.md).
  let agentBridge: import('../agent/orchestrator.js').AgentSpawnBridge | undefined;
  let parentContext: import('../agent/runtime.js').RunOptions['parentContext'];
  if (opts.agent) {
    const { AgentOrchestrator, findAgent } = await import('../agent/orchestrator.js');
    const def = findAgent(opts.agent, opts.cwd)!; // validated above
    const maxDepth = opts.maxDepth ?? 1;
    const rootDeps = { adapter, registry, policy, approval: new DenyAllApprovalPrompt(), systemPrompt };
    const orchestrator = new AgentOrchestrator({ sessionId: sessionId ?? 'ephemeral', deps: rootDeps, cwd: opts.cwd });
    const allowedTools = new Set(registry.list().map((t) => t.name));
    parentContext = {
      sessionId: sessionId ?? 'ephemeral',
      depth: 0,
      maxDepth,
      allowedTools,
      model: def.model ?? opts.model,
    };
    agentBridge = orchestrator.bridgeFor({
      sessionId: sessionId ?? 'ephemeral',
      cwd: opts.cwd,
      depth: 0,
      maxDepth,
      allowedTools,
      model: def.model ?? opts.model,
    });
  } else if (opts.maxDepth !== undefined) {
    const allowedTools = new Set(registry.list().map((t) => t.name));
    const { AgentOrchestrator } = await import('../agent/orchestrator.js');
    const rootDeps = { adapter, registry, policy, approval: new DenyAllApprovalPrompt(), systemPrompt };
    const orchestrator = new AgentOrchestrator({ sessionId: sessionId ?? 'ephemeral', deps: rootDeps });
    parentContext = { sessionId: sessionId ?? 'ephemeral', depth: 0, maxDepth: opts.maxDepth, allowedTools, model: opts.model };
    agentBridge = orchestrator.bridgeFor({
      sessionId: sessionId ?? 'ephemeral',
      cwd: opts.cwd,
      depth: 0,
      maxDepth: opts.maxDepth,
      allowedTools,
      model: opts.model,
    });
  }
  try {
    result = await run(
    {
      task: opts.task,
      cwd: opts.cwd,
      model: opts.model,
      ...(opts.bare ? { bare: true as const } : {}),
      maxSteps: opts.maxSteps,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      signal: ac.signal,
      nonInteractive: true,
      initialTranscript,
      verify: verifyOpts,
      persist: store && sessionId ? { store, sessionId } : undefined,
      ...(agentBridge ? { agentBridge } : {}),
      ...(parentContext ? { parentContext } : {}),
      onEvent: (ev) => {
        if (output === 'json') {
          stdout.write(JSON.stringify(ev) + '\n');
          return;
        }
        if (output === 'silent') {
          return;
        }
        // human mode
        if (ev.kind === 'text_delta') stdout.write(ev.text);
        else if (ev.kind === 'tool_call_start') {
          stderr.write(`\n[tool] ${ev.name} {\n`);
        } else if (ev.kind === 'tool_call_end') {
          stderr.write(`\n}\n`);
        } else if (ev.kind === 'tool_result') {
          const summary = typeof ev.output === 'string' ? ev.output.slice(0, 200) : JSON.stringify(ev.output).slice(0, 200);
          stderr.write(`  -> ${ev.isError ? 'ERR ' : 'ok  '}(${ev.latencyMs}ms) ${summary}\n`);
        } else if (ev.kind === 'policy_decision' && ev.action !== 'allow') {
          stderr.write(`  policy: ${ev.action}${ev.reason ? ` — ${ev.reason}` : ''}\n`);
        } else if (ev.kind === 'step_start') {
          stderr.write(`\n[step ${ev.step}]\n`);
        } else if (ev.kind === 'verification_started') {
          stderr.write(`\n[verify] running \`${ev.command}\`\n`);
        } else if (ev.kind === 'verification_succeeded') {
          stderr.write(`[verify] passed\n`);
        } else if (ev.kind === 'verification_failed') {
          stderr.write(`[verify] failed — ${ev.reason.slice(0, 200)}\n`);
        } else if (ev.kind === 'repair_started') {
          stderr.write(`[repair] attempt ${ev.attempt}/${ev.maxAttempts}\n`);
        } else if (ev.kind === 'checkpoint_saved') {
          if (output === 'human') stderr.write(`[session ${ev.sessionId.slice(0, 8)} checkpoint]\n`);
        } else if (ev.kind === 'provider_failover') {
          stderr.write(`[failover] ${ev.from} → ${ev.to}: ${ev.reason.slice(0, 200)}\n`);
        } else if (ev.kind === 'budget_warning') {
          stderr.write(`[budget] ${(ev.ratio * 100).toFixed(0)}% of max cost used (threshold ${(ev.threshold * 100).toFixed(0)}%)\n`);
        } else if (ev.kind === 'model_override') {
          stderr.write(`[model] override: requested ${ev.requested} → effective ${ev.effective}\n`);
        }
      },
    },
      {
        adapter, registry, policy, approval: new DenyAllApprovalPrompt(), systemPrompt,
        ...(failoverAdapters ? { failoverAdapters } : {}),
      },
    );
    endStatus = result.status;
  } finally {
    doneSigint();
    try { await closeMcp?.(); } catch { /* ignore */ }
    // sessionEnd hooks: best-effort end-of-run side effects (logging,
    // notifications, cleanup). Skipped in --bare. Never affects exit code.
    if (!opts.bare) {
    try {
      const { runSessionEndHooks } = await import('./hooks.js');
      const outs = await runSessionEndHooks(opts.cwd, sessionId, endStatus);
      for (const o of outs) {
        if (output !== 'silent' && o.output) stderr.write(`[hook ${o.name}] ${o.output.slice(0, 300)}\n`);
      }
    } catch { /* ignore */ }
    }
  }

  if (store && sessionId) {
    // Finalize session status
    const statusMap: Record<string, import('../persistence/store.js').SessionStatus> = {
      complete: 'complete',
      max_steps: 'max_steps',
      limit: 'max_steps',
      aborted: 'aborted',
      no_final: 'aborted',
      verify_failed: 'verify_failed',
      stuck: 'stuck',
    };
    try {
      await store.setStatus(sessionId, statusMap[result.status] ?? 'complete', result.finalText);
    } catch { /* ignore */ }
    if (output !== 'json' && output !== 'silent') {
      stderr.write(`klyro: session ${sessionId.slice(0, 8)} ${result.status}`);
      if (result.verification) stderr.write(`  verify: ${result.verification.ok ? 'ok' : 'failed'} (${result.verification.attempts} attempts)`);
      stderr.write('\n');
    }
  }

  if (output === 'human') stdout.write('\n');
  // Final cost line: headless runs previously surfaced cost only through
  // [budget] warnings. Human/silent → stderr one-liner; json → additive
  // cost_usd/usage fields on the final object (purely additive, no shape break).
  const finalCost = estimateCost(opts.model, result.usage.input, result.usage.output);
  const costLine = `$${finalCost.toFixed(4)} · ${result.usage.input} in / ${result.usage.output} out${result.usage.estimated ? ' (estimated)' : ''}`;
  if (output === 'json') {
    stdout.write(JSON.stringify({ kind: 'cost', cost_usd: finalCost, usage: result.usage }) + '\n');
  } else {
    stderr.write(`klyro: cost ${costLine}\n`);
  }
  // Stable result envelope (machine contract): exactly one `kind:result`
  // line per run in json mode, after all legacy per-status lines. Parsers
  // should read the LAST line; legacy `kind:final` lines are kept for compat.
  const emitEnvelope = (exitCode: number, extra: Record<string, unknown> = {}): number => {
    if (output === 'json') {
      stdout.write(JSON.stringify({
        kind: 'result',
        status: result.status,
        exit_code: exitCode,
        text: result.finalText,
        steps: result.steps,
        toolCalls: result.toolCalls,
        cost_usd: finalCost,
        usage: result.usage,
        ...(result.verification ? { verification: result.verification } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        ...extra,
      }) + '\n');
    }
    return exitCode;
  };
  if (result.status === 'max_steps') {
    if (output === 'json') stdout.write(JSON.stringify({ kind: 'final', status: result.status, steps: result.steps }) + '\n');
    else stderr.write(`klyro: hit max steps (${result.steps}); consider raising --max-steps\n`);
    return emitEnvelope(7);
  }
  if (result.status === 'limit') {
    if (output === 'json') stdout.write(JSON.stringify({ kind: 'final', status: result.status, steps: result.steps, text: result.finalText }) + '\n');
    else stderr.write(`klyro: stopped early: ${result.finalText || result.status} (after ${result.steps} steps)\n`);
    return emitEnvelope(7);
  }
  if (result.status === 'stuck') {
    if (output === 'json') stdout.write(JSON.stringify({ kind: 'final', status: result.status, steps: result.steps }) + '\n');
    else stderr.write(`klyro: stuck — repeated the same action with no progress; aborting after ${result.steps} steps\n`);
    return emitEnvelope(7);
  }
  if (result.status === 'aborted') {
    return emitEnvelope(130);
  }
  if (result.status === 'no_final') {
    if (output !== 'json') stderr.write('klyro: provider error — no final answer\n');
    return emitEnvelope(5);
  }
  if (result.status === 'verify_failed') {
    if (output === 'json') stdout.write(JSON.stringify({ kind: 'final', status: 'verify_failed', failureType: result.verification?.failureType }) + '\n');
    else stderr.write(`klyro: verification failed after ${result.verification?.attempts ?? 3} repairs — see output above\n`);
    return emitEnvelope(8);
  }
  // 6.5 — --require-verify: if edits were made but verification never passed, exit 8
  if (opts.requireVerify && result.verification && !result.verification.ok) {
    if (output === 'json') stdout.write(JSON.stringify({ kind: 'final', status: 'require_verify_failed' }) + '\n');
    else stderr.write('klyro: --require-verify: verification required but not passed\n');
    return emitEnvelope(8);
  }
  if (opts.requireVerify && !result.verification && result.hasEdits) {
    // Edits were made but no verification command found
    if (output === 'json') stdout.write(JSON.stringify({ kind: 'final', status: 'require_verify_missing' }) + '\n');
    else stderr.write('klyro: --require-verify: no verification command found and edits were made\n');
    return emitEnvelope(8);
  }
  if (output === 'json') stdout.write(JSON.stringify({ kind: 'final', status: 'ok', text: result.finalText }) + '\n');
  return emitEnvelope(0);
}

interface DryRunReport {
  kind: 'dry_run';
  cwd: string;
  model: string;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  systemPrompt: string;
  task: string;
  toolCount: number;
  toolNames: string[];
  policyRules: string[];
}

async function dryRunReport(opts: RunCliOptions): Promise<number> {
  // Assemble the REAL prompt (Level-6 context + KLYRO.md), not the bare base —
  // otherwise dry-run shows a different prompt than production runs use.
  const systemPromptFn = await makeRunSystemPrompt(opts.cwd, opts.systemPrompt ?? defaultRunSystemPrompt);
  const { resolveSystemPrompt } = await import('../agent/runtime.js');
  const { system, suffix } = resolveSystemPrompt(systemPromptFn, { cwd: opts.cwd });
  const systemPrompt = suffix ? `${system}\n\n${suffix}` : system;
  const registry = builtinRegistry();
  const rules = builtinRules();
  const report: DryRunReport = {
    kind: 'dry_run',
    cwd: opts.cwd,
    model: opts.model,
    maxSteps: opts.maxSteps,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    // Secrets must never leak into a printable report: redact both the
    // assembled system prompt and the task before printing.
    systemPrompt: redact(systemPrompt),
    task: redact(opts.task),
    toolCount: registry.list().length,
    toolNames: registry.list().map((t) => t.name),
    policyRules: rules.map((r) => r.name),
  };
  stdout.write(JSON.stringify(report, null, 2) + '\n');
  return 0;
}

function defaultRunSystemPrompt(_ctx: { cwd: string; telemetry?: string }): { system: string; suffix?: string } {
  const base = [
    'You are Klyro running in one-shot mode. The user has given you a single task.',
    'Solve it by calling tools as needed. When done, produce a short final text answer.',
    'Do not invent file paths. Do not call tools outside the working directory.',
  ].join(' ');
  return _ctx.telemetry ? { system: base, suffix: _ctx.telemetry } : { system: base };
}

/** Wrap a system-prompt fn to inject Level-6 context (project map etc.) + KLYRO.md (4.4). */
export async function makeRunSystemPrompt(
  cwd: string,
  base: SystemPromptFn,
  bare = false,
): Promise<SystemPromptFn> {
  // --bare: base prompt only — no L6 scan, memory, or KLYRO.md (fast + deterministic).
  if (bare) return base;
  const ctxBlock = await buildLevel6Context({ cwd });
  const prefix = ctxBlock.formatted ? `\n\n<context>\n${ctxBlock.formatted}\n</context>` : '';
  // Session memory: .klyro/memory/session-notes.md injected so memory_write
  // actually takes effect (redacted at write time — see context/memory.ts).
  const memBlock = memoryBlock(cwd);
  let klyroBlock = '';
  try {
    // P0.3 trust gate with headless approve-if-store-known: approve(file) is
    // trust.isTrusted(file), so REPL-persisted approvals are honored with no
    // prompting; unknown/changed files stay excluded and each exclusion is
    // bus-visible.
    const { loadKlyroMdFiles } = await import('../context/klyro-md.js');
    const { ContextTrust } = await import('../context/trust.js');
    const { globalBus } = await import('../events/bus.js');
    const trust = new ContextTrust();
    // Headless approve-if-store-known (no prompts): approve(file) is
    // trust.isTrusted(file), so REPL-persisted approvals are honored;
    // unknown/changed files stay excluded.
    const approve = (file: import('../context/klyro-md.js').KlyroMdFile): boolean => trust.isTrusted(file);
    const files = await loadKlyroMdFiles(cwd);
    const { trusted, untrusted } = trust.check(files);
    for (const { file, reason } of untrusted) {
      globalBus.emit({ type: 'context.trust_prompt', ts: Date.now(), sessionId: 'ephemeral', path: file.path, reason, trusted: false });
    }
    if (untrusted.length > 0) {
      stderr.write(`klyro: trust gate excluded ${untrusted.length} unapproved context file(s): ${untrusted.map((u) => u.file.path).join(', ')}\n`);
    }
    const keptFiles = trusted.filter(approve);
    const kept = keptFiles.map((f) => `# ${f.path}\n${f.content}`).join('\n\n---\n\n');
    if (kept) klyroBlock = `\n\n<KLYRO.md>\n${kept.slice(0, 4000)}\n</KLYRO.md>`;
  } catch { /* ignore */ }
  return (ctx) => {
    const r = base(ctx);
    if (typeof r === 'string') {
      // Legacy string fn: keep the exact legacy concatenation behavior.
      const t = ctx.telemetry ? '\n\n' + ctx.telemetry : '';
      return r + prefix + klyroBlock + memBlock + t;
    }
    // Split shape: Level-6/KLYRO.md join the stable prefix; telemetry stays
    // the volatile suffix for cache-friendly adapters.
    return { system: r.system + prefix + klyroBlock + memBlock, ...(r.suffix !== undefined ? { suffix: r.suffix } : {}) };
  };
}

export function loadTranscript(path: string): Message[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read transcript file '${path}': ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`transcript file '${path}' is not valid JSON: ${msg}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`transcript file '${path}' must be a JSON object with a 'transcript' field`);
  }
  const obj = parsed as { transcript?: unknown; task?: unknown };
  if (!Array.isArray(obj.transcript)) {
    throw new Error(`transcript file '${path}' is missing required field 'transcript' (array of Message)`);
  }
  // Light shape check — full validation would re-implement message.ts. We
  // trust the shape from a previous run; failures at runtime will surface
  // clearly from the provider adapter.
  for (const m of obj.transcript) {
    if (typeof m !== 'object' || m === null) {
      throw new Error(`transcript file '${path}' has non-object message: ${JSON.stringify(m).slice(0, 80)}`);
    }
    const mm = m as { role?: unknown; content?: unknown };
    if (typeof mm.role !== 'string' || !Array.isArray(mm.content)) {
      throw new Error(`transcript file '${path}' has malformed message (need role:string + content:[]): ${JSON.stringify(m).slice(0, 80)}`);
    }
  }
  return obj.transcript as Message[];
}
