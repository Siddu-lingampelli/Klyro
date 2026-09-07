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
  | 'always-persist';

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

/** Default prompt backed by readline on stdin/stdout. */
export class StdinApprovalPrompt implements ApprovalPrompt {
  async ask(req: ApprovalRequest): Promise<ApprovalChoice> {
    if (!input.isTTY) return 'deny';
    const rl = readline.createInterface({ input, output });
    try {
      process.stdout.write(`\n[approval needed] ${req.toolName}: ${req.summary}\n  reason: ${req.reason}\n  allow? [y/n/a(llow)] `);
      const ans = (await rl.question('')).trim().toLowerCase();
      if (ans === 'y' || ans === 'yes') return 'allow';
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
