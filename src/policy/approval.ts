/**
 * Interactive approval — prompt the user to allow/deny a tool call.
 *
 * TTY mode: shows the call, accepts y/n/a (yes/no/always-allow-this-command).
 * Non-TTY: returns deny. Callers should treat non-TTY as the default
 * (the user opted out of prompts with `--yes` or pipe input).
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export type ApprovalChoice = 'allow' | 'deny' | 'always';

export interface ApprovalRequest {
  toolName: string;
  reason: string;
  /** Best-effort summary of the call (command or path). */
  summary: string;
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
 * In-memory allowlist: tracks "always" choices by command prefix so a
 * single prompt per command covers repeat invocations in the same session.
 */
export class InMemoryAllowlist implements ApprovalPrompt {
  private readonly allow = new Set<string>();
  constructor(private readonly inner: ApprovalPrompt = new DenyAllApprovalPrompt()) {}

  async ask(req: ApprovalRequest): Promise<ApprovalChoice> {
    if (this.allow.has(req.summary)) return 'allow';
    const choice = await this.inner.ask(req);
    if (choice === 'always') this.allow.add(req.summary);
    return choice;
  }
}
