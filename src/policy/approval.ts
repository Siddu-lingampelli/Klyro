/**
 * Interactive approval — prompt the user to allow/deny a tool call.
 *
 * TTY mode: shows the call, accepts y/n/a (yes/no/always-allow-this-command).
 * Non-TTY: returns deny. Callers should treat non-TTY as the default
 * (the user opted out of prompts with `--yes` or pipe input).
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { patternForCall } from './patterns.js';

export type ApprovalChoice =
  /** Yes, just this once. */
  | 'allow'
  | 'deny'
  /** Yes, and auto-allow this pattern for the rest of the session. */
  | 'always'
  /** Yes, session-allow AND persist the pattern to settings (survives restarts). */
  | 'always-persist'
  /**
   * Yes, but with edited input. Produced by the TUI modal (`e`): the
   * runtime re-validates + re-evaluates policy on `editedInput` (bounded
   * re-prompt loop) instead of running the original call. The stdin prompt
   * has no editor — `e` there stays `deny`.
   */
  | { kind: 'edit'; editedInput: Record<string, unknown> };

export interface ApprovalRequest {
  toolName: string;
  reason: string;
  /** Best-effort summary of the call (command or path). */
  summary: string;
  /** Raw tool input — used to derive the approval pattern when `pattern` is absent. */
  input?: Record<string, unknown>;
  /** Pre-derived approval pattern (`tool(glob)` grammar). */
  pattern?: string;
}

export interface ApprovalPrompt {
  ask(req: ApprovalRequest): Promise<ApprovalChoice>;
}

/**
 * Sanitize untrusted tool text before showing it in an approval prompt.
 * Strips ANSI escapes (CSI `ESC[...letter` and OSC `ESC]...BEL`), control
 * chars except `\n`/`\t`, and truncates to 500 chars with a hidden-count
 * marker so prompt-injection / terminal-escape payloads can't ride along.
 */
export function sanitizeForPrompt(s: string): string {
  const noAnsi = s
    // eslint-disable-next-line no-control-regex -- intentional: stripping CSI + OSC sequences
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex -- intentional: stripping OSC sequences
    .replace(/\x1b\][^\x07]*\x07/g, '');
  // eslint-disable-next-line no-control-regex -- intentional: stripping C0 controls
  const clean = noAnsi.replace(/[\x00-\x08\x0b-\x0d\x0e-\x1f\x7f]/g, '');
  const LIMIT = 500;
  if (clean.length > LIMIT) {
    return clean.slice(0, LIMIT) + `…[+${clean.length - LIMIT} hidden]`;
  }
  return clean;
}

/**
 * Single-key approval mapping shared by the TUI modal (and documented here
 * so stdin stays consistent): lowercase `a` = session-only, UPPERCASE `A` =
 * persist to settings. Case MUST be checked before lowercasing — the old TUI
 * code lowercased first, so `A` silently became session-only `always`.
 *
 * NOTE: `e` maps to `deny` here, but the TUI modal intercepts `e` BEFORE
 * this mapper to open inline edit mode (edit-and-retry). Only callers
 * without an editor (stdin prompt) should rely on the `e`→`deny` mapping.
 */
export function approvalChoiceForKey(inputStr: string): ApprovalChoice | 'expand' | 'explain' | null {
  if (inputStr === 'A') return 'always-persist';
  const c = inputStr.toLowerCase();
  if (c === 'y') return 'allow';
  if (c === 'a') return 'always';
  if (c === 'd' || c === 'n' || c === 'e') return 'deny';
  if (c === 'f') return 'expand';
  if (c === '?') return 'explain';
  return null;
}

/** Default prompt backed by readline on stdin/stdout. */
export class StdinApprovalPrompt implements ApprovalPrompt {
  async ask(req: ApprovalRequest): Promise<ApprovalChoice> {
    if (!input.isTTY) return 'deny';
    const rl = readline.createInterface({ input, output });
    try {
      process.stdout.write(`\n[approval needed] ${req.toolName}: ${sanitizeForPrompt(req.summary)}\n  reason: ${sanitizeForPrompt(req.reason)}\n  allow? [y/n/a/A(llow always → settings)] (y=once, n=deny, a=session, A=persist) `);
      const raw = (await rl.question('')).trim();
      const ans = raw.toLowerCase();
      if (ans === 'y' || ans === 'yes') return 'allow';
      if (raw === 'A') return 'always-persist';
      if (ans === 'a' || ans === 'allow') return 'always';
      return 'deny';
    } finally {
      rl.close();
    }
  }
}

/** Auto-deny — used in CI and `--no-approve` mode. */
export class DenyAllApprovalPrompt implements ApprovalPrompt {
  async ask(_req: ApprovalRequest): Promise<ApprovalChoice> {
    return 'deny';
  }
}

/**
 * Pattern approval cache — ask-once-per-pattern (Claude-Code-like).
 *
 * Wraps any inner prompt (TUI modal, stdin). The first `ask` for a pattern
 * delegates to the user; `always` records the pattern for the session,
 * `always-persist` additionally calls `onPersist` (the CLI wires this to
 * append the pattern to ~/.klyro/settings.json and the live engine).
 * Re-prompts never happen for a recorded pattern within the session.
 *
 * The pattern comes from `req.pattern` (pre-derived by the runtime via
 * `patternForCall`) or is derived from `req.input` here as a fallback.
 */
export class PatternApprovalCache implements ApprovalPrompt {
  private readonly session = new Set<string>();
  constructor(
    private readonly inner: ApprovalPrompt = new DenyAllApprovalPrompt(),
    private readonly opts: { onPersist?: (pattern: string) => void | Promise<void> } = {},
  ) {}

  async ask(req: ApprovalRequest): Promise<ApprovalChoice> {
    const key = req.pattern ?? patternFromRequest(req);
    if (key && this.session.has(key)) return 'allow';
    const choice = await this.inner.ask(req);
    // Edited input is a new call, not an approval of the pattern — pass
    // through without caching so the re-evaluated call prompts on its own.
    if (typeof choice === 'object') return choice;
    if ((choice === 'always' || choice === 'always-persist') && key) {
      this.session.add(key);
    }
    if (choice === 'always-persist' && key) {
      // Best-effort: the current call is already approved via the session
      // set above — a persist failure must not retro-deny it.
      try {
        await this.opts.onPersist?.(key);
      } catch {
        /* ignore */
      }
    }
    return choice;
  }
}

function patternFromRequest(req: ApprovalRequest): string | undefined {
  if (!req.input) return undefined;
  return patternForCall(req.toolName, req.input);
}
