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
  const adapter = effectiveProvider === 'anthropic'
    ? anthropicAdapter({ baseURL: baseUrl, apiKey, timeoutMs: 60_000 })
    : httpChatAdapter({ baseURL: baseUrl, apiKey, timeoutMs: 60_000 });
  const ctxBlock = await buildLevel6Context({ cwd });
  const ctxPrefix = ctxBlock.formatted ? `\n\n<context>\n${ctxBlock.formatted}\n</context>` : '';
  const systemPromptFn = (_ctx: { cwd: string; telemetry?: string }): string => {
    const base = opts.systemPrompt ?? 'You are Klyro, an autonomous coding harness. Solve the user\'s task using the available tools.';
    const t = _ctx.telemetry ? '\n\n' + _ctx.telemetry : '';
    return base + ctxPrefix + t;
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
    | { kind: 'status'; patch: Partial<import('../tui/status.js').StatusSnapshot> }
    | { kind: 'plan'; plan: import('../agent/runtime.js').PlanStep[] };
  const pendingQueue: QueuedEvent[] = [];
  let isMounted = false;
  let directHooks:
    | {
        append: (i: import('../tui/transcript.js').TranscriptItem) => void;
        updateStatus: (s: Partial<import('../tui/status.js').StatusSnapshot>) => void;
        updatePlan: (p: import('../agent/runtime.js').PlanStep[]) => void;
      }
    | undefined;

  function queuedAppend(item: import('../tui/transcript.js').TranscriptItem): void {
    if (isMounted && directHooks) directHooks.append(item);
    else pendingQueue.push({ kind: 'append', item });
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

  // Declare app before handler to avoid TDZ; handler added after render
  let app: ReturnType<typeof render> | undefined;
  let sigintHandler: (() => void) | undefined;

  app = render(
    React.createElement(App, {
      initialModel: model,
      maxSteps: opts.maxSteps ?? 30,
      cwd,
      initialStatus: { status: 'idle' },
      approvalBridge: tuiBridge,
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
          else hooks.append(ev.item);
        }
        pendingQueue.length = 0;
      },
    }),
  );

  // Install SIGINT handler only after app exists (avoids TDZ) and use once
  sigintHandler = () => {
    ac.abort();
    queuedStatus({ status: 'aborted' });
    try { app?.unmount(); } catch { /* ignore */ }
  };
  process.once('SIGINT', sigintHandler);

  async function runWithBridge(text: string): Promise<void> {
    if (!model) {
      queuedAppend({ id: `err-${Date.now()}`, kind: 'error', message: 'no model configured' });
      queuedStatus({ status: 'error', errorMessage: 'no model configured' });
      return;
    }
    queuedStatus({ status: 'running', step: 0, model });
    let textBuf = '';
    let pendingTextId: string | null = null;
    let activeCallId: string | null = null;
    let activeCallName: string | null = null;
    let activeCallArgs = '';
    try {
      const result = await run(
        {
          task: text,
          cwd,
          model,
          maxSteps: opts.maxSteps ?? 30,
          signal: ac.signal,
          nonInteractive: opts.nonInteractive ?? false,
          onEvent: (ev) => {
            if (ev.kind === 'step_start') {
              // Flush coalesced text before new step
              pendingTextId = null;
              queuedStatus({ step: ev.step });
            } else if (ev.kind === 'text_delta') {
              textBuf += ev.text;
              // Coalesce: reuse pending text item if still queued, otherwise create one.
              // App.tsx also coalesces post-mount, so we only need to avoid queue bloat.
              if (pendingTextId) {
                const last = pendingQueue[pendingQueue.length - 1];
                if (last?.kind === 'append' && last.item.kind === 'text' && last.item.id === pendingTextId) {
                  last.item.text += ev.text;
                  return;
                }
              }
              // For mounted case, App will merge via its own coalescing (same id)
              // so reuse pendingTextId to let App merge
              if (pendingTextId && isMounted) {
                queuedAppend({ id: pendingTextId, kind: 'text', text: ev.text, role: 'assistant' });
                return;
              }
              const id = `text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
              pendingTextId = id;
              queuedAppend({ id, kind: 'text', text: ev.text, role: 'assistant' });
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
      queuedStatus({ status: 'complete' === result.status ? 'done' : 'error', repairs: result.repairs ?? 0 });
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
        queuedAppend({ id: `sep-${Date.now()}`, kind: 'text', text: '--- cleared ---', role: 'assistant' });
        return;
      case 'help': {
        const helpText = [
          'commands:',
          '  /clear          — clear transcript marker',
          '  /diff           — show git diff',
          '  /status         — show session status',
          '  /compact        — (stub) context compaction',
          '  /model <id>     — switch model mid-session',
          '  /quit           — exit',
          `provider: ${effectiveProvider}  model: ${model}  cwd: ${cwd}`,
        ].join('\n');
        queuedAppend({ id: `help-${Date.now()}`, kind: 'text', text: helpText, role: 'assistant' });
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
          queuedAppend({ id: `stat2-${Date.now()}`, kind: 'text', text: `model: ${model}  provider: ${effectiveProvider}  cwd: ${cwd}`, role: 'assistant' });
        }
        return;
      }
      case 'diff': {
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
      case 'compact':
        queuedAppend({
          id: `stub-${Date.now()}`,
          kind: 'text',
          text: `/compact is a stub in this build. (persistence integration pending)`,
          role: 'assistant',
        });
        return;
      case 'model': {
        const next = cmd.model?.trim();
        if (!next) {
          queuedAppend({ id: `mdl-${Date.now()}`, kind: 'text', text: `current model: ${model}`, role: 'assistant' });
        } else {
          queuedStatus({ model: next });
          queuedAppend({ id: `mdl2-${Date.now()}`, kind: 'text', text: `model switched to ${next} (takes effect on next prompt)`, role: 'assistant' });
          model = next;
        }
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
      resolve(ac.signal.aborted ? 130 : 0);
    };
    if (!app) {
      resolve(1);
      return;
    }
    app.waitUntilExit().then(onExit, onExit);
  });
}
