/**
 * `klyro` (no args) — the TUI REPL.
 *
 * Loads config from env, builds the agent runtime deps, mounts the
 * Ink app, and bridges RuntimeEvents to the app's transcript/status
 * via the global hooks installed by App.useEffect.
 */

import React from 'react';
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
import { resolveProvider, providerHelp } from '../providers.js';
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
  const resolved = await resolveProvider();
  if (!resolved) {
    process.stderr.write('klyro: no provider available.\n');
    process.stderr.write(`  ${providerHelp(null)}\n`);
    process.stderr.write('  Set KLYRO_BASE_URL and KLYRO_API_KEY, or run a local server (Ollama, LM Studio, vLLM).\n');
    process.stderr.write('  Examples:\n');
    process.stderr.write('    set KLYRO_BASE_URL=https://api.openai.com/v1\n');
    process.stderr.write('    set KLYRO_API_KEY=sk-...\n');
    process.stderr.write('    ollama serve   # then KLYRO_BASE_URL=http://localhost:11434/v1 KLYRO_MODEL=llama3.2\n');
    return 2;
  }
  const baseUrl = resolved.baseURL;
  const apiKey = resolved.apiKey;
  let model = opts.model ?? resolved.model;
  const cwd = opts.cwd ?? process.cwd();
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
  const ctxPrefix = ctxBlock.formatted ? `\n\n<context>\n${ctxBlock.formatted}\n</context>` : '';
  // 4.4 KLYRO.md hierarchy
  const klyroMd = await import('../context/klyro-md.js').then((m) => m.loadKlyroMd(cwd)).catch(() => '');
  const klyroBlock = klyroMd ? `\n\n<KLYRO.md>\n${klyroMd.slice(0, 4000)}\n</KLYRO.md>` : '';
  // 2.3 layered system prompt
  const systemPromptFn = (_ctx: { cwd: string; telemetry?: string }): string => {
    const base = buildSystemPrompt({ cwd, model, extraSystem: opts.systemPrompt, appendSystem: ctxPrefix + klyroBlock });
    const t = _ctx.telemetry ? '\n\n' + _ctx.telemetry : '';
    return base + t;
  };

  const ac = new AbortController();

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
      }
    | undefined;

  function queuedAppend(item: import('../tui/transcript.js').TranscriptItem): void {
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
    } catch { /* ignore */ }
  };
  const leaveAlt = () => {
    if (!isAltScreen) return;
    try {
      process.stdout.write('\x1b[?25h\x1b[?1049l'); // show cursor + leave alt
    } catch { /* ignore */ }
  };

  // Declare app before handler to avoid TDZ; handler added after render
  let app: ReturnType<typeof render> | undefined;
  let sigintHandler: (() => void) | undefined;
  // Level 9 — session store for TUI (one store per REPL)
  const tuiStore = getDefaultSessionStore();
  let tuiSessionId: string | undefined;

  if (isAltScreen) enterAlt();

  const EFFORT_STEPS: Record<string, number> = { low: 10, medium: 30, high: 50, max: 100 };
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
          'commands:',
          '  /clear            — clear transcript',
          '  /compact [focus]  — compact context (clears transcript, keeps marker)',
          '  /model [id]       — show or switch model mid-session',
          '  /provider [name]  — show or switch provider (openai|anthropic)',
          '  /effort [level]   — show or set effort (low|medium|high|max → steps)',
          '  /diff             — show git diff',
          '  /status           — show session status',
          '  /plan             — show current plan/todos',
          '  /verify           — detect + run verifiers',
          '  /project          — project scan',
          '  /context          — context breakdown',
          '  /cost             — token cost',
          '  /jobs             — background jobs',
          '  /memory           — session notes',
          '  /undo /rewind     — checkpoints',
          '  /login /logout    — credentials',
          '  /init             — create KLYRO.md',
          '  /config           — show config path',
          '  /doctor           — run diagnostics',
          '  /version          — show version',
          '  /quit (/exit)     — exit',
          `provider: ${currentProvider}  model: ${model}  effort: ${effortLevel} (${currentMaxSteps} steps)  cwd: ${cwd}`,
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
          queuedAppend({ id: `stat2-${Date.now()}`, kind: 'text', text: `model: ${model}  provider: ${currentProvider}  effort: ${effortLevel} (${currentMaxSteps} steps)  cwd: ${cwd}`, role: 'assistant' });
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
          queuedAppend({ id: `mdl2-${Date.now()}`, kind: 'text', text: `model switched to ${next} (takes effect on next prompt)`, role: 'assistant' });
          model = next;
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
          queuedAppend({ id: `prov2-${Date.now()}`, kind: 'text', text: `provider switched to ${next} (takes effect on next prompt)`, role: 'assistant' });
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
        const { runLogin } = await import('./auth.js');
        const code = await runLogin();
        queuedAppend({ id: `login-${Date.now()}`, kind: 'text', text: code === 0 ? 'login saved (0600)' : 'login failed', role: 'assistant' });
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
      case 'prompt': {
        // Regular prompts never reach onSlash — no-op for exhaustiveness.
        return;
      }
      case 'unknown':
        queuedAppend({
          id: `unk-${Date.now()}`,
          kind: 'error',
          message: `unknown command: ${cmd.raw} (try /help)`,
        });
        return;
    }
  }

  // Keep process alive until user quits; resolve on unmount or SIGINT.
  // ac.aborted indicates SIGINT; return 130 (128+SIGINT) like shells do.
  return new Promise<number>((resolve) => {
    const onExit = () => {
      if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
      leaveAlt();
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
