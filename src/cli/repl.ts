/**
 * `klyro` (no args) — the TUI REPL.
 *
 * Loads config from env, builds the agent runtime deps, mounts the
 * Ink app, and bridges RuntimeEvents to the app's transcript/status
 * via the global hooks installed by App.useEffect.
 */

import React from 'react';
import * as fsSync from 'node:fs';
import * as nodePath from 'node:path';
import { render } from 'ink';
import { App } from '../tui/app.js';
import { httpChatAdapter } from '../agent/provider-adapter.js';
import { anthropicAdapter } from '../agent/anthropic-adapter.js';
import { run } from '../agent/runtime.js';
import { builtinRegistry } from '../tools/registry.js';
import { builtinRules, DEFAULT_POLICY_CONFIG, PolicyEngine } from '../policy/engine.js';
import { buildLevel6Context } from '../context/level6.js';
import { DenyAllApprovalPrompt, StdinApprovalPrompt } from '../policy/approval.js';
import { TuiApprovalBridge } from '../tui/approval.js';
import { parseUnifiedDiff } from '../tui/diff-parser.js';
import { parse, type SlashCommand } from './slash/parser.js';
import { resolveProvider, providerHelp, lastProviderError } from '../providers.js';
import { MouseFilter, MOUSE_ENABLE, MOUSE_DISABLE } from '../tui/mouse.js';
import { inferProviderFromBaseURL } from '../agent/registry.js';
import { getDefaultSessionStore } from '../persistence/session.js';
import { buildSystemPrompt, parseImageInput } from '../context/system-prompt.js';
import { estimateCost } from '../providers/model-info.js';

export interface ReplOptions {
  systemPrompt?: string;
  cwd?: string;
  maxSteps?: number;
  model?: string;
  nonInteractive?: boolean;
  /** Force TUI even when stdin is not a TTY (e.g. for testing or explicit flag). */
  forceTty?: boolean;
}

