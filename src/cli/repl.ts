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
import { run } from '../agent/runtime.js';
import { builtinRegistry } from '../tools/registry.js';
import { builtinRules, DEFAULT_POLICY_CONFIG, PolicyEngine } from '../policy/engine.js';
import { buildLevel6Context } from '../context/level6.js';
import { DenyAllApprovalPrompt, StdinApprovalPrompt } from '../policy/approval.js';
import { parse, type SlashCommand } from './slash/parser.js';

function readEnv(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export interface ReplOptions {
  systemPrompt?: string;
  cwd?: string;
  maxSteps?: number;
  model?: string;
  nonInteractive?: boolean;
}

export async function startRepl(opts: ReplOptions = {}): Promise<number> {
  const baseUrl = readEnv('KLYRO_BASE_URL');
  const apiKey = readEnv('KLYRO_API_KEY');
  const model = opts.model ?? readEnv('KLYRO_MODEL');
  if (!baseUrl || !apiKey || !model) {
    process.stderr.write('klyro: KLYRO_BASE_URL, KLYRO_API_KEY, and KLYRO_MODEL must be set\n');
    return 2;
  }
  const cwd = opts.cwd ?? process.cwd();
  const registry = builtinRegistry();
  const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
  const adapter = httpChatAdapter({ baseURL: baseUrl, apiKey, timeoutMs: 60_000 });
  const approval = opts.nonInteractive ? new DenyAllApprovalPrompt() : new StdinApprovalPrompt();
  const ctxBlock = await buildLevel6Context({ cwd });
  const ctxPrefix = ctxBlock.formatted ? `\n\n<context>\n${ctxBlock.formatted}\n</context>` : '';
  const systemPromptFn = (_ctx: { cwd: string }): string =>
    (opts.systemPrompt ?? 'You are Klyro, an autonomous coding harness. Solve the user\'s task using the available tools.') + ctxPrefix;

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());

  let inflight: Promise<unknown> | null = null;
  let transcriptRef: import('../tui/transcript.js').TranscriptItem[] = [];
  let lastStatus: import('../tui/status.js').StatusSnapshot | null = null;

  const app = render(
    React.createElement(App, {
      initialModel: model,
      maxSteps: opts.maxSteps ?? 30,
      initialStatus: { status: 'idle' },
      onPrompt: async (text: string) => {
        inflight = runWithBridge(text);
        await inflight;
        inflight = null;
      },
      onSlash: async (cmd: SlashCommand) => {
        await handleSlash(cmd);
      },
    }),
  );

  // Bridge: subscribes to global hooks installed by App.useEffect.
  // Every time the runtime emits, we translate to a transcript item or
  // a status update.
  const appG = globalThis as unknown as {
    __klyroAppAppend?: (i: import('../tui/transcript.js').TranscriptItem) => void;
    __klyroAppStatus?: (s: Partial<import('../tui/status.js').StatusSnapshot>) => void;
  };

  async function runWithBridge(text: string): Promise<void> {
    appG.__klyroAppStatus?.({ status: 'running', step: 0 });
    let textBuf = '';
    let activeCallId: string | null = null;
    let activeCallName: string | null = null;
    let activeCallArgs = '';
    try {
      const result = await run(
        {
          task: text,
          cwd,
          model: model!,
          maxSteps: opts.maxSteps ?? 30,
          signal: ac.signal,
          nonInteractive: opts.nonInteractive ?? false,
          onEvent: (ev) => {
            if (ev.kind === 'step_start') {
              appG.__klyroAppStatus?.({ step: ev.step });
            } else if (ev.kind === 'text_delta') {
              textBuf += ev.text;
              appG.__klyroAppAppend?.({ id: `text-${ev.kind}-${Date.now()}-${Math.random()}`, kind: 'text', text: ev.text, role: 'assistant' });
            } else if (ev.kind === 'tool_call_start') {
              activeCallId = ev.id;
              activeCallName = ev.name;
              activeCallArgs = '';
            } else if (ev.kind === 'tool_call_delta') {
              activeCallArgs += ev.argsJson;
            } else if (ev.kind === 'tool_call_end') {
              appG.__klyroAppAppend?.({
                id: `tool-${ev.id}-${Date.now()}`,
                kind: 'tool',
                name: ev.name,
                id_call: ev.id,
                args: JSON.stringify(ev.input, null, 2),
                collapsed: true,
              });
              activeCallId = null;
              activeCallName = null;
              activeCallArgs = '';
            } else if (ev.kind === 'policy_decision') {
              appG.__klyroAppAppend?.({
                id: `pol-${ev.id}-${Date.now()}`,
                kind: 'policy',
                name: ev.name,
                action: ev.action,
                reason: ev.reason,
              });
            } else if (ev.kind === 'tool_result') {
              appG.__klyroAppAppend?.({
                id: `tres-${ev.id}-${Date.now()}`,
                kind: 'tool',
                name: ev.name,
                id_call: ev.id,
                args: '',
                result: typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output, null, 2),
                isError: ev.isError,
                latencyMs: ev.latencyMs,
                collapsed: true,
              });
            } else if (ev.kind === 'usage') {
              appG.__klyroAppStatus?.({ usageInput: ev.input, usageOutput: ev.output });
            } else if (ev.kind === 'aborted') {
              appG.__klyroAppStatus?.({ status: 'aborted' });
            }
          },
        },
        { adapter, registry, policy, approval, systemPrompt: systemPromptFn },
      );
      appG.__klyroAppStatus?.({ status: 'complete' === result.status ? 'done' : 'error', repairs: result.repairs ?? 0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appG.__klyroAppAppend?.({ id: `err-${Date.now()}`, kind: 'error', message });
      appG.__klyroAppStatus?.({ status: 'error', errorMessage: message });
    }
  }

  async function handleSlash(cmd: SlashCommand): Promise<void> {
    switch (cmd.kind) {
      case 'quit':
        app.unmount();
        process.exit(0);
        return;
      case 'clear':
        // Bypass via the app's setTranscript by re-rendering is awkward;
        // for MVP, append a marker and rely on the user to scroll.
        // A real implementation would expose a clear() method.
        appG.__klyroAppAppend?.({ id: `sep-${Date.now()}`, kind: 'text', text: '--- cleared ---', role: 'assistant' });
        return;
      case 'help': {
        const helpText = 'commands: /clear /compact /model <id> /diff /status /quit';
        appG.__klyroAppAppend?.({ id: `help-${Date.now()}`, kind: 'text', text: helpText, role: 'assistant' });
        return;
      }
      case 'status': {
        if (lastStatus) {
          appG.__klyroAppAppend?.({
            id: `stat-${Date.now()}`,
            kind: 'text',
            text: JSON.stringify(lastStatus, null, 2),
            role: 'assistant',
          });
        }
        return;
      }
      case 'compact':
      case 'diff':
      case 'model':
        appG.__klyroAppAppend?.({
          id: `stub-${Date.now()}`,
          kind: 'text',
          text: `/${cmd.kind} is a stub in this build. (${cmd.kind === 'model' ? `requested: ${cmd.model}` : 'persistence integration pending'})`,
          role: 'assistant',
        });
        return;
      case 'unknown':
        appG.__klyroAppAppend?.({
          id: `unk-${Date.now()}`,
          kind: 'error',
          message: `unknown command: ${cmd.raw} (try /help)`,
        });
        return;
    }
  }

  return new Promise<number>((resolve) => {
    process.on('exit', () => resolve(0));
  });
}
