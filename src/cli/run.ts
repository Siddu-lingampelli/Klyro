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
import { anthropicAdapter } from '../agent/anthropic-adapter.js';
import { run } from '../agent/runtime.js';
import type { Message } from '../agent/message.js';
import { builtinRegistry } from '../tools/registry.js';
import { builtinRules, DEFAULT_POLICY_CONFIG, PolicyEngine } from '../policy/engine.js';
import { DenyAllApprovalPrompt } from '../policy/approval.js';
import { buildLevel6Context } from '../context/level6.js';
import { getDefaultSessionStore, resolveSessionId } from '../persistence/session.js';
import * as fs from 'node:fs';

export interface RunCliOptions {
  task: string;
  cwd: string;
  model: string;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: (ctx: { cwd: string; telemetry?: string }) => string;
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
  /** Level 9 — persistence */
  persist?: boolean;
  sessionId?: string;
  sessionsDir?: string;
}

function readEnv(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export async function runOnce(opts: RunCliOptions): Promise<number> {
  const output = opts.output ?? 'human';

  if (opts.dryRun) {
    return dryRunReport(opts);
  }

  let adapter = opts.adapter;
  if (!adapter) {
    const provider = opts.provider ?? 'openai';
    const baseUrl = opts.baseUrl ?? readEnv('KLYRO_BASE_URL');
    const apiKey = opts.apiKey ?? readEnv('KLYRO_API_KEY');
    if (!apiKey) {
      stderr.write('klyro: KLYRO_API_KEY is not set (or pass --api-key)\n');
      return 2;
    }
    if (provider === 'anthropic') {
      adapter = anthropicAdapter({
        baseURL: baseUrl,
        apiKey,
        timeoutMs: opts.timeoutMs ?? 60_000,
        authHeader: opts.authHeader,
      });
    } else {
      if (!baseUrl) {
        stderr.write('klyro: KLYRO_BASE_URL is not set (or pass --base-url)\n');
        return 2;
      }
      adapter = httpChatAdapter({ baseURL: baseUrl, apiKey, timeoutMs: opts.timeoutMs ?? 60_000 });
    }
  }
  const registry = builtinRegistry();
  const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
  const systemPrompt = await makeRunSystemPrompt(opts.cwd, opts.systemPrompt ?? defaultRunSystemPrompt);

  // Level 9 — session setup (create or resume)
  const persistEnabled = opts.persist !== false;
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

  const ac = new AbortController();
  if (opts.abortOnSigint !== false) {
    process.on('SIGINT', () => {
      stderr.write('\nklyro: SIGINT — aborting\n');
      ac.abort();
    });
  }

  const verifyOpts = opts.verify === false
    ? { enabled: false as const }
    : {
        enabled: true as const,
        command: opts.verifyCommand,
        maxRepairAttempts: opts.maxRepairAttempts ?? 3,
        timeoutMs: opts.verifyTimeoutMs,
      };

  const result = await run(
    {
      task: opts.task,
      cwd: opts.cwd,
      model: opts.model,
      maxSteps: opts.maxSteps,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      signal: ac.signal,
      nonInteractive: true,
      initialTranscript,
      verify: verifyOpts,
      persist: store && sessionId ? { store, sessionId } : undefined,
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
        }
      },
    },
    { adapter, registry, policy, approval: new DenyAllApprovalPrompt(), systemPrompt },
  );

  if (store && sessionId) {
    // Finalize session status
    const statusMap: Record<string, import('../persistence/store.js').SessionStatus> = {
      complete: 'complete',
      max_steps: 'max_steps',
      aborted: 'aborted',
      no_final: 'aborted',
      verify_failed: 'verify_failed',
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

  if (output !== 'json') stdout.write('\n');
  if (result.status === 'max_steps') {
    if (output === 'json') stdout.write(JSON.stringify({ kind: 'final', status: result.status, steps: result.steps }) + '\n');
    else stderr.write(`klyro: hit max steps (${result.steps}); consider raising --max-steps\n`);
    return 3;
  }
  if (result.status === 'aborted') {
    return 130;
  }
  if (result.status === 'no_final') {
    if (output !== 'json') stderr.write('klyro: provider error — no final answer\n');
    return 4;
  }
  if (result.status === 'verify_failed') {
    if (output === 'json') stdout.write(JSON.stringify({ kind: 'final', status: 'verify_failed', failureType: result.verification?.failureType }) + '\n');
    else stderr.write(`klyro: verification failed after ${result.verification?.attempts ?? 3} repairs — see output above\n`);
    return 5;
  }
  if (output === 'json') stdout.write(JSON.stringify({ kind: 'final', status: 'ok', text: result.finalText }) + '\n');
  return 0;
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

function dryRunReport(opts: RunCliOptions): number {
  const systemPrompt = (opts.systemPrompt ?? defaultRunSystemPrompt)({ cwd: opts.cwd });
  const registry = builtinRegistry();
  const rules = builtinRules();
  const report: DryRunReport = {
    kind: 'dry_run',
    cwd: opts.cwd,
    model: opts.model,
    maxSteps: opts.maxSteps,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    systemPrompt,
    task: opts.task,
    toolCount: registry.list().length,
    toolNames: registry.list().map((t) => t.name),
    policyRules: rules.map((r) => r.name),
  };
  stdout.write(JSON.stringify(report, null, 2) + '\n');
  return 0;
}

function defaultRunSystemPrompt(_ctx: { cwd: string; telemetry?: string }): string {
  const base = [
    'You are Klyro running in one-shot mode. The user has given you a single task.',
    'Solve it by calling tools as needed. When done, produce a short final text answer.',
    'Do not invent file paths. Do not call tools outside the working directory.',
  ].join(' ');
  return _ctx.telemetry ? base + '\n\n' + _ctx.telemetry : base;
}

/** Wrap a system-prompt fn to inject Level-6 context (project map etc.) + KLYRO.md (4.4). */
export async function makeRunSystemPrompt(
  cwd: string,
  base: (ctx: { cwd: string; telemetry?: string }) => string,
): Promise<(ctx: { cwd: string; telemetry?: string }) => string> {
  const ctxBlock = await buildLevel6Context({ cwd });
  const prefix = ctxBlock.formatted ? `\n\n<context>\n${ctxBlock.formatted}\n</context>` : '';
  let klyroBlock = '';
  try {
    const { loadKlyroMd } = await import('../context/klyro-md.js');
    const md = await loadKlyroMd(cwd);
    if (md) klyroBlock = `\n\n<KLYRO.md>\n${md.slice(0, 4000)}\n</KLYRO.md>`;
  } catch { /* ignore */ }
  return (ctx) => {
    const t = ctx.telemetry ? '\n\n' + ctx.telemetry : '';
    return base(ctx) + prefix + klyroBlock + t;
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