export async function startRepl(opts: ReplOptions = {}): Promise<number> {
  // Reuse the same provider resolution as legacy repl.ts — probes local
  // Ollama / LM Studio / vLLM when env is not fully set, so bare `klyro`
  // works with a local model just like `klyro chat` does.
  let resolved = await resolveProvider();
  if (!resolved) {
    // First-run setup: ask ONCE (stdin is free — the Ink App is not mounted
    // yet), persist to ~/.klyro, and continue. Every future terminal — this
    // one, new windows, `klyro run` — picks it up with zero env vars.
    const interactive = !opts.nonInteractive && (opts.forceTty || process.stdin.isTTY);
    if (interactive) {
      const { runFirstRunSetup } = await import('./setup.js');
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const ans = await runFirstRunSetup((q) => rl.question(q));
        if (!ans) {
          process.stderr.write('klyro: setup aborted — run `klyro login` when ready.\n');
          return 2;
        }
        process.stderr.write('klyro: saved — this and all future terminals will use it (change via /provider /model or `klyro config`).\n');
      } finally {
        rl.close();
      }
      resolved = await resolveProvider();
    }
    if (!resolved) {
      process.stderr.write('klyro: no provider available.\n');
      process.stderr.write(`  ${providerHelp(null)}\n`);
      const why = lastProviderError();
      if (why) process.stderr.write(`  Rejected: ${why}\n`);
      process.stderr.write('  Run `klyro login` once (persists for all terminals), set KLYRO_BASE_URL and KLYRO_API_KEY, or run a local server (Ollama, LM Studio, vLLM).\n');
      return 2;
    }
  }
  const baseUrl = resolved.baseURL;
  const apiKey = resolved.apiKey;
  let model = opts.model ?? resolved.model;
  let cwd = opts.cwd ?? process.cwd();
  const registry = builtinRegistry();
  const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
  const providerKind = inferProviderFromBaseURL(baseUrl);
  // Local Ollama exposes OpenAI-compat but hostname could contain "anthropic"
  // via proxy — don't try anthropic adapter with empty key (would 401).
  const effectiveProvider = providerKind === 'anthropic' && !apiKey ? 'openai' as const : providerKind;
  if (providerKind === 'anthropic' && !apiKey) {
    process.stderr.write('klyro: anthropic provider detected but KLYRO_API_KEY is empty — falling back to OpenAI-compatible adapter\n');
  }
  let currentProvider: 'openai' | 'anthropic' = effectiveProvider;
  let currentBaseUrl = baseUrl;
  let currentApiKey = apiKey;
  let currentMaxSteps = opts.maxSteps ?? 30;
  let effortLevel = 'medium';
  const buildAdapter = (prov: 'openai' | 'anthropic', url: string, key: string) =>
    prov === 'anthropic'
      ? anthropicAdapter({ baseURL: url, apiKey: key, timeoutMs: 60_000 })
      : httpChatAdapter({ baseURL: url, apiKey: key, timeoutMs: 60_000 });
  let adapter = buildAdapter(currentProvider, currentBaseUrl, currentApiKey);
  const ctxBlock = await buildLevel6Context({ cwd });
  let ctxPrefix = ctxBlock.formatted ? `\n\n<context>\n${ctxBlock.formatted}\n</context>` : '';
  // 4.4 KLYRO.md hierarchy (mutable — /reload refreshes)
  const klyroMd = await import('../context/klyro-md.js').then((m) => m.loadKlyroMd(cwd)).catch(() => '');
  let klyroBlock = klyroMd ? `\n\n<KLYRO.md>\n${klyroMd.slice(0, 4000)}\n</KLYRO.md>` : '';
  // 2.3 layered system prompt
  const systemPromptFn = (_ctx: { cwd: string; telemetry?: string }): string => {
    const base = buildSystemPrompt({ cwd, model, extraSystem: opts.systemPrompt, appendSystem: ctxPrefix + klyroBlock });
    const t = _ctx.telemetry ? '\n\n' + _ctx.telemetry : '';
    return base + t;
  };

  let ac = new AbortController();

  // When the TUI is mounted, use the inline Ink prompt. Otherwise
  // fall back to stdin readline. The bridge is shared between the
  // App and the runtime so the modal can resolve the runtime's ask().
  const tuiBridge = new TuiApprovalBridge();
  const useTui = opts.forceTty || process.stdin.isTTY;
  const approval = opts.nonInteractive
    ? new DenyAllApprovalPrompt()
    : (useTui ? tuiBridge : new StdinApprovalPrompt());

  let inflight: Promise<unknown> | null = null;
  let lastStatus: import('../tui/status.js').StatusSnapshot | null = null;

  // --- Ordered queued bridge with instance-local hooks (no global singleton) ---
  type QueuedEvent =
    | { kind: 'append'; item: import('../tui/transcript.js').TranscriptItem }
    | { kind: 'delta'; text: string }
    | { kind: 'status'; patch: Partial<import('../tui/status.js').StatusSnapshot> }
    | { kind: 'plan'; plan: import('../agent/runtime.js').PlanStep[] };
  const pendingQueue: QueuedEvent[] = [];
  let isMounted = false;
  let directHooks:
    | {
        append: (i: import('../tui/transcript.js').TranscriptItem) => void;
        appendDelta: (text: string) => void;
        updateStatus: (s: Partial<import('../tui/status.js').StatusSnapshot>) => void;
        updatePlan: (p: import('../agent/runtime.js').PlanStep[]) => void;
        clearTranscript: () => void;
        scrollLines: (delta: number) => void;
        scrollToBottom: () => void;
        scrollHalfPage: (dir: -1 | 1) => void;
        scrollToTop: () => void;
      }
    | undefined;

  // Plain-text mirror for exit replay (scroll.md §1.2: session survives in
  // native scrollback after the alt screen is torn down). Cap 300 lines.
  const exitMirror: string[] = [];
  function mirrorLine(item: import('../tui/transcript.js').TranscriptItem): void {
    let line: string | null = null;
    if (item.kind === 'text') line = `${item.role === 'user' ? '> ' : ''}${item.text}`;
    else if (item.kind === 'error') line = `[error] ${item.message}`;
    else if (item.kind === 'file_changed') line = `[${item.op}] ${item.path}`;
    if (line === null) return;
    exitMirror.push(line.slice(0, 2000));
    if (exitMirror.length > 300) exitMirror.splice(0, exitMirror.length - 300);
  }
  function queuedAppend(item: import('../tui/transcript.js').TranscriptItem): void {
    mirrorLine(item);
    if (isMounted && directHooks) directHooks.append(item);
    else pendingQueue.push({ kind: 'append', item });
  }
  function queuedDelta(text: string): void {
    if (!text) return;
    if (isMounted && directHooks) directHooks.appendDelta(text);
    else pendingQueue.push({ kind: 'delta', text });
  }
  function queuedStatus(s: Partial<import('../tui/status.js').StatusSnapshot>): void {
    lastStatus = { ...(lastStatus ?? { model: model ?? '', step: 0, maxSteps: opts.maxSteps ?? 30, usageInput: 0, usageOutput: 0, repairs: 0, status: 'idle' } as import('../tui/status.js').StatusSnapshot), ...s };
    if (isMounted && directHooks) directHooks.updateStatus(s);
    else pendingQueue.push({ kind: 'status', patch: s });
  }
  function queuedPlan(p: import('../agent/runtime.js').PlanStep[]): void {
    if (isMounted && directHooks) directHooks.updatePlan(p);
    else pendingQueue.push({ kind: 'plan', plan: p });
  }

  // ── Full-screen takeover like OpenCode — always when klyro in TTY (user explicitly wants it)
  // Scroll now works correctly via internal viewport, not native terminal scroll
  const isAltScreen = useTui && !!process.stdout.isTTY && process.env.KLYRO_NO_ALT !== '1';
  const enterAlt = () => {
    if (!isAltScreen) return;
    try {
      process.stdout.write('\x1b[?1049h\x1b[?25l'); // alt screen + hide cursor
      process.stdout.write('\x1b[H\x1b[2J'); // home + clear
      process.stdout.write(MOUSE_ENABLE); // wheel events (SGR), see tui/mouse.ts
    } catch { /* ignore */ }
  };
  const leaveAlt = () => {
    if (!isAltScreen) return;
    try {
      process.stdout.write(MOUSE_DISABLE);
      process.stdout.write('\x1b[?25h\x1b[?1049l'); // show cursor + leave alt
    } catch { /* ignore */ }
  };
  // OpenCode-style wheel scrolling (§8.5, S8): Ink owns stdin and cannot see
  // mouse events, so tap stdin.emit — wheel deltas drive the App's scroll
  // hooks, everything else passes through to Ink untouched.
  const mouseFilter = new MouseFilter();
  const origStdinEmit = process.stdin.emit.bind(process.stdin);
  let mouseTapInstalled = false;
  function installMouseTap(): void {
    if (!isAltScreen || mouseTapInstalled) return;
    mouseTapInstalled = true;
    (process.stdin as unknown as { emit: (...a: unknown[]) => boolean }).emit = (...a: unknown[]) => {
      if (a[0] === 'data' && Buffer.isBuffer(a[1])) {
        const split = mouseFilter.push(a[1] as Buffer);
        for (const w of split.wheels) {
          try {
            if (isMounted && directHooks) directHooks.scrollLines(w);
          } catch { /* ignore */ }
        }
        if (split.kept.length === 0) return false;
        a[1] = split.kept;
      }
      return (origStdinEmit as (...b: unknown[]) => boolean)(...a);
    };
  }
  function removeMouseTap(): void {
    if (!mouseTapInstalled) return;
    mouseTapInstalled = false;
    mouseFilter.reset();
    (process.stdin as unknown as { emit: (...a: unknown[]) => boolean }).emit = origStdinEmit as (...a: unknown[]) => boolean;
  }

  // Declare app before handler to avoid TDZ; handler added after render
  let app: ReturnType<typeof render> | undefined;
  let sigintHandler: (() => void) | undefined;
  // Level 9 — session store for TUI (one store per REPL)
  const tuiStore = getDefaultSessionStore();
  let tuiSessionId: string | undefined;

  if (isAltScreen) enterAlt();

  // I7 (scroll.md §8.6, S8): while the TUI owns stdout, route console.*
  // to a ring buffer + ~/.klyro/debug.log so stray tool/provider logs
  // can't corrupt the frame. Restored on exit.
  const consoleRing: string[] = [];
  const origConsoleFns = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  function patchConsole(): void {
    if (!isAltScreen) return;
    const sink = (...args: unknown[]): void => {
      const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
      consoleRing.push(line);
      if (consoleRing.length > 200) consoleRing.splice(0, consoleRing.length - 200);
      try {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? cwd;
        const dir = nodePath.join(home, '.klyro');
        fsSync.mkdirSync(dir, { recursive: true });
        fsSync.appendFileSync(nodePath.join(dir, 'debug.log'), line + '\n');
      } catch { /* ignore */ }
    };
    console.log = sink;
    console.info = sink;
    console.warn = sink;
    console.error = sink;
    console.debug = sink;
  }
  function restoreConsole(): void {
    console.log = origConsoleFns.log;
    console.info = origConsoleFns.info;
    console.warn = origConsoleFns.warn;
    console.error = origConsoleFns.error;
    console.debug = origConsoleFns.debug;
  }
  patchConsole();
  installMouseTap();

  const EFFORT_STEPS: Record<string, number> = { low: 10, medium: 30, high: 50, max: 100 };
  // Persisted provider settings: /model /provider write through to
  // ~/.klyro/settings.json so new terminals inherit them. Touch flags keep
  // /reload from clobbering explicit in-session switches.
  let modelTouched = false;
  let providerTouched = false;
  async function persistProviderPatch(patch: Record<string, unknown>): Promise<void> {
    try {
      const { loadConfig, saveConfig } = await import('./config.js');
      const cfg = await loadConfig();
      Object.assign(cfg, patch);
      await saveConfig(cfg);
    } catch { /* best-effort */ }
  }
  // P1 session/permission state (commands.md Priority 1)
  let sessionLabel = '';
  let currentBranch = '';
  let fastMode = false;
  let displayMode = 'default';
  let lastAssistantText = '';
  // P2 state (commands.md Priority 2)
  let activeAgent = 'default';
  let verboseMode = false;
  let detailsMode = false;
  let rawMode = false;
  let lastPromptText = '';
  const attachedFiles = new Map<string, number>();
  const bgAgentTasks: Array<{ id: string; task: string; status: string }> = [];
  const aliases = new Map<string, string>();
  const savedPrompts = new Map<string, string>();
  const AGENT_ROLES = ['default', 'explorer', 'implementer', 'tester', 'reviewer'];
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? cwd;
  const aliasFile = `${homeDir}/.klyro/aliases.json`.replace(/\\/g, '/');
  const promptFile = `${homeDir}/.klyro/prompts.json`.replace(/\\/g, '/');
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    if (existsSync(aliasFile)) {
      const raw = JSON.parse(readFileSync(aliasFile, 'utf-8')) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) aliases.set(k, v);
    }
    if (existsSync(promptFile)) {
      const raw = JSON.parse(readFileSync(promptFile, 'utf-8')) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) savedPrompts.set(k, v);
    }
  } catch { /* best-effort */ }
  function persistMap(file: string, m: Map<string, string>): void {
    try {
      fsSync.mkdirSync(nodePath.dirname(file), { recursive: true });
      fsSync.writeFileSync(file, JSON.stringify(Object.fromEntries(m), null, 2), 'utf-8');
    } catch { /* best-effort */ }
  }
  /** Truncation budget honoring /verbose and /raw. */
  function outCap(s: string): string {
    const cap = rawMode ? 12000 : verboseMode ? 8000 : 4000;
    return s.length > cap ? s.slice(0, cap) + `\n... [truncated ${s.length - cap} chars]` : s;
  }
  async function execShell(command: string, timeoutMs = 120_000): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const r = await registry.execute('shell_exec', { command, timeoutMs }, { cwd, env: process.env, nonInteractive: true });
    if (!r.ok) throw new Error((r.error as { message?: string }).message ?? 'shell failed');
    return r.value as { exitCode: number | null; stdout: string; stderr: string };
  }
  /** Read-only LLM answer (no tools) — powers /ask and /explain. */
  async function answerReadOnly(question: string, context?: string): Promise<void> {
    const sys = systemPromptFn({ cwd, telemetry: '' }) + '\n\nAnswer read-only: do not call tools, do not edit files.';
    const userText = context ? `${question}\n\n<context>\n${context.slice(0, 6000)}\n</context>` : question;
    const req = {
      model,
      system: sys,
      messages: [{ role: 'user' as const, content: [{ kind: 'text' as const, text: userText }] } as unknown as import('../agent/message.js').Message],
      tools: [] as import('../agent/provider-adapter.js').ToolDefinition[],
      signal: ac.signal,
    };
    queuedStatus({ status: 'running', step: 0, model });
    let text = '';
    try {
      for await (const ev of adapter.stream(req)) {
        if (ev.kind === 'text_delta') { text += ev.text; queuedDelta(ev.text); }
        else if (ev.kind === 'error') throw new Error(ev.message);
      }
      lastAssistantText = text;
      queuedStatus({ status: 'done' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      queuedAppend({ id: `ro-err-${Date.now()}`, kind: 'error', message: msg });
      queuedStatus({ status: 'error', errorMessage: msg });
    }
  }
  function queuedClear(): void {
    if (isMounted && directHooks) directHooks.clearTranscript();
    else pendingQueue.length = 0;
    if (isMounted && directHooks) directHooks.clearTranscript();
  }

  app = render(
    React.createElement(App, {
      initialModel: model,
      maxSteps: currentMaxSteps,
      cwd,
      initialStatus: { status: 'idle' },
      approvalBridge: tuiBridge,
      isFullscreen: isAltScreen,
      onPrompt: async (text: string) => {
        lastPromptText = text;
        inflight = runWithBridge(text);
        await inflight;
        inflight = null;
      },
      onSlash: async (cmd: SlashCommand) => {
        await handleSlash(cmd);
      },
      onMounted: (hooks) => {
        directHooks = hooks;
        isMounted = true;
        for (const ev of pendingQueue) {
          if (ev.kind === 'status') hooks.updateStatus(ev.patch);
          else if (ev.kind === 'plan') hooks.updatePlan(ev.plan);
          else if (ev.kind === 'delta') hooks.appendDelta(ev.text);
          else hooks.append(ev.item);
        }
        pendingQueue.length = 0;
      },
    }),
    { patchConsole: false } as unknown as Parameters<typeof render>[1],
  );

  // Install SIGINT handler only after app exists (avoids TDZ) and use once
  // On Ctrl+C in alt-screen, leave alt before exit so shell is restored
  sigintHandler = () => {
    ac.abort();
    queuedStatus({ status: 'aborted' });
    try { app?.unmount(); } catch { /* ignore */ }
    leaveAlt();
  };
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigintHandler);

  async function runWithBridge(text: string): Promise<void> {
    if (!model) {
      queuedAppend({ id: `err-${Date.now()}`, kind: 'error', message: 'no model configured' });
      queuedStatus({ status: 'error', errorMessage: 'no model configured' });
      return;
    }
    // 2.3 image handling: extract @img refs
    const { text: cleanText, images } = parseImageInput(text);
    const taskText = images.length > 0 ? `${cleanText}\n\n[images: ${images.join(', ')}]` : cleanText;
    // Only create session for non-trivial tasks (with tools/verify) — plain chat like "hello" is not a persisted session
    const isSimpleChat = taskText.trim().split(/\s+/).length <= 5 && !taskText.toLowerCase().includes('fix') && !taskText.toLowerCase().includes('add') && !taskText.toLowerCase().includes('create');
    let sessionId: string | undefined;
    if (!isSimpleChat) {
      try {
        const rec = await tuiStore.create({ cwd, task: taskText, config: { model, maxSteps: currentMaxSteps } });
        sessionId = rec.id;
        tuiSessionId = rec.id;
        // Session info goes to status bar, not transcript (clean like Claude Code)
        queuedStatus({ status: 'running', step: 0, model });
      } catch {
        // best-effort
      }
    }
    queuedStatus({ status: 'running', step: 0, model });
    // Simple chat like "hello" must NOT trigger tool calls — direct LLM chat, no tools, no files
    if (isSimpleChat) {
      try {
        const simpleReq = {
          model,
          system: systemPromptFn({ cwd, telemetry: '' }),
          messages: [{ role: 'user' as const, content: [{ kind: 'text' as const, text: taskText }] } as unknown as import('../agent/message.js').Message],
          tools: [] as import('../agent/provider-adapter.js').ToolDefinition[],
          signal: ac.signal,
        };
        let simpleText = '';
        for await (const ev of adapter.stream(simpleReq)) {
          if (ev.kind === 'text_delta') { simpleText += ev.text; queuedDelta(ev.text); }
          else if (ev.kind === 'error') throw new Error(ev.message);
        }
        lastAssistantText = simpleText;
        queuedStatus({ status: 'done' });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        queuedAppend({ id: `err-${Date.now()}`, kind: 'error', message: msg });
        queuedStatus({ status: 'error', errorMessage: msg });
        return;
      }
    }
    let activeCallId: string | null = null;
    let activeCallName: string | null = null;
    let activeCallArgs = '';
    try {
      const result = await run(
        {
          task: taskText,
          cwd,
          model,
          maxSteps: currentMaxSteps,
          signal: ac.signal,
          nonInteractive: opts.nonInteractive ?? false,
          verify: { enabled: true, maxRepairAttempts: 3 },
          persist: sessionId ? { store: tuiStore, sessionId } : undefined,
          onEvent: (ev) => {
            if (ev.kind === 'step_start') {
              queuedStatus({ step: ev.step });
            } else if (ev.kind === 'text_delta') {
              // single appendDelta path — App merges into one assistant item (Q→A order, no duplication)
              queuedDelta(ev.text);
            } else if (ev.kind === 'verification_started') {
              queuedAppend({ id: `vrfy-${Date.now()}`, kind: 'text', text: `[verify] running \`${ev.command}\``, role: 'assistant' });
              queuedStatus({ status: 'running' });
            } else if (ev.kind === 'verification_succeeded') {
              queuedAppend({ id: `vrfy-ok-${Date.now()}`, kind: 'text', text: `[verify] passed (${ev.command})`, role: 'assistant' });
            } else if (ev.kind === 'repair_started') {
              queuedAppend({ id: `repair-${Date.now()}`, kind: 'text', text: `[repair] attempt ${ev.attempt}/${ev.maxAttempts}: ${ev.reason.slice(0, 200)}`, role: 'assistant' });
              queuedStatus({ status: 'running', errorMessage: undefined });
            } else if (ev.kind === 'checkpoint_saved') {
              queuedStatus({ status: 'running' });
            } else if (ev.kind === 'tool_call_start') {
              activeCallId = ev.id;
              activeCallName = ev.name;
              activeCallArgs = '';
            } else if (ev.kind === 'tool_call_delta') {
              activeCallArgs += ev.argsJson;
            } else if (ev.kind === 'tool_call_end') {
              queuedAppend({
                id: `tool-${ev.id}-${Date.now()}`,
                kind: 'tool',
                name: ev.name,
                id_call: ev.id,
                args: JSON.stringify(ev.input, null, 2),
                status: 'running',
              });
              activeCallId = null;
              activeCallName = null;
              activeCallArgs = '';
            } else if (ev.kind === 'policy_decision') {
              queuedAppend({
                id: `pol-${ev.id}-${Date.now()}`,
                kind: 'policy',
                name: ev.name,
                action: ev.action,
                reason: ev.reason,
              });
            } else if (ev.kind === 'tool_result') {
              queuedAppend({
                id: `tres-${ev.id}-${Date.now()}`,
                kind: 'tool',
                name: ev.name,
                id_call: ev.id,
                args: '',
                result: typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output, null, 2),
                isError: ev.isError,
                latencyMs: ev.latencyMs,
                status: ev.isError ? 'error' : 'done',
              });
            } else if (ev.kind === 'final_text') {
              // streamingId is closed by status change; no extra handling needed
            } else if (ev.kind === 'usage') {
              queuedStatus({ usageInput: ev.input, usageOutput: ev.output });
            } else if (ev.kind === 'plan_update') {
              queuedPlan(ev.plan);
            } else if (ev.kind === 'file_changed') {
              queuedAppend({
                id: `fc-${ev.path}-${Date.now()}`,
                kind: 'file_changed',
                path: ev.path,
                op: ev.op,
              });
            } else if (ev.kind === 'verification_failed') {
              queuedAppend({
                id: `vf-${ev.step}-${Date.now()}`,
                kind: 'error',
                message: `verification failed at ${ev.step}: ${ev.reason}`,
              });
            } else if (ev.kind === 'aborted') {
              queuedStatus({ status: 'aborted' });
            }
          },
        },
        { adapter, registry, policy, approval, systemPrompt: systemPromptFn },
      );
      if (result.finalText) lastAssistantText = result.finalText;
      if (result.verification) {
        const v = result.verification;
        queuedAppend({
          id: `vfin-${Date.now()}`,
          kind: 'text',
          text: `[verify] ${v.ok ? 'passed' : `failed (${v.failureType ?? 'unknown'})`} after ${v.attempts} attempt(s)${v.command ? ` — ${v.command}` : ''}`,
          role: 'assistant',
        });
        if (!v.ok) {
          queuedStatus({ status: 'error', errorMessage: `verification failed: ${v.failureType ?? 'unknown'}` });
        }
      }
      if (result.status === 'verify_failed') {
        queuedAppend({ id: `verr-${Date.now()}`, kind: 'error', message: `Verification failed after ${result.verification?.attempts ?? 3} attempts. Check output above.` });
        queuedStatus({ status: 'error', errorMessage: 'verification failed' });
      } else if (result.status === 'no_final') {
        if (result.finalText) {
          queuedStatus({ status: 'done', repairs: result.repairs ?? 0 });
        } else {
          // Genuine provider error: stream ended without a final answer. Surface as a loud
          // error header with /doctor guidance rather than hiding it behind a polite hint.
          queuedStatus({ status: 'error', errorMessage: 'no final text' });
          queuedAppend({ id: `no_final-${Date.now()}`, kind: 'error', message: 'Provider returned no final text — check model/provider (try /model or /doctor)' });
        }
      } else {
        queuedStatus({ status: 'complete' === result.status ? 'done' : 'error', repairs: result.repairs ?? 0 });
      }
      if (sessionId) {
        queuedAppend({ id: `sess-end-${Date.now()}`, kind: 'text', text: `session ${sessionId.slice(0, 8)} ${result.status} — ${result.steps} steps, ${result.toolCalls} tool calls`, role: 'assistant' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      queuedAppend({ id: `err-${Date.now()}`, kind: 'error', message });
      queuedStatus({ status: 'error', errorMessage: message });
    }
  }

  async function handleSlash(cmd: SlashCommand): Promise<void> {
    switch (cmd.kind) {
      case 'quit':
        try { app?.unmount(); } catch { /* ignore */ }
        // Listener cleanup is handled by the waitUntilExit resolver below
        return;
      case 'clear':
        queuedClear();
        queuedAppend({ id: `sep-${Date.now()}`, kind: 'text', text: '--- cleared ---', role: 'assistant' });
        return;
      case 'help': {
        const helpText = [
          'commands (Priority 1):',
          '  session: /new /clear /compact [focus] /resume [id] /sessions /rename [n] /fork [p] /branch [n] /export [f] /copy [n] /quit',
          '  model:   /model [id] /models /provider [name] /effort [low|medium|high|max] /fast [on|off]',
          '  project: /init /status /context /diff /plan [task] /todos /memory',
          '  perms:   /permissions /mode [m] /sandbox [dir] /approve /deny',
          '  app:     /login /logout /auth /version /update /cancel /shell (!cmd) /mention (@path) /tools /config /doctor',
          '  P2: /review /code-review /security-review /simplify /test /lint /build /run /fix /explain /format /ask',
          '      /undo /redo /rewind /checkpoint /accept /reject /details /verbose /raw /activity /tasks /queue /retry',
          '      /mcp /agents /subtask /background /attach /files /ls /tree /search /web /read /map /tokens',
          '      /commit /push /pull /pr /issue /theme /debug /whoami /reload /reset /prompt /alias /commands /env /deps /install',
          '  (!cmd runs shell, @path attaches a file; /commands lists everything)',
          `provider: ${currentProvider}  model: ${model}  effort: ${effortLevel}${fastMode ? ' fast' : ''} (${currentMaxSteps} steps)  mode: ${displayMode}  cwd: ${cwd}${sessionLabel ? `  session: ${sessionLabel}` : ''}${currentBranch ? `  branch: ${currentBranch}` : ''}`,
        ].join('\n');
        queuedAppend({ id: `help-${Date.now()}`, kind: 'text', text: helpText, role: 'assistant' });
        return;
      }
      case 'config': {
        const { getConfigPath } = await import('./config.js');
        queuedAppend({ id: `cfg-${Date.now()}`, kind: 'text', text: `config: ${getConfigPath()}`, role: 'assistant' });
        return;
      }
      case 'doctor': {
        const { runDoctor } = await import('./doctor.js');
        // Capture doctor output via temporary override
        const origWrite = process.stdout.write.bind(process.stdout);
        let out = '';
        (process.stdout as unknown as { write: (s: string) => boolean }).write = ((chunk: string) => { out += String(chunk); return true; }) as typeof process.stdout.write;
        await runDoctor({});
        (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
        queuedAppend({ id: `doc-${Date.now()}`, kind: 'text', text: out, role: 'assistant' });
        return;
      }
      case 'version': {
        const { readFileSync } = await import('node:fs');
        const { resolve, dirname } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        try {
          const here = dirname(fileURLToPath(import.meta.url));
          const pkg = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf-8')) as { version?: string };
          queuedAppend({ id: `ver-${Date.now()}`, kind: 'text', text: `klyro ${pkg.version ?? '0.0.0'}`, role: 'assistant' });
        } catch {
          queuedAppend({ id: `ver-${Date.now()}`, kind: 'text', text: 'klyro (version unknown)', role: 'assistant' });
        }
        return;
      }
      case 'cost': {
        const cost = lastStatus ? estimateCost(lastStatus.model ?? model, lastStatus.usageInput ?? 0, lastStatus.usageOutput ?? 0) : 0;
        const input = lastStatus?.usageInput ?? 0;
        const output = lastStatus?.usageOutput ?? 0;
        const total = input + output;
        queuedAppend({
          id: `cost-${Date.now()}`,
          kind: 'text',
          text: `Cost: $${cost.toFixed(4)} · ${input} in / ${output} out · ${total} total · model ${lastStatus?.model ?? model}`,
          role: 'assistant',
        });
        return;
      }
      case 'thinking': {
        queuedAppend({ id: `think-${Date.now()}`, kind: 'text', text: 'Thinking: collapsed (use --show-thinking to expand)', role: 'assistant' });
        return;
      }
      case 'memory': {
        queuedAppend({ id: `mem-${Date.now()}`, kind: 'text', text: 'Memory: .klyro/memory/session-notes.md (stub) — use /memory to view', role: 'assistant' });
        return;
      }
      case 'jobs': {
        const { listJobs } = await import('../tools/shell/background.js');
        const jobs = listJobs();
        if (jobs.length === 0) queuedAppend({ id: `jobs-${Date.now()}`, kind: 'text', text: 'No background jobs', role: 'assistant' });
        else queuedAppend({ id: `jobs-${Date.now()}`, kind: 'text', text: jobs.map((j) => `${j.id}: ${j.command} (${j.running ? 'running' : 'done'})`).join('\n'), role: 'assistant' });
        return;
      }
      case 'status': {
        if (lastStatus) {
          queuedAppend({
            id: `stat-${Date.now()}`,
            kind: 'text',
            text: JSON.stringify(lastStatus, null, 2),
            role: 'assistant',
          });
        } else {
          queuedAppend({ id: `stat2-${Date.now()}`, kind: 'text', text: `model: ${model}  provider: ${currentProvider}  effort: ${effortLevel}${fastMode ? '+fast' : ''} (${currentMaxSteps} steps)  mode: ${displayMode}  agent: ${activeAgent}  cwd: ${cwd}${sessionLabel ? `  session: ${sessionLabel}` : ''}${currentBranch ? `  branch: ${currentBranch}` : ''}`, role: 'assistant' });
        }
        return;
      }
      case 'diff': {
        // 4.5 — try checkpoint diff first, fallback to git diff
        try {
          const { diff } = await import('../checkpoints/store.js');
          const ckptDiff = await diff(cwd);
          if (ckptDiff && ckptDiff !== 'No checkpoints' && ckptDiff !== 'No diff') {
            queuedAppend({ id: `diff-${Date.now()}`, kind: 'text', text: ckptDiff, role: 'assistant' });
            return;
          }
        } catch { /* fallback to git */ }
        const r = await registry.execute('git_diff', {}, { cwd, env: process.env, nonInteractive: true });
        if (!r.ok) {
          queuedAppend({
            id: `diff-err-${Date.now()}`,
            kind: 'error',
            message: `git_diff failed: ${r.error.message ?? r.error.code}`,
          });
          return;
        }
        const out = r.value as { diff: string; stat: string; patchedFiles: string[] };
        const hunks = parseUnifiedDiff(out.diff);
        queuedAppend({
          id: `diff-${Date.now()}`,
          kind: 'diff',
          hunks,
          summary: `${out.patchedFiles.length} file(s) changed${out.stat ? ' — ' + out.stat.split('\n').pop() : ''}`,
        });
        return;
      }
      case 'undo': {
        try {
          const { undo } = await import('../checkpoints/store.js');
          await undo(cwd);
          queuedAppend({ id: `undo-${Date.now()}`, kind: 'text', text: 'Undone last checkpoint', role: 'assistant' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          queuedAppend({ id: `undo-err-${Date.now()}`, kind: 'error', message: `undo failed: ${msg}` });
        }
        return;
      }
      case 'rewind': {
        try {
          const { rewind } = await import('../checkpoints/store.js');
          await rewind(cwd);
          queuedAppend({ id: `rewind-${Date.now()}`, kind: 'text', text: 'Rewound to last checkpoint', role: 'assistant' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          queuedAppend({ id: `rewind-err-${Date.now()}`, kind: 'error', message: `rewind failed: ${msg}` });
        }
        return;
      }
      case 'verify': {
        const { detectVerifiers, primaryVerifyCommand } = await import('../verification/registry.js');
        const { verify } = await import('../verification/engine.js');
        const verifiers = detectVerifiers(cwd);
        if (verifiers.length === 0) {
          queuedAppend({ id: `vrfy-${Date.now()}`, kind: 'text', text: 'No verifiers detected (no test/typecheck/lint/build). Try `npm test` manually.', role: 'assistant' });
          return;
        }
        const list = verifiers.map((v) => `  ${v.id}: ${v.command}`).join('\n');
        queuedAppend({ id: `vrfy-list-${Date.now()}`, kind: 'text', text: `Verifiers:\n${list}`, role: 'assistant' });
        const cmd = primaryVerifyCommand(cwd);
        if (!cmd) return;
        queuedAppend({ id: `vrfy-run-${Date.now()}`, kind: 'text', text: `[verify] running \`${cmd}\`...`, role: 'assistant' });
        try {
          const res = await verify({ cwd, command: cmd });
          queuedAppend({ id: `vrfy-res-${Date.now()}`, kind: 'text', text: res.ok ? `[verify] passed (${cmd})` : `[verify] failed (${cmd}): ${res.stderr.slice(0, 500)}`, role: 'assistant' });
        } catch (err) {
          queuedAppend({ id: `vrfy-err-${Date.now()}`, kind: 'error', message: `verify failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'project': {
        const { runScan } = await import('./scan.js');
        let out = '';
        const orig = process.stdout.write.bind(process.stdout);
        (process.stdout as unknown as { write: (s: string) => boolean }).write = ((c: string) => { out += String(c); return true; }) as typeof process.stdout.write;
        await runScan({ cwd, json: false });
        (process.stdout as unknown as { write: typeof orig }).write = orig;
        queuedAppend({ id: `proj-${Date.now()}`, kind: 'text', text: out.slice(0, 4000), role: 'assistant' });
        return;
      }
      case 'context': {
        const { renderContextBreakdown } = await import('./context.js');
        // use last transcript via closure? approximate with empty
        const { accounting } = await import('../context/accounting.js');
        const sys = '' ; // system prompt approx
        const breakdown = renderContextBreakdown(sys, []);
        queuedAppend({ id: `ctx-${Date.now()}`, kind: 'text', text: breakdown, role: 'assistant' });
        return;
      }
      case 'compact': {
        const focus = cmd.focus?.trim();
        queuedClear();
        queuedAppend({
          id: `compact-${Date.now()}`,
          kind: 'text',
          text: focus ? `Context compacted — transcript cleared (focus: ${focus}). Continuing fresh.` : 'Context compacted — transcript cleared. Continuing fresh.',
          role: 'assistant',
        });
        queuedStatus({ status: 'done' });
        return;
      }
      case 'model': {
        const next = cmd.model?.trim();
        if (!next) {
          const { MODEL_REGISTRY } = await import('../providers/model-info.js');
          const known = Object.keys(MODEL_REGISTRY).join(', ');
          queuedAppend({ id: `mdl-${Date.now()}`, kind: 'text', text: `current model: ${model}\nknown: ${known}\nusage: /model <id>`, role: 'assistant' });
        } else {
          queuedStatus({ model: next });
          queuedAppend({ id: `mdl2-${Date.now()}`, kind: 'text', text: `model switched to ${next} (saved — new terminals inherit it)`, role: 'assistant' });
          model = next;
          modelTouched = true;
          await persistProviderPatch({ model: next });
        }
        return;
      }
      case 'provider': {
        const next = cmd.provider?.trim().toLowerCase();
        if (!next) {
          queuedAppend({ id: `prov-${Date.now()}`, kind: 'text', text: `current provider: ${currentProvider}\nbaseURL: ${currentBaseUrl}\nusage: /provider <openai|anthropic>`, role: 'assistant' });
        } else if (next !== 'openai' && next !== 'anthropic') {
          queuedAppend({ id: `prov-err-${Date.now()}`, kind: 'error', message: `unknown provider: ${next} (expected openai|anthropic)` });
        } else {
          if (next === 'anthropic' && !currentApiKey) {
            queuedAppend({ id: `prov-warn-${Date.now()}`, kind: 'text', text: 'warning: no API key set — anthropic adapter may 401. Set KLYRO_API_KEY or use /login.', role: 'assistant' });
          }
          currentProvider = next;
          adapter = buildAdapter(currentProvider, currentBaseUrl, currentApiKey);
          providerTouched = true;
          await persistProviderPatch({ provider: next });
          queuedAppend({ id: `prov2-${Date.now()}`, kind: 'text', text: `provider switched to ${next} (saved — new terminals inherit it)`, role: 'assistant' });
        }
        return;
      }
      case 'effort': {
        const level = cmd.level?.trim().toLowerCase();
        if (!level) {
          queuedAppend({ id: `eff-${Date.now()}`, kind: 'text', text: `current effort: ${effortLevel} (${currentMaxSteps} steps)\nlevels: low (10) | medium (30) | high (50) | max (100)\nusage: /effort <level>`, role: 'assistant' });
        } else if (!EFFORT_STEPS[level]) {
          queuedAppend({ id: `eff-err-${Date.now()}`, kind: 'error', message: `unknown effort: ${level} (expected low|medium|high|max)` });
        } else {
          effortLevel = level;
          currentMaxSteps = EFFORT_STEPS[level]!;
          queuedStatus({ maxSteps: currentMaxSteps });
          queuedAppend({ id: `eff2-${Date.now()}`, kind: 'text', text: `effort set to ${level} (${currentMaxSteps} max steps)`, role: 'assistant' });
        }
        return;
      }
      case 'login': {
        // NOTE: readline login cannot run inside the TUI (Ink owns stdin —
        // prompts would garble). Secrets must also never echo into the
        // transcript, so login lives outside: run it once, /reload picks it up.
        queuedAppend({
          id: `login-${Date.now()}`,
          kind: 'text',
          text: 'To sign in, run `klyro login` in any terminal (asks once, saves for all terminals), then /reload here.\n(Interactive prompts cannot run inside the TUI — Ink owns stdin.)',
          role: 'assistant',
        });
        return;
      }
      case 'logout': {
        const { runLogout } = await import('./auth.js');
        const code = await runLogout();
        queuedAppend({ id: `logout-${Date.now()}`, kind: 'text', text: code === 0 ? 'logged out' : 'logout failed', role: 'assistant' });
        return;
      }
      case 'init': {
        const { writeFileSync, existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        const target = join(cwd, 'KLYRO.md');
        if (existsSync(target)) {
          queuedAppend({ id: `init-${Date.now()}`, kind: 'text', text: `KLYRO.md already exists at ${target}`, role: 'assistant' });
        } else {
          try {
            const { runScan } = await import('./scan.js');
            let out = '';
            const orig = process.stdout.write.bind(process.stdout);
            (process.stdout as unknown as { write: (s: string) => boolean }).write = ((c: string) => { out += String(c); return true; }) as typeof process.stdout.write;
            await runScan({ cwd, json: false });
            (process.stdout as unknown as { write: typeof orig }).write = orig;
            writeFileSync(target, `# KLYRO.md\n\nProject: ${cwd}\n\n## Stack\n\n${out.slice(0, 2000)}\n\n## Conventions\n\n- Prefer smallest change that solves the task.\n- Run verification after edits.\n`);
            queuedAppend({ id: `init2-${Date.now()}`, kind: 'text', text: `created ${target}`, role: 'assistant' });
          } catch (err) {
            queuedAppend({ id: `init-err-${Date.now()}`, kind: 'error', message: `init failed: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
        return;
      }
      case 'plan': {
        if (cmd.task) {
          queuedAppend({ id: `plan-mode-${Date.now()}`, kind: 'text', text: `Plan mode: "${cmd.task}" — the agent will plan first (todo_write) before editing. Current plan below:`, role: 'assistant' });
        }
        try {
          const { readFileSync, existsSync } = await import('node:fs');
          const { join } = await import('node:path');
          const todosPath = join(cwd, '.klyro', 'plans', 'todos.json');
          if (!existsSync(todosPath)) {
            queuedAppend({ id: `plan-${Date.now()}`, kind: 'text', text: 'No active plan (no .klyro/plans/todos.json). The agent creates one via todo_write when planning.', role: 'assistant' });
          } else {
            const raw = readFileSync(todosPath, 'utf-8').slice(0, 2000);
            queuedAppend({ id: `plan2-${Date.now()}`, kind: 'text', text: `Plan (todos.json):\n${raw}`, role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `plan-err-${Date.now()}`, kind: 'error', message: `plan failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'todos': {
        try {
          const { readFileSync, existsSync } = await import('node:fs');
          const { join } = await import('node:path');
          const todosPath = join(cwd, '.klyro', 'plans', 'todos.json');
          if (!existsSync(todosPath)) {
            queuedAppend({ id: `todos-${Date.now()}`, kind: 'text', text: 'No todos (no .klyro/plans/todos.json yet).', role: 'assistant' });
          } else {
            const arr = JSON.parse(readFileSync(todosPath, 'utf-8')) as Array<{ id: string; title: string; status: string }>;
            const lines = arr.map((t) => `${t.status === 'done' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'} ${t.title} (${t.id})`);
            queuedAppend({ id: `todos2-${Date.now()}`, kind: 'text', text: `Todos (${arr.length}):\n${lines.join('\n').slice(0, 3000)}`, role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `todos-err-${Date.now()}`, kind: 'error', message: `todos failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'new': {
        queuedClear();
        sessionLabel = '';
        currentBranch = '';
        try {
          const rec = await tuiStore.create({ cwd, task: 'new session', config: { model, maxSteps: currentMaxSteps } });
          tuiSessionId = rec.id;
          queuedAppend({ id: `new-${Date.now()}`, kind: 'text', text: `new session ${rec.id.slice(0, 8)} started`, role: 'assistant' });
        } catch {
          queuedAppend({ id: `new2-${Date.now()}`, kind: 'text', text: 'new session started', role: 'assistant' });
        }
        queuedStatus({ status: 'idle', step: 0 });
        return;
      }
      case 'models': {
        const { MODEL_REGISTRY } = await import('../providers/model-info.js');
        const lines = Object.values(MODEL_REGISTRY).map((m) => `  ${m.id}  ctx ${(m.contextWindow / 1000).toFixed(0)}k  $${m.inputPricePer1k}/$${m.outputPricePer1k} per 1k`);
        queuedAppend({ id: `models-${Date.now()}`, kind: 'text', text: `Available models (current: ${model}):\n${lines.join('\n')}\nusage: /model <id>`, role: 'assistant' });
        return;
      }
      case 'fast': {
        const s = cmd.state?.trim().toLowerCase();
        if (!s) {
          queuedAppend({ id: `fast-${Date.now()}`, kind: 'text', text: `fast mode: ${fastMode ? 'on' : 'off'} (${currentMaxSteps} steps)\nusage: /fast on|off`, role: 'assistant' });
        } else if (s === 'on') {
          fastMode = true;
          currentMaxSteps = 10;
          queuedStatus({ maxSteps: currentMaxSteps });
          queuedAppend({ id: `fast2-${Date.now()}`, kind: 'text', text: 'fast mode on (10 max steps)', role: 'assistant' });
        } else if (s === 'off') {
          fastMode = false;
          currentMaxSteps = EFFORT_STEPS[effortLevel]!;
          queuedStatus({ maxSteps: currentMaxSteps });
          queuedAppend({ id: `fast3-${Date.now()}`, kind: 'text', text: `fast mode off (restored ${effortLevel}: ${currentMaxSteps} steps)`, role: 'assistant' });
        } else {
          queuedAppend({ id: `fast-err-${Date.now()}`, kind: 'error', message: `unknown /fast value: ${s} (expected on|off)` });
        }
        return;
      }
      case 'permissions': {
        const cfg = (policy as unknown as { config: Record<string, unknown> }).config;
        const lines = [
          `mode: ${displayMode} (engine: ${String(cfg.mode ?? 'default')})`,
          `shellAllow: ${((cfg.shellAllow as string[]) ?? []).length} prefixes`,
          `shellDeny: ${((cfg.shellDeny as string[]) ?? []).length} patterns`,
          `allow: ${JSON.stringify(cfg.allow ?? [])}`,
          `deny: ${JSON.stringify(cfg.deny ?? [])}`,
          `ask: ${JSON.stringify(cfg.ask ?? [])}`,
          `sandbox dirs: ${JSON.stringify(cfg.additionalDirs ?? [])}`,
        ];
        queuedAppend({ id: `perm-${Date.now()}`, kind: 'text', text: `Permissions:\n${lines.join('\n')}\nchange via /mode <manual|accept-edits|plan|auto|yolo>`, role: 'assistant' });
        return;
      }
      case 'mode': {
        const m = cmd.mode?.trim().toLowerCase();
        if (!m) {
          queuedAppend({ id: `mode-${Date.now()}`, kind: 'text', text: `current mode: ${displayMode}\nmodes: manual | accept-edits | plan | auto | yolo\nusage: /mode <mode>`, role: 'assistant' });
        } else {
          const map: Record<string, string> = { manual: 'default', 'accept-edits': 'accept-edits', plan: 'plan', auto: 'auto', yolo: 'auto' };
          const engineMode = map[m];
          if (!engineMode) {
            queuedAppend({ id: `mode-err-${Date.now()}`, kind: 'error', message: `unknown mode: ${m} (expected manual|accept-edits|plan|auto|yolo)` });
          } else {
            (policy as unknown as { config: Record<string, unknown> }).config.mode = engineMode;
            displayMode = m;
            queuedAppend({ id: `mode2-${Date.now()}`, kind: 'text', text: `mode set to ${m}${m === 'yolo' ? ' (auto-approve everything — careful)' : ''}${m === 'plan' ? ' (writes blocked)' : ''}`, role: 'assistant' });
          }
        }
        return;
      }
      case 'sandbox': {
        const cfg = (policy as unknown as { config: { additionalDirs?: string[] } }).config;
        const p = cmd.policy?.trim();
        if (!p) {
          queuedAppend({ id: `sb-${Date.now()}`, kind: 'text', text: `sandbox dirs: ${JSON.stringify(cfg.additionalDirs ?? [])}\nusage: /sandbox <dir> (adds an allowed directory)`, role: 'assistant' });
        } else {
          cfg.additionalDirs = [...(cfg.additionalDirs ?? []), p];
          queuedAppend({ id: `sb2-${Date.now()}`, kind: 'text', text: `sandbox: added allowed dir ${p}`, role: 'assistant' });
        }
        return;
      }
      case 'approve': {
        const ok = tuiBridge.resolve('allow');
        queuedAppend({ id: `appr-${Date.now()}`, kind: 'text', text: ok ? 'approved pending action' : 'no pending approval', role: 'assistant' });
        return;
      }
      case 'deny': {
        const ok = tuiBridge.resolve('deny');
        queuedAppend({ id: `deny-${Date.now()}`, kind: 'text', text: ok ? 'denied pending action' : 'no pending approval', role: 'assistant' });
        return;
      }
      case 'resume': {
        try {
          const { resolveSessionId } = await import('../persistence/session.js');
          const all = (await tuiStore.list()).filter((r) => r.cwd === cwd).sort((a, b) => b.updatedAt - a.updatedAt);
          const full = cmd.id ? await resolveSessionId(tuiStore, cmd.id) : all[0]?.id;
          if (!full) {
            queuedAppend({ id: `resume-err-${Date.now()}`, kind: 'error', message: cmd.id ? `session not found: ${cmd.id}` : 'no previous session in this cwd' });
            return;
          }
          const rec = await tuiStore.get(full);
          const msgs = await tuiStore.loadMessages(full);
          tuiSessionId = full;
          sessionLabel = rec?.task.slice(0, 40) ?? '';
          queuedAppend({ id: `resume-${Date.now()}`, kind: 'text', text: `resumed session ${full.slice(0, 8)} — "${rec?.task}" (${msgs.length} messages, status ${rec?.status})`, role: 'assistant' });
          queuedStatus({ status: 'idle' });
        } catch (err) {
          queuedAppend({ id: `resume-err2-${Date.now()}`, kind: 'error', message: `resume failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'sessions': {
        try {
          const { formatSession } = await import('../persistence/session.js');
          const all = (await tuiStore.list()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
          if (all.length === 0) {
            queuedAppend({ id: `sess-${Date.now()}`, kind: 'text', text: 'No sessions yet.', role: 'assistant' });
          } else {
            const lines = all.map((r) => `${r.id.slice(0, 8) === tuiSessionId?.slice(0, 8) ? '*' : ' '} ${formatSession(r)}`);
            queuedAppend({ id: `sess2-${Date.now()}`, kind: 'text', text: `Sessions (* = current):\n${lines.join('\n')}\nusage: /resume <id>`, role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `sess-err-${Date.now()}`, kind: 'error', message: `sessions failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'rename': {
        if (!cmd.name) {
          queuedAppend({ id: `ren-${Date.now()}`, kind: 'text', text: `current session label: ${sessionLabel || '(none)'}\nusage: /rename <name>`, role: 'assistant' });
        } else {
          sessionLabel = cmd.name;
          queuedAppend({ id: `ren2-${Date.now()}`, kind: 'text', text: `session renamed to "${cmd.name}"`, role: 'assistant' });
        }
        return;
      }
      case 'fork': {
        try {
          const base = sessionLabel || 'session';
          const rec = await tuiStore.create({ cwd, task: `${base} (fork)${cmd.prompt ? `: ${cmd.prompt}` : ''}`, config: { model, maxSteps: currentMaxSteps } });
          tuiSessionId = rec.id;
          queuedAppend({ id: `fork-${Date.now()}`, kind: 'text', text: `forked → session ${rec.id.slice(0, 8)}`, role: 'assistant' });
        } catch (err) {
          queuedAppend({ id: `fork-err-${Date.now()}`, kind: 'error', message: `fork failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'branch': {
        if (!cmd.name) {
          queuedAppend({ id: `br-${Date.now()}`, kind: 'text', text: `current branch: ${currentBranch || '(none)'}\nusage: /branch <name>`, role: 'assistant' });
        } else {
          currentBranch = cmd.name;
          queuedAppend({ id: `br2-${Date.now()}`, kind: 'text', text: `branch "${cmd.name}" created — conversation continues here`, role: 'assistant' });
        }
        return;
      }
      case 'export': {
        try {
          const all = (await tuiStore.list()).filter((r) => r.cwd === cwd).sort((a, b) => b.updatedAt - a.updatedAt);
          const target = tuiSessionId ?? all[0]?.id;
          if (!target) {
            queuedAppend({ id: `exp-err-${Date.now()}`, kind: 'error', message: 'nothing to export (no session)' });
            return;
          }
          const rec = await tuiStore.get(target);
          const msgs = await tuiStore.loadMessages(target);
          const out = cmd.file ?? `${target.slice(0, 8)}.export.json`;
          await (await import('node:fs/promises')).writeFile(out, JSON.stringify({ record: rec, messages: msgs }, null, 2), 'utf-8');
          queuedAppend({ id: `exp-${Date.now()}`, kind: 'text', text: `exported ${target.slice(0, 8)} → ${out} (${msgs.length} messages)`, role: 'assistant' });
        } catch (err) {
          queuedAppend({ id: `exp-err2-${Date.now()}`, kind: 'error', message: `export failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'copy': {
        if (!lastAssistantText) {
          queuedAppend({ id: `copy-err-${Date.now()}`, kind: 'error', message: 'nothing to copy yet (no assistant response this session)' });
          return;
        }
        const n = cmd.n ? parseInt(cmd.n, 10) : NaN;
        const text = Number.isFinite(n) && n > 0 ? lastAssistantText.slice(0, n) : lastAssistantText;
        try {
          const { execSync } = await import('node:child_process');
          const clip = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
          execSync(clip, { input: text });
          queuedAppend({ id: `copy-${Date.now()}`, kind: 'text', text: `copied ${text.length} chars to clipboard`, role: 'assistant' });
        } catch {
          queuedAppend({ id: `copy2-${Date.now()}`, kind: 'text', text: `clipboard unavailable — response preview (${text.length} chars):\n${text.slice(0, 500)}`, role: 'assistant' });
        }
        return;
      }
      case 'auth': {
        const { getStoredKey } = await import('./auth.js');
        const rows = ['openai', 'anthropic'].map((p) => {
          const hasFile = !!getStoredKey(p);
          const hasEnv = !!(p === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY) || !!process.env.KLYRO_API_KEY;
          return `  ${p}: ${hasFile ? 'stored key (0600)' : hasEnv ? 'env key' : '—'}`;
        });
        queuedAppend({ id: `auth-${Date.now()}`, kind: 'text', text: `Auth:\n${rows.join('\n')}\ncurrent provider: ${currentProvider}\nmanage via /login /logout`, role: 'assistant' });
        return;
      }
      case 'update': {
        const { runUpdate } = await import('./update.js');
        const origWrite = process.stdout.write.bind(process.stdout);
        let out = '';
        (process.stdout as unknown as { write: (s: string) => boolean }).write = ((chunk: string) => { out += String(chunk); return true; }) as typeof process.stdout.write;
        await runUpdate();
        (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
        queuedAppend({ id: `upd-${Date.now()}`, kind: 'text', text: out || 'update check done', role: 'assistant' });
        return;
      }
      case 'cancel': {
        ac.abort();
        ac = new AbortController();
        queuedStatus({ status: 'aborted' });
        queuedAppend({ id: `cancel-${Date.now()}`, kind: 'text', text: 'cancelled current operation', role: 'assistant' });
        return;
      }
      case 'shell': {
        if (!cmd.command) {
          queuedAppend({ id: `sh-${Date.now()}`, kind: 'text', text: 'usage: /shell <command>  (or !<command>)', role: 'assistant' });
          return;
        }
        try {
          const r = await registry.execute('shell_exec', { command: cmd.command }, { cwd, env: process.env, nonInteractive: true });
          if (!r.ok) {
            queuedAppend({ id: `sh-err-${Date.now()}`, kind: 'error', message: `shell failed: ${(r.error as { message?: string }).message ?? (r.error as { code?: string }).code}` });
          } else {
            const v = r.value as { exitCode: number; stdout: string; stderr: string };
            const body = (v.stdout + (v.stderr ? `\n[stderr]\n${v.stderr}` : '')).slice(0, 4000) || '(no output)';
            queuedAppend({ id: `sh2-${Date.now()}`, kind: 'text', text: `$ ${cmd.command}\nexit ${v.exitCode}\n${body}`, role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `sh-err2-${Date.now()}`, kind: 'error', message: `shell failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'mention': {
        if (!cmd.path) {
          queuedAppend({ id: `men-${Date.now()}`, kind: 'text', text: 'usage: /mention <path>  (or @<path>)', role: 'assistant' });
          return;
        }
        try {
          const r = await registry.execute('read_file', { path: cmd.path }, { cwd, env: process.env, nonInteractive: true });
          if (!r.ok) {
            queuedAppend({ id: `men-err-${Date.now()}`, kind: 'error', message: `mention failed: ${(r.error as { message?: string }).message ?? (r.error as { code?: string }).code}` });
          } else {
            const v = r.value as { path: string; content?: string; text?: string };
            const body = String(v.content ?? v.text ?? JSON.stringify(v)).slice(0, 6000);
            queuedAppend({ id: `men2-${Date.now()}`, kind: 'text', text: `attached ${cmd.path} (${body.length} chars):\n${body}`, role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `men-err2-${Date.now()}`, kind: 'error', message: `mention failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'tools': {
        const lines = registry.list().map((t) => `  ${t.name} — ${t.description.slice(0, 80)}`);
        queuedAppend({ id: `tools-${Date.now()}`, kind: 'text', text: `Tools (${lines.length}):\n${lines.join('\n')}`, role: 'assistant' });
        return;
      }
      case 'settings': {
        const { getConfigPath } = await import('./config.js');
        queuedAppend({ id: `set-${Date.now()}`, kind: 'text', text: `config: ${getConfigPath()} (alias of /config)`, role: 'assistant' });
        return;
      }
      case 'review': {
        try {
          const r = await registry.execute('git_diff', {}, { cwd, env: process.env, nonInteractive: true });
          if (!r.ok) {
            queuedAppend({ id: `rev-err-${Date.now()}`, kind: 'error', message: `review failed: ${(r.error as { message?: string }).message ?? 'git_diff error'}` });
          } else {
            const v = r.value as { diff: string; stat: string; patchedFiles: string[] };
            const head = v.patchedFiles.length === 0 ? 'Working tree clean — nothing to review.' : `Reviewing ${v.patchedFiles.length} file(s): ${v.patchedFiles.join(', ')}`;
            let extra = '';
            if (cmd.target) {
              try {
                const fr = await registry.execute('read_file', { path: cmd.target }, { cwd, env: process.env, nonInteractive: true });
                if (fr.ok) extra = `\n\n--- ${cmd.target} ---\n${String((fr.value as { content?: string }).content ?? '').slice(0, 2000)}`;
              } catch { /* ignore */ }
            }
            queuedAppend({ id: `rev-${Date.now()}`, kind: 'text', text: `${head}\n${v.stat.slice(0, 1500)}${extra}\n\n${outCap(v.diff).slice(0, 3000)}`, role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `rev-err2-${Date.now()}`, kind: 'error', message: `review failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'code-review': {
        try {
          const { checkImports } = await import('../verification/scoped.js');
          const r = await registry.execute('git_diff', {}, { cwd, env: process.env, nonInteractive: true });
          if (!r.ok) {
            queuedAppend({ id: `cr-err-${Date.now()}`, kind: 'error', message: 'code-review failed: no diff available' });
          } else {
            const v = r.value as { diff: string; stat: string; patchedFiles: string[] };
            const findings: string[] = [];
            for (const f of v.patchedFiles.slice(0, 10)) {
              const ic = checkImports(cwd, f);
              for (const m of ic.missing) findings.push(`missing import '${m}' in ${f}`);
              if (f.length > 200) findings.push(`suspicious path length: ${f}`);
            }
            if (/(^|\/)\.env(\.|$)/.test(v.diff)) findings.push('.env content in diff — never commit secrets');
            if (/console\.log|debugger/.test(v.diff)) findings.push('debug leftovers (console.log/debugger) in diff');
            if (/\.skip\(|\.todo\(|xit\(|xtest\(/.test(v.diff)) findings.push('skipped tests in diff');
            const verdict = findings.length === 0 ? 'No issues found.' : `Findings (${findings.length}):\n- ${findings.join('\n- ')}`;
            queuedAppend({ id: `cr-${Date.now()}`, kind: 'text', text: `Code review — ${v.patchedFiles.length} file(s)${cmd.options ? ` (${cmd.options})` : ''}:\n${v.stat.slice(0, 1000)}\n\n${verdict}`, role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `cr-err2-${Date.now()}`, kind: 'error', message: `code-review failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'security-review': {
        try {
          const r = await registry.execute('git_diff', {}, { cwd, env: process.env, nonInteractive: true });
          const diff = r.ok ? (r.value as { diff: string }).diff : '';
          const checks: Array<[RegExp, string]> = [
            [/sk-[A-Za-z0-9]{8,}|sk-ant-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{10,}/, 'possible hardcoded secret in diff'],
            [/(^|\/)\.env(\.|$)/, '.env content in diff'],
            [/\beval\s*\(/, 'eval() usage in diff'],
            [/rm\s+-rf\s+(\/|~|\*)/, 'dangerous rm -rf in diff'],
            [/chmod\s+-R\s+777/, 'chmod 777 in diff'],
            [/curl.*\|\s*(sh|bash)/i, 'curl|sh pipe in diff'],
            [/password\s*=\s*["'][^"']+["']/i, 'hardcoded password in diff'],
          ];
          const hits = checks.filter(([re]) => re.test(diff)).map(([, msg]) => msg);
          queuedAppend({ id: `sr-${Date.now()}`, kind: 'text', text: hits.length === 0 ? 'Security review: no issues found in working-tree diff.' : `Security review findings:\n- ${hits.join('\n- ')}`, role: 'assistant' });
        } catch (err) {
          queuedAppend({ id: `sr-err-${Date.now()}`, kind: 'error', message: `security-review failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'simplify': {
        await runWithBridge(`Simplify ${cmd.target ?? 'recent changes'}: refactor for clarity without changing behavior. Keep the diff minimal.`);
        return;
      }
      case 'test': {
        try {
          const { primaryVerifyCommand } = await import('../verification/registry.js');
          const { buildScopedCommand } = await import('../verification/scoped.js');
          const { verify } = await import('../verification/engine.js');
          const base = primaryVerifyCommand(cwd);
          if (!base) {
            queuedAppend({ id: `tst-${Date.now()}`, kind: 'text', text: 'No test command detected. Try /verify or run tests manually.', role: 'assistant' });
          } else {
            const scoped = cmd.target ? buildScopedCommand(cwd, base, [cmd.target]) ?? base : base;
            queuedAppend({ id: `tst-run-${Date.now()}`, kind: 'text', text: `[test] running \`${scoped}\`...`, role: 'assistant' });
            const res = await verify({ cwd, command: scoped, timeoutMs: 120_000 });
            queuedAppend({ id: `tst-res-${Date.now()}`, kind: 'text', text: res.ok ? `[test] passed (${scoped})` : `[test] failed:\n${outCap(res.stderr || res.stdout)}`, role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `tst-err-${Date.now()}`, kind: 'error', message: `test failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'lint': {
        try {
          const { readFileSync, existsSync } = await import('node:fs');
          const { join } = await import('node:path');
          const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> };
          let lintCmd: string | null = null;
          if (pkg.scripts?.lint) lintCmd = 'npm run lint --silent';
          else if (existsSync(join(cwd, 'eslint.config.js')) || existsSync(join(cwd, '.eslintrc.json'))) lintCmd = 'npx eslint .';
          else lintCmd = 'npx tsc --noEmit';
          queuedAppend({ id: `lint-run-${Date.now()}`, kind: 'text', text: `[lint] running \`${lintCmd}\`...`, role: 'assistant' });
          const v = await execShell(lintCmd);
          queuedAppend({ id: `lint-res-${Date.now()}`, kind: 'text', text: v.exitCode === 0 ? `[lint] clean (${lintCmd})` : `[lint] issues (exit ${v.exitCode}):\n${outCap(v.stdout + v.stderr)}`, role: 'assistant' });
        } catch (err) {
          queuedAppend({ id: `lint-err-${Date.now()}`, kind: 'error', message: `lint failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'build': {
        try {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> };
          if (!pkg.scripts?.build) {
            queuedAppend({ id: `bld-${Date.now()}`, kind: 'text', text: 'No build script in package.json.', role: 'assistant' });
          } else {
            queuedAppend({ id: `bld-run-${Date.now()}`, kind: 'text', text: '[build] running `npm run build`...', role: 'assistant' });
            const v = await execShell('npm run build', 300_000);
            queuedAppend({ id: `bld-res-${Date.now()}`, kind: 'text', text: v.exitCode === 0 ? '[build] succeeded' : `[build] failed (exit ${v.exitCode}):\n${outCap(v.stdout + v.stderr)}`, role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `bld-err-${Date.now()}`, kind: 'error', message: `build failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'run': {
        if (!cmd.command) {
          queuedAppend({ id: `run-${Date.now()}`, kind: 'text', text: 'usage: /run <command>', role: 'assistant' });
        } else {
          try {
            const v = await execShell(cmd.command, 300_000);
            queuedAppend({ id: `run2-${Date.now()}`, kind: 'text', text: `$ ${cmd.command}\nexit ${v.exitCode}\n${outCap(v.stdout + (v.stderr ? `\n[stderr]\n${v.stderr}` : '') || '(no output)')}`, role: 'assistant' });
          } catch (err) {
            queuedAppend({ id: `run-err-${Date.now()}`, kind: 'error', message: `run failed: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
        return;
      }
      case 'fix': {
        await runWithBridge(`Fix ${cmd.target ?? 'failing tests and lint errors'}: reproduce the failure, fix the source (do not edit test assertions unless the test itself is wrong), then verify.`);
        return;
      }
      case 'explain': {
        if (!cmd.target) {
          queuedAppend({ id: `exp-${Date.now()}`, kind: 'text', text: 'usage: /explain <file|symbol>', role: 'assistant' });
        } else {
          let ctx = '';
          try {
            const fr = await registry.execute('read_file', { path: cmd.target }, { cwd, env: process.env, nonInteractive: true });
            if (fr.ok) ctx = `File ${cmd.target}:\n${String((fr.value as { content?: string }).content ?? '').slice(0, 6000)}`;
          } catch { /* symbol — answer without file context */ }
          await answerReadOnly(`Explain ${cmd.target}: what it does, key logic, and gotchas.`, ctx || undefined);
        }
        return;
      }
      case 'format': {
        try {
          const v = await execShell('git status --porcelain');
          const files = v.stdout.split('\n').map((l) => l.slice(3).trim()).filter((f) => /\.(ts|tsx|js|jsx|json|md)$/.test(f)).slice(0, 20);
          if (files.length === 0) {
            queuedAppend({ id: `fmt-${Date.now()}`, kind: 'text', text: 'Nothing to format (no changed source files).', role: 'assistant' });
          } else {
            const check = await execShell('npx --no-install prettier --version').catch(() => null);
            if (!check || check.exitCode !== 0) {
              queuedAppend({ id: `fmt2-${Date.now()}`, kind: 'text', text: 'prettier not installed — run `npm i -D prettier` first.', role: 'assistant' });
            } else {
              const fv = await execShell(`npx prettier --write ${files.map((f) => `"${f}"`).join(' ')}`);
              queuedAppend({ id: `fmt3-${Date.now()}`, kind: 'text', text: fv.exitCode === 0 ? `[format] formatted ${files.length} file(s)` : `[format] failed:\n${outCap(fv.stderr || fv.stdout)}`, role: 'assistant' });
            }
          }
        } catch (err) {
          queuedAppend({ id: `fmt-err-${Date.now()}`, kind: 'error', message: `format failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'ask': {
        if (!cmd.question) {
          queuedAppend({ id: `ask-${Date.now()}`, kind: 'text', text: 'usage: /ask <question>  (read-only, no edits)', role: 'assistant' });
        } else {
          await answerReadOnly(cmd.question);
        }
        return;
      }
      case 'redo': {
        queuedAppend({ id: `redo-${Date.now()}`, kind: 'text', text: 'No redo stack — checkpoints support /undo and /rewind only.', role: 'assistant' });
        return;
      }
      case 'checkpoint': {
        try {
          const { snapshot } = await import('../checkpoints/store.js');
          const v = await execShell('git status --porcelain');
          const files = v.stdout.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
          if (files.length === 0) {
            queuedAppend({ id: `ckpt-${Date.now()}`, kind: 'text', text: 'Working tree clean — nothing to checkpoint.', role: 'assistant' });
          } else {
            const id = await snapshot(cwd, files.slice(0, 50));
            queuedAppend({ id: `ckpt2-${Date.now()}`, kind: 'text', text: `checkpoint ${String(id).slice(0, 8)} — ${files.length} file(s)`, role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `ckpt-err-${Date.now()}`, kind: 'error', message: `checkpoint failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'accept': {
        const ok = tuiBridge.resolve('allow');
        queuedAppend({ id: `acc-${Date.now()}`, kind: 'text', text: ok ? 'accepted pending edits' : 'no pending edits to accept', role: 'assistant' });
        return;
      }
      case 'reject': {
        const ok = tuiBridge.resolve('deny');
        queuedAppend({ id: `rej-${Date.now()}`, kind: 'text', text: ok ? 'rejected pending edits' : 'no pending edits to reject', role: 'assistant' });
        return;
      }
      case 'details': {
        detailsMode = !detailsMode;
        queuedAppend({ id: `det-${Date.now()}`, kind: 'text', text: `detailed activity: ${detailsMode ? 'on (tool groups expanded by default — use ctrl+o)' : 'off'}`, role: 'assistant' });
        return;
      }
      case 'verbose': {
        verboseMode = !verboseMode;
        queuedAppend({ id: `verb-${Date.now()}`, kind: 'text', text: `verbose output: ${verboseMode ? 'on (8k output cap)' : 'off (4k output cap)'}`, role: 'assistant' });
        return;
      }
      case 'raw': {
        rawMode = !rawMode;
        queuedAppend({ id: `raw-${Date.now()}`, kind: 'text', text: `raw output: ${rawMode ? 'on (12k cap, no truncation notes)' : 'off'}`, role: 'assistant' });
        return;
      }
      case 'activity': {
        const s = lastStatus;
        const line = s ? `status=${s.status} step=${s.step}/${s.maxSteps} model=${s.model} tokens=${s.usageInput + s.usageOutput}` : `status=idle model=${model}`;
        queuedAppend({ id: `act-${Date.now()}`, kind: 'text', text: `Activity: ${line}${inflight ? ' (task running)' : ''}${tuiSessionId ? ` session=${tuiSessionId.slice(0, 8)}` : ''}`, role: 'assistant' });
        return;
      }
      case 'tasks':
      case 'ps': {
        const { listJobs } = await import('../tools/shell/background.js');
        const jobs = listJobs();
        if (jobs.length === 0) queuedAppend({ id: `tasks-${Date.now()}`, kind: 'text', text: 'No background jobs', role: 'assistant' });
        else queuedAppend({ id: `tasks2-${Date.now()}`, kind: 'text', text: `Background jobs:\n${jobs.map((j) => `  ${j.id.slice(0, 12)} [${j.running ? 'running' : 'done'}] ${j.command}`).join('\n')}\nstop via /stop <id>`, role: 'assistant' });
        if (bgAgentTasks.length > 0) {
          queuedAppend({ id: `tasks3-${Date.now()}`, kind: 'text', text: `Agent tasks:\n${bgAgentTasks.map((t) => `  ${t.id} [${t.status}] ${t.task.slice(0, 80)}`).join('\n')}`, role: 'assistant' });
        }
        return;
      }
      case 'stop':
      case 'kill': {
        const id = cmd.id?.trim();
        const { listJobs, killJob } = await import('../tools/shell/background.js');
        if (!id) {
          const jobs = listJobs();
          queuedAppend({ id: `stop-${Date.now()}`, kind: 'text', text: jobs.length === 0 ? 'No background jobs.\nusage: /stop <id>' : `usage: /stop <id>\njobs:\n${jobs.map((j) => `  ${j.id.slice(0, 12)} ${j.command}`).join('\n')}`, role: 'assistant' });
        } else {
          const match = listJobs().find((j) => j.id.startsWith(id)) ?? listJobs().find((j) => j.id.includes(id));
          const ag = bgAgentTasks.find((t) => t.id.startsWith(id));
          if (match) {
            try { killJob(match.id); queuedAppend({ id: `stop2-${Date.now()}`, kind: 'text', text: `stopped ${match.id.slice(0, 12)}`, role: 'assistant' }); }
            catch (err) { queuedAppend({ id: `stop-err-${Date.now()}`, kind: 'error', message: String(err) }); }
          } else if (ag) {
            ag.status = 'stopped';
            queuedAppend({ id: `stop3-${Date.now()}`, kind: 'text', text: `marked agent task ${ag.id} stopped (in-flight loop finishes current step)`, role: 'assistant' });
          } else {
            queuedAppend({ id: `stop-err2-${Date.now()}`, kind: 'error', message: `no job: ${id}` });
          }
        }
        return;
      }
      case 'queue': {
        const pending = bgAgentTasks.filter((t) => t.status === 'running');
        queuedAppend({ id: `queue-${Date.now()}`, kind: 'text', text: pending.length === 0 ? 'Queue empty (input queue lives in the TUI — enter to queue while running, esc to drop).' : `Queued/running agent tasks:\n${pending.map((t) => `  ${t.id}: ${t.task.slice(0, 80)}`).join('\n')}`, role: 'assistant' });
        return;
      }
      case 'retry': {
        if (!lastPromptText) {
          queuedAppend({ id: `retry-err-${Date.now()}`, kind: 'error', message: 'nothing to retry yet' });
        } else {
          queuedAppend({ id: `retry-${Date.now()}`, kind: 'text', text: `retrying: ${lastPromptText.slice(0, 120)}`, role: 'assistant' });
          await runWithBridge(lastPromptText);
        }
        return;
      }
      case 'mcp': {
        try {
          const { readFileSync, existsSync } = await import('node:fs');
          const { join } = await import('node:path');
          const sub = cmd.sub?.trim().split(/\s+/)[0] ?? 'list';
          const arg = cmd.sub?.trim().split(/\s+/).slice(1).join(' ');
          const cfgPath = join(cwd, '.mcp.json');
          if (!existsSync(cfgPath)) {
            queuedAppend({ id: `mcp-${Date.now()}`, kind: 'text', text: 'No MCP servers configured (no .mcp.json). Add servers to .mcp.json.', role: 'assistant' });
            return;
          }
          const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { servers?: Record<string, { disabled?: boolean; url?: string; command?: string }> };
          const servers = cfg.servers ?? {};
          const names = Object.keys(servers);
          if (sub === 'list' || sub === 'status' || !sub) {
            queuedAppend({ id: `mcp2-${Date.now()}`, kind: 'text', text: names.length === 0 ? 'MCP: .mcp.json has no servers.' : `MCP servers (${names.length}, lazy-connect):\n${names.map((n) => `  ${servers[n]?.disabled ? '[disabled]' : '[enabled] '} ${n}${servers[n]?.url ? ` ${servers[n].url}` : ''}`).join('\n')}`, role: 'assistant' });
          } else if ((sub === 'enable' || sub === 'disable') && arg) {
            if (!servers[arg]) {
              queuedAppend({ id: `mcp-err-${Date.now()}`, kind: 'error', message: `no MCP server: ${arg}` });
            } else {
              servers[arg]!.disabled = sub === 'disable';
              const { writeFileSync } = await import('node:fs');
              writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
              queuedAppend({ id: `mcp3-${Date.now()}`, kind: 'text', text: `MCP server ${arg} ${sub}d`, role: 'assistant' });
            }
          } else if (sub === 'reconnect' && arg) {
            queuedAppend({ id: `mcp4-${Date.now()}`, kind: 'text', text: servers[arg] ? `MCP ${arg}: reconnect queued (connections are lazy — next tool use reconnects)` : `no MCP server: ${arg}`, role: 'assistant' });
          } else {
            queuedAppend({ id: `mcp5-${Date.now()}`, kind: 'text', text: 'usage: /mcp [list|status|enable <n>|disable <n>|reconnect <n>]', role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `mcp-err2-${Date.now()}`, kind: 'error', message: `mcp failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'agents': {
        queuedAppend({ id: `agents-${Date.now()}`, kind: 'text', text: `Agents (active: ${activeAgent}):\n${AGENT_ROLES.map((a) => `  ${a === activeAgent ? '*' : ' '} ${a}`).join('\n')}\nswitch via /agent <name>, spawn via /subtask <task>`, role: 'assistant' });
        return;
      }
      case 'agent': {
        const n = cmd.name?.trim().toLowerCase();
        if (!n) {
          queuedAppend({ id: `agent-${Date.now()}`, kind: 'text', text: `active agent: ${activeAgent}\nusage: /agent <${AGENT_ROLES.join('|')}>`, role: 'assistant' });
        } else if (!AGENT_ROLES.includes(n)) {
          queuedAppend({ id: `agent-err-${Date.now()}`, kind: 'error', message: `unknown agent: ${n} (expected ${AGENT_ROLES.join('|')})` });
        } else {
          activeAgent = n;
          queuedAppend({ id: `agent2-${Date.now()}`, kind: 'text', text: `active agent: ${n} (role label for future tasks)`, role: 'assistant' });
        }
        return;
      }
      case 'subagents': {
        queuedAppend({ id: `subagents-${Date.now()}`, kind: 'text', text: `Subagents: ${AGENT_ROLES.filter((a) => a !== 'default').join(', ')}\nspawn via /subtask <task> — runs a full agent loop and reports back.`, role: 'assistant' });
        return;
      }
      case 'subtask': {
        if (!cmd.task) {
          queuedAppend({ id: `subtask-${Date.now()}`, kind: 'text', text: 'usage: /subtask <task>', role: 'assistant' });
        } else {
          queuedAppend({ id: `subtask-run-${Date.now()}`, kind: 'text', text: `[subagent:${activeAgent}] starting: ${cmd.task.slice(0, 120)}`, role: 'assistant' });
          await runWithBridge(`[subagent task] ${cmd.task}`);
        }
        return;
      }
      case 'background': {
        if (!cmd.task) {
          queuedAppend({ id: `bg-${Date.now()}`, kind: 'text', text: bgAgentTasks.length === 0 ? 'No agent background tasks.\nusage: /background <task>' : `Agent background tasks:\n${bgAgentTasks.map((t) => `  ${t.id} [${t.status}] ${t.task.slice(0, 80)}`).join('\n')}`, role: 'assistant' });
        } else {
          const id = `bg-${Date.now().toString(36)}`;
          bgAgentTasks.push({ id, task: cmd.task, status: 'running' });
          queuedAppend({ id: `bg-run-${Date.now()}`, kind: 'text', text: `[background] ${id} started: ${cmd.task.slice(0, 120)}`, role: 'assistant' });
          void runWithBridge(cmd.task).then(() => {
            const t = bgAgentTasks.find((x) => x.id === id);
            if (t && t.status === 'running') t.status = 'done';
          }).catch(() => {
            const t = bgAgentTasks.find((x) => x.id === id);
            if (t && t.status === 'running') t.status = 'failed';
          });
        }
        return;
      }
      case 'add-dir': {
        const { existsSync, statSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const p = cmd.path?.trim();
        if (!p) {
          queuedAppend({ id: `adddir-${Date.now()}`, kind: 'text', text: 'usage: /add-dir <path>', role: 'assistant' });
        } else {
          const abs = resolve(cwd, p);
          try {
            if (!existsSync(abs) || !statSync(abs).isDirectory()) {
              queuedAppend({ id: `adddir-err-${Date.now()}`, kind: 'error', message: `not a directory: ${p}` });
            } else {
              const cfg = (policy as unknown as { config: { additionalDirs?: string[] } }).config;
              if (!cfg.additionalDirs?.includes(abs)) cfg.additionalDirs = [...(cfg.additionalDirs ?? []), abs];
              queuedAppend({ id: `adddir2-${Date.now()}`, kind: 'text', text: `added allowed directory: ${abs}`, role: 'assistant' });
            }
          } catch (err) {
            queuedAppend({ id: `adddir-err2-${Date.now()}`, kind: 'error', message: String(err) });
          }
        }
        return;
      }
      case 'cd': {
        const { existsSync, statSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const p = cmd.path?.trim();
        if (!p) {
          queuedAppend({ id: `cd-${Date.now()}`, kind: 'text', text: `cwd: ${cwd}\nusage: /cd <path>`, role: 'assistant' });
        } else {
          const abs = resolve(cwd, p);
          if (!existsSync(abs) || !statSync(abs).isDirectory()) {
            queuedAppend({ id: `cd-err-${Date.now()}`, kind: 'error', message: `not a directory: ${p}` });
          } else {
            cwd = abs;
            queuedAppend({ id: `cd2-${Date.now()}`, kind: 'text', text: `cwd → ${abs} (header refreshes on restart)`, role: 'assistant' });
          }
        }
        return;
      }
      case 'attach': {
        if (!cmd.file) {
          queuedAppend({ id: `att-${Date.now()}`, kind: 'text', text: 'usage: /attach <file>', role: 'assistant' });
        } else {
          try {
            const r = await registry.execute('read_file', { path: cmd.file }, { cwd, env: process.env, nonInteractive: true });
            if (!r.ok) {
              queuedAppend({ id: `att-err-${Date.now()}`, kind: 'error', message: `attach failed: ${(r.error as { message?: string }).message ?? 'read error'}` });
            } else {
              const body = String((r.value as { content?: string }).content ?? '');
              attachedFiles.set(cmd.file, body.length);
              queuedAppend({ id: `att2-${Date.now()}`, kind: 'text', text: `attached ${cmd.file} (${body.length} chars) — in context for future prompts`, role: 'assistant' });
            }
          } catch (err) {
            queuedAppend({ id: `att-err2-${Date.now()}`, kind: 'error', message: String(err) });
          }
        }
        return;
      }
      case 'drop': {
        if (!cmd.file) {
          attachedFiles.clear();
          queuedAppend({ id: `drop-${Date.now()}`, kind: 'text', text: 'dropped all attached files', role: 'assistant' });
        } else if (attachedFiles.delete(cmd.file)) {
          queuedAppend({ id: `drop2-${Date.now()}`, kind: 'text', text: `dropped ${cmd.file}`, role: 'assistant' });
        } else {
          queuedAppend({ id: `drop-err-${Date.now()}`, kind: 'error', message: `not attached: ${cmd.file}` });
        }
        return;
      }
      case 'files': {
        queuedAppend({ id: `files-${Date.now()}`, kind: 'text', text: attachedFiles.size === 0 ? 'No files in context (attach via /attach, @path, or /mention).' : `Files in context:\n${[...attachedFiles.entries()].map(([f, n]) => `  ${f} (${n} chars)`).join('\n')}`, role: 'assistant' });
        return;
      }
      case 'image': {
        if (!cmd.path) {
          queuedAppend({ id: `img-${Date.now()}`, kind: 'text', text: 'usage: /image <path>  (or @<image> inline in a prompt)', role: 'assistant' });
        } else {
          attachedFiles.set(cmd.path, 0);
          queuedAppend({ id: `img2-${Date.now()}`, kind: 'text', text: `attached image ${cmd.path} — reference it in your next prompt`, role: 'assistant' });
        }
        return;
      }
      case 'paste': {
        try {
          const { execSync } = await import('node:child_process');
          const probe = process.platform === 'win32' ? 'powershell -NoProfile -Command Get-Clipboard' : process.platform === 'darwin' ? 'pbpaste' : 'xclip -o -selection clipboard';
          const text = execSync(probe, { encoding: 'utf-8' }).trim();
          if (!text) {
            queuedAppend({ id: `paste-${Date.now()}`, kind: 'text', text: 'Clipboard is empty.', role: 'assistant' });
          } else {
            queuedAppend({ id: `paste2-${Date.now()}`, kind: 'text', text: `pasted ${text.length} chars into context:\n${text.slice(0, 3000)}`, role: 'assistant' });
          }
        } catch {
          queuedAppend({ id: `paste-err-${Date.now()}`, kind: 'error', message: 'clipboard unavailable on this system' });
        }
        return;
      }
      case 'ls': {
        try {
          const r = await registry.execute('list_directory', { path: cmd.path || '.' }, { cwd, env: process.env, nonInteractive: true });
          if (!r.ok) {
            queuedAppend({ id: `ls-err-${Date.now()}`, kind: 'error', message: `ls failed: ${(r.error as { message?: string }).message ?? 'error'}` });
          } else {
            const v = r.value as { entries?: Array<{ name: string; type: string }> };
            const lines = (v.entries ?? []).map((e) => `  ${e.type === 'directory' ? e.name + '/' : e.name}`);
            queuedAppend({ id: `ls2-${Date.now()}`, kind: 'text', text: `${cmd.path || '.'}:\n${outCap(lines.join('\n') || '(empty)')}`, role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `ls-err2-${Date.now()}`, kind: 'error', message: String(err) });
        }
        return;
      }
      case 'tree': {
        try {
          const { readdirSync, statSync } = await import('node:fs');
          const { join, relative } = await import('node:path');
          const root = cmd.path ? join(cwd, cmd.path) : cwd;
          const out: string[] = [];
          const skip = new Set(['node_modules', '.git', 'dist', '.klyro', '.next']);
          const walk = (dir: string, depth: number): void => {
            if (depth > 3 || out.length > 100) return;
            let entries: string[] = [];
            try { entries = readdirSync(dir); } catch { return; }
            for (const e of entries) {
              if (skip.has(e)) continue;
              const full = join(dir, e);
              let isDir = false;
              try { isDir = statSync(full).isDirectory(); } catch { continue; }
              out.push(`${'  '.repeat(depth)}${isDir ? e + '/' : e}`);
              if (isDir) walk(full, depth + 1);
            }
          };
          walk(root, 0);
          queuedAppend({ id: `tree-${Date.now()}`, kind: 'text', text: `${relative(cwd, root) || '.'}/\n${out.join('\n').slice(0, 4000)}`, role: 'assistant' });
        } catch (err) {
          queuedAppend({ id: `tree-err-${Date.now()}`, kind: 'error', message: String(err) });
        }
        return;
      }
      case 'search': {
        if (!cmd.query) {
          queuedAppend({ id: `search-${Date.now()}`, kind: 'text', text: 'usage: /search <query>', role: 'assistant' });
        } else {
          try {
            const r = await registry.execute('grep', { pattern: cmd.query, maxResults: 50 }, { cwd, env: process.env, nonInteractive: true });
            if (!r.ok) {
              queuedAppend({ id: `search-err-${Date.now()}`, kind: 'error', message: `search failed: ${(r.error as { message?: string }).message ?? 'error'}` });
            } else {
              queuedAppend({ id: `search2-${Date.now()}`, kind: 'text', text: `Results for "${cmd.query}":\n${outCap(JSON.stringify(r.value, null, 2))}`, role: 'assistant' });
            }
          } catch (err) {
            queuedAppend({ id: `search-err2-${Date.now()}`, kind: 'error', message: String(err) });
          }
        }
        return;
      }
      case 'web': {
        if (!cmd.url) {
          queuedAppend({ id: `web-${Date.now()}`, kind: 'text', text: 'usage: /web <url>', role: 'assistant' });
        } else {
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 15_000);
            const res = await fetch(cmd.url, { signal: ctrl.signal });
            clearTimeout(t);
            const text = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
            queuedAppend({ id: `web2-${Date.now()}`, kind: 'text', text: `${cmd.url} [${res.status}]:\n${text || '(no text content)'}`, role: 'assistant' });
          } catch (err) {
            queuedAppend({ id: `web-err-${Date.now()}`, kind: 'error', message: `fetch failed: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
        return;
      }
      case 'read': {
        if (!cmd.path) {
          queuedAppend({ id: `read-${Date.now()}`, kind: 'text', text: 'usage: /read <path>', role: 'assistant' });
        } else {
          try {
            const r = await registry.execute('read_file', { path: cmd.path }, { cwd, env: process.env, nonInteractive: true });
            if (!r.ok) {
              queuedAppend({ id: `read-err-${Date.now()}`, kind: 'error', message: `read failed: ${(r.error as { message?: string }).message ?? 'error'}` });
            } else {
              queuedAppend({ id: `read2-${Date.now()}`, kind: 'text', text: `${cmd.path}:\n${outCap(String((r.value as { content?: string }).content ?? ''))}`, role: 'assistant' });
            }
          } catch (err) {
            queuedAppend({ id: `read-err2-${Date.now()}`, kind: 'error', message: String(err) });
          }
        }
        return;
      }
      case 'map': {
        try {
          const r = await registry.execute('repo_map', {}, { cwd, env: process.env, nonInteractive: true });
          if (!r.ok) {
            queuedAppend({ id: `map-err-${Date.now()}`, kind: 'error', message: `map failed: ${(r.error as { message?: string }).message ?? 'error'}` });
          } else {
            queuedAppend({ id: `map2-${Date.now()}`, kind: 'text', text: `Repository map:\n${outCap(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2))}`, role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `map-err2-${Date.now()}`, kind: 'error', message: String(err) });
        }
        return;
      }
      case 'tokens': {
        const { getModelInfo } = await import('../providers/model-info.js');
        const info = getModelInfo(model);
        const inp = lastStatus?.usageInput ?? 0;
        const outp = lastStatus?.usageOutput ?? 0;
        const total = inp + outp;
        const pct = ((total / info.contextWindow) * 100).toFixed(1);
        queuedAppend({ id: `tokens-${Date.now()}`, kind: 'text', text: `Tokens — ${model} (window ${info.contextWindow.toLocaleString()}):\n  in ${inp.toLocaleString()} / out ${outp.toLocaleString()} / total ${total.toLocaleString()} (${pct}%)`, role: 'assistant' });
        return;
      }
      case 'commit': {
        if (!cmd.message) {
          queuedAppend({ id: `commit-${Date.now()}`, kind: 'text', text: 'usage: /commit <message>  (commits staged changes only — stage with git add first)', role: 'assistant' });
        } else {
          try {
            const st = await execShell('git status --porcelain');
            const staged = st.stdout.split('\n').filter((l) => /^[MADRC]/.test(l));
            if (staged.length === 0) {
              queuedAppend({ id: `commit2-${Date.now()}`, kind: 'text', text: 'Nothing staged — stage changes with `git add` first.', role: 'assistant' });
            } else {
              const safeMsg = cmd.message.replace(/"/g, "'");
              const v = await execShell(`git commit -m "${safeMsg}"`);
              queuedAppend({ id: `commit3-${Date.now()}`, kind: 'text', text: v.exitCode === 0 ? `committed ${staged.length} file(s):\n${outCap(v.stdout)}` : `commit failed:\n${outCap(v.stderr || v.stdout)}`, role: 'assistant' });
            }
          } catch (err) {
            queuedAppend({ id: `commit-err-${Date.now()}`, kind: 'error', message: String(err) });
          }
        }
        return;
      }
      case 'push': {
        try {
          queuedAppend({ id: `push-run-${Date.now()}`, kind: 'text', text: '[push] running `git push`...', role: 'assistant' });
          const v = await execShell('git push', 300_000);
          queuedAppend({ id: `push-res-${Date.now()}`, kind: 'text', text: v.exitCode === 0 ? `[push] done:\n${outCap(v.stdout + v.stderr)}` : `[push] failed:\n${outCap(v.stderr || v.stdout)}`, role: 'assistant' });
        } catch (err) {
          queuedAppend({ id: `push-err-${Date.now()}`, kind: 'error', message: String(err) });
        }
        return;
      }
      case 'pull': {
        try {
          const v = await execShell('git pull --ff-only', 300_000);
          queuedAppend({ id: `pull-${Date.now()}`, kind: 'text', text: v.exitCode === 0 ? `[pull] done:\n${outCap(v.stdout + v.stderr)}` : `[pull] failed:\n${outCap(v.stderr || v.stdout)}`, role: 'assistant' });
        } catch (err) {
          queuedAppend({ id: `pull-err-${Date.now()}`, kind: 'error', message: String(err) });
        }
        return;
      }
      case 'pr': {
        try {
          const hasGh = await execShell('gh --version').then(() => true).catch(() => false);
          if (!hasGh) {
            queuedAppend({ id: `pr-${Date.now()}`, kind: 'text', text: 'gh CLI not installed — install from https://cli.github.com then use /pr [create|status|view].', role: 'assistant' });
          } else {
            const v = await execShell(`gh pr ${cmd.args || 'status'}`);
            queuedAppend({ id: `pr2-${Date.now()}`, kind: 'text', text: outCap(v.stdout + v.stderr) || '(no output)', role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `pr-err-${Date.now()}`, kind: 'error', message: String(err) });
        }
        return;
      }
      case 'issue': {
        try {
          const hasGh = await execShell('gh --version').then(() => true).catch(() => false);
          if (!hasGh) {
            queuedAppend({ id: `issue-${Date.now()}`, kind: 'text', text: 'gh CLI not installed — install from https://cli.github.com.', role: 'assistant' });
          } else {
            const v = await execShell(cmd.id ? `gh issue view ${cmd.id}` : 'gh issue status');
            queuedAppend({ id: `issue2-${Date.now()}`, kind: 'text', text: outCap(v.stdout + v.stderr) || '(no output)', role: 'assistant' });
          }
        } catch (err) {
          queuedAppend({ id: `issue-err-${Date.now()}`, kind: 'error', message: String(err) });
        }
        return;
      }
      case 'editor': {
        const file = cmd.file?.trim();
        const ed = process.env.EDITOR ?? process.env.VISUAL ?? (process.platform === 'win32' ? 'notepad' : 'vi');
        if (!file) {
          queuedAppend({ id: `ed-${Date.now()}`, kind: 'text', text: `editor: ${ed}\nusage: /editor <file>`, role: 'assistant' });
        } else {
          try {
            const { startBackground } = await import('../tools/shell/background.js');
            const { resolve } = await import('node:path');
            const abs = resolve(cwd, file);
            const opener = process.platform === 'win32' ? `start "" "${abs}"` : process.platform === 'darwin' ? `open "${abs}"` : `xdg-open "${abs}"`;
            startBackground(opener, cwd);
            queuedAppend({ id: `ed2-${Date.now()}`, kind: 'text', text: `opened ${abs} in background`, role: 'assistant' });
          } catch (err) {
            queuedAppend({ id: `ed-err-${Date.now()}`, kind: 'error', message: String(err) });
          }
        }
        return;
      }
      case 'keymap':
      case 'vim':
      case 'theme':
      case 'statusline':
      case 'output-style': {
        const key = cmd.kind === 'keymap' ? 'klyro.keymap' : cmd.kind === 'vim' ? 'klyro.vim' : cmd.kind === 'theme' ? 'klyro.theme' : cmd.kind === 'statusline' ? 'klyro.statusline' : 'klyro.outputStyle';
        const val = (cmd.kind === 'keymap' ? cmd.name : cmd.kind === 'vim' ? cmd.state : cmd.kind === 'theme' ? cmd.name : cmd.kind === 'statusline' ? cmd.format : cmd.style)?.trim();
        const { runConfig } = await import('./config.js');
        const capture = async (args: string[]): Promise<string> => {
          const orig = process.stdout.write.bind(process.stdout);
          let out = '';
          (process.stdout as unknown as { write: (s: string) => boolean }).write = ((c: string) => { out += String(c); return true; }) as typeof process.stdout.write;
          try { await runConfig(args); } finally { (process.stdout as unknown as { write: typeof orig }).write = orig; }
          return out;
        };
        if (!val) {
          const out = await capture(['get', key]);
          queuedAppend({ id: `${cmd.kind}-${Date.now()}`, kind: 'text', text: out.trim() || `${cmd.kind}: (not set)\nusage: /${cmd.kind} <value>`, role: 'assistant' });
        } else {
          await capture(['set', key, val]);
          queuedAppend({ id: `${cmd.kind}2-${Date.now()}`, kind: 'text', text: `${cmd.kind} set to ${val}`, role: 'assistant' });
        }
        return;
      }
      case 'debug': {
        const info = [
          `klyro debug:`,
          `  node ${process.version}  platform ${process.platform}/${process.arch}`,
          `  cwd ${cwd}`,
          `  provider ${currentProvider} ${currentBaseUrl}`,
          `  model ${model}  effort ${effortLevel}  maxSteps ${currentMaxSteps}  fast ${fastMode ? 'on' : 'off'}`,
          `  mode ${displayMode}  agent ${activeAgent}`,
          `  apiKey: ${currentApiKey ? 'set (' + currentApiKey.length + ' chars)' : 'empty'}`,
          `  session ${tuiSessionId?.slice(0, 8) ?? '(none)'}  attached ${attachedFiles.size}  aliases ${aliases.size}  prompts ${savedPrompts.size}`,
        ];
        queuedAppend({ id: `debug-${Date.now()}`, kind: 'text', text: info.join('\n'), role: 'assistant' });
        return;
      }
      case 'whoami': {
        let user = process.env.USER ?? process.env.USERNAME ?? 'unknown';
        try { user = (await import('node:os')).userInfo().username; } catch { /* keep env */ }
        queuedAppend({ id: `who-${Date.now()}`, kind: 'text', text: `user: ${user}\nprovider: ${currentProvider} (${currentBaseUrl})\nmodel: ${model}`, role: 'assistant' });
        return;
      }
      case 'reload': {
        try {
          // Re-resolve the provider so `klyro login` (or config edits) in
          // another terminal take effect here. Explicit in-session switches
          // (/model, /provider) are never clobbered.
          const fresh = await resolveProvider();
          const notes: string[] = [];
          if (fresh) {
            if (!modelTouched && fresh.model && fresh.model !== model) {
              model = fresh.model;
              queuedStatus({ model });
              notes.push(`model → ${model}`);
            }
            if (!providerTouched) {
              const { inferProviderFromBaseURL: infer } = await import('../agent/registry.js');
              const prov = infer(fresh.baseURL);
              currentProvider = prov;
              currentBaseUrl = fresh.baseURL;
              currentApiKey = fresh.apiKey;
              adapter = buildAdapter(currentProvider, currentBaseUrl, currentApiKey);
              notes.push(`provider → ${prov} (${fresh.baseURL}, ${fresh.source})`);
            }
          }
          const ctx = await buildLevel6Context({ cwd });
          ctxPrefix = ctx.formatted ? `\n\n<context>\n${ctx.formatted}\n</context>` : '';
          const md = await import('../context/klyro-md.js').then((m) => m.loadKlyroMd(cwd)).catch(() => '');
          klyroBlock = md ? `\n\n<KLYRO.md>\n${md.slice(0, 4000)}\n</KLYRO.md>` : '';
          queuedAppend({
            id: `reload-${Date.now()}`,
            kind: 'text',
            text: notes.length > 0 ? `reloaded: ${notes.join(', ')} + project context + KLYRO.md` : 'reloaded project context + KLYRO.md (provider unchanged)',
            role: 'assistant',
          });
        } catch (err) {
          queuedAppend({ id: `reload-err-${Date.now()}`, kind: 'error', message: String(err) });
        }
        return;
      }
      case 'reset': {
        effortLevel = 'medium';
        currentMaxSteps = EFFORT_STEPS.medium!;
        fastMode = false;
        displayMode = 'default';
        (policy as unknown as { config: Record<string, unknown> }).config.mode = 'default';
        activeAgent = 'default';
        verboseMode = false;
        detailsMode = false;
        rawMode = false;
        queuedStatus({ maxSteps: currentMaxSteps });
        queuedAppend({ id: `reset-${Date.now()}`, kind: 'text', text: 'settings reset to defaults (effort medium, mode default, agent default)', role: 'assistant' });
        return;
      }
      case 'bug': {
        queuedAppend({ id: `bug-${Date.now()}`, kind: 'text', text: `Report a bug: https://github.com/Siddu-lingampelli/Klyro/issues\nInclude: klyro --version, node ${process.version}, provider ${currentProvider}, steps to reproduce.`, role: 'assistant' });
        return;
      }
      case 'changelog': {
        try {
          const v = await execShell('git log --oneline -15');
          queuedAppend({ id: `cl-${Date.now()}`, kind: 'text', text: v.exitCode === 0 && v.stdout.trim() ? `Recent changes:\n${v.stdout.slice(0, 3000)}` : 'No git history here — see npm klyro versions for releases.', role: 'assistant' });
        } catch (err) {
          queuedAppend({ id: `cl-err-${Date.now()}`, kind: 'error', message: String(err) });
        }
        return;
      }
      case 'promptcmd': {
        const rest = cmd.args?.trim() ?? '';
        if (!rest) {
          queuedAppend({ id: `pc-${Date.now()}`, kind: 'text', text: savedPrompts.size === 0 ? 'No saved prompts.\nusage: /prompt save <name> <text> | /prompt <name>' : `Saved prompts:\n${[...savedPrompts.keys()].map((k) => `  ${k}`).join('\n')}\nrun via /prompt <name>`, role: 'assistant' });
        } else if (rest.startsWith('save ')) {
          const m = /^save\s+(\S+)\s+([\s\S]+)$/.exec(rest);
          if (!m) {
            queuedAppend({ id: `pc-err-${Date.now()}`, kind: 'error', message: 'usage: /prompt save <name> <text>' });
          } else {
            savedPrompts.set(m[1]!, m[2]!);
            persistMap(promptFile, savedPrompts);
            queuedAppend({ id: `pc2-${Date.now()}`, kind: 'text', text: `saved prompt "${m[1]}"`, role: 'assistant' });
          }
        } else {
          const name = rest.split(/\s+/)[0]!;
          const text = savedPrompts.get(name);
          if (!text) {
            queuedAppend({ id: `pc-err2-${Date.now()}`, kind: 'error', message: `no saved prompt: ${name}` });
          } else {
            await runWithBridge(text);
          }
        }
        return;
      }
      case 'alias': {
        const rest = cmd.args?.trim() ?? '';
        if (!rest) {
          queuedAppend({ id: `al-${Date.now()}`, kind: 'text', text: aliases.size === 0 ? 'No aliases.\nusage: /alias <name> <command>' : `Aliases:\n${[...aliases.entries()].map(([k, v]) => `  /${k} → ${v}`).join('\n')}`, role: 'assistant' });
        } else {
          const m = /^(\S+)\s+([\s\S]+)$/.exec(rest);
          if (!m) {
            queuedAppend({ id: `al-err-${Date.now()}`, kind: 'error', message: 'usage: /alias <name> <command>' });
          } else {
            aliases.set(m[1]!, m[2]!);
            persistMap(aliasFile, aliases);
            queuedAppend({ id: `al2-${Date.now()}`, kind: 'text', text: `alias /${m[1]} → ${m[2]}`, role: 'assistant' });
          }
        }
        return;
      }
      case 'commands': {
        const { COMMAND_DEFS } = await import('./slash/parser.js');
        const custom = [...aliases.keys()].map((k) => `  /${k} (alias)`);
        void custom;
        queuedAppend({ id: `cmds-${Date.now()}`, kind: 'text', text: `Commands (${COMMAND_DEFS.length + aliases.size + savedPrompts.size}):\n${COMMAND_DEFS.map((d) => `  /${d.name} — ${d.hint}`).join('\n')}${aliases.size > 0 ? `\ncustom aliases:\n${[...aliases.entries()].map(([k, v]) => `  /${k} → ${v}`).join('\n')}` : ''}${savedPrompts.size > 0 ? `\nsaved prompts: ${[...savedPrompts.keys()].join(', ')}` : ''}`, role: 'assistant' });
        return;
      }
      case 'env': {
        const { existsSync } = await import('node:fs');
        void existsSync;
        const a = cmd.args?.trim() ?? '';
        if (!a) {
          const rows = Object.keys(process.env).filter((k) => k.startsWith('KLYRO_') || ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NO_COLOR'].includes(k)).map((k) => {
            const v = process.env[k] ?? '';
            const secret = /KEY|SECRET|TOKEN/.test(k);
            return `  ${k}=${secret ? (v ? '(set, ' + v.length + ' chars)' : '(empty)') : v || '(empty)'}`;
          });
          queuedAppend({ id: `env-${Date.now()}`, kind: 'text', text: rows.length === 0 ? 'No KLYRO_* env set.\nusage: /env KEY=value (session-only)' : `Environment:\n${rows.join('\n')}\nset via /env KEY=value (session-only)`, role: 'assistant' });
        } else {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(a);
          if (!m) {
            queuedAppend({ id: `env-err-${Date.now()}`, kind: 'error', message: 'usage: /env KEY=value' });
          } else {
            process.env[m[1]!] = m[2]!;
            queuedAppend({ id: `env2-${Date.now()}`, kind: 'text', text: `set ${m[1]} (session-only)`, role: 'assistant' });
          }
        }
        return;
      }
      case 'deps': {
        try {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          const d = Object.entries(pkg.dependencies ?? {}).map(([k, v]) => `  ${k}@${v}`);
          const dd = Object.entries(pkg.devDependencies ?? {}).map(([k, v]) => `  ${k}@${v} (dev)`);
          queuedAppend({ id: `deps-${Date.now()}`, kind: 'text', text: d.length + dd.length === 0 ? 'No dependencies in package.json.' : `Dependencies:\n${[...d, ...dd].join('\n').slice(0, 3000)}`, role: 'assistant' });
        } catch {
          queuedAppend({ id: `deps-err-${Date.now()}`, kind: 'error', message: 'no package.json in cwd' });
        }
        return;
      }
      case 'install': {
        try {
          const { existsSync } = await import('node:fs');
          const { join } = await import('node:path');
          const mgr = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm install' : existsSync(join(cwd, 'package-lock.json')) ? 'npm install' : existsSync(join(cwd, 'bun.lockb')) ? 'bun install' : existsSync(join(cwd, 'yarn.lock')) ? 'yarn install' : 'npm install';
          queuedAppend({ id: `inst-run-${Date.now()}`, kind: 'text', text: `[install] running \`${mgr}\`...`, role: 'assistant' });
          const v = await execShell(mgr, 600_000);
          queuedAppend({ id: `inst-res-${Date.now()}`, kind: 'text', text: v.exitCode === 0 ? '[install] done' : `[install] failed:\n${outCap(v.stderr || v.stdout)}`, role: 'assistant' });
        } catch (err) {
          queuedAppend({ id: `inst-err-${Date.now()}`, kind: 'error', message: String(err) });
        }
        return;
      }
      case 'prompt': {
        // Regular prompts never reach onSlash — no-op for exhaustiveness.
        return;
      }
      case 'unknown': {
        // Alias expansion: /alias <name> <command> redirects unknown commands
        const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(cmd.raw.trim());
        const target = m ? aliases.get(m[1]!.toLowerCase()) : undefined;
        if (m && target) {
          const extra = m[2] ? ` ${m[2]}` : '';
          await handleSlash(parse(target + extra));
          return;
        }
        queuedAppend({
          id: `unk-${Date.now()}`,
          kind: 'error',
          message: `unknown command: ${cmd.raw} (try /help or /commands)`,
        });
        return;
      }
    }
  }

  // Keep process alive until user quits; resolve on unmount or SIGINT.
  // ac.aborted indicates SIGINT; return 130 (128+SIGINT) like shells do.
  return new Promise<number>((resolve) => {
    const onExit = () => {
      if (sigintHandler) {
        process.removeListener('SIGINT', sigintHandler);
        process.removeListener('SIGTERM', sigintHandler);
      }
      restoreConsole();
      removeMouseTap();
      leaveAlt();
      // §1.2 exit behavior: replay a plain-text transcript into the main
      // buffer so the session survives in native scrollback.
      if (exitMirror.length > 0) {
        try {
          process.stdout.write('\n--- klyro session transcript ---\n');
          for (const line of exitMirror.slice(-100)) process.stdout.write(line + '\n');
        } catch { /* ignore */ }
      }
      resolve(ac.signal.aborted ? 130 : 0);
    };
    if (!app) {
      leaveAlt();
      resolve(1);
      return;
    }
    app.waitUntilExit().then(onExit, onExit);
  });
}
