/**
 * Policy engine — gates every tool call.
 *
 * Returns a Decision (allow/ask/deny) per tool call based on a list of rules
 * plus per-tool path/shell/secret checks. The runtime loop is the only
 * caller; it then either executes the tool, prompts the user, or skips
 * with a denial observation.
 */

import { safe } from '../tools/normalize.js';

export type Decision =
  | { action: 'allow' }
  | { action: 'ask'; reason: string }
  | { action: 'deny'; reason: string };

export interface ToolCallLike {
  /** Tool name, e.g. "write_file", "shell_exec". */
  name: string;
  /** Parsed tool input. */
  input: Record<string, unknown>;
}

export interface PolicyContext {
  cwd: string;
  /** Optional transcript (for future rule extensions). */
  transcript?: unknown;
  /** True when running in a non-interactive environment (CI, pipe). */
  nonInteractive: boolean;
  /** Per-tool config. */
  config: PolicyConfig;
}

export interface PolicyConfig {
  /** Shell commands that are pre-approved (prefix match). */
  shellAllow: string[];
  /** Hard-deny shell commands (prefix or full match). */
  shellDeny: string[];
  /** File size limit in MiB for reads without confirmation. */
  readSizeAskMiB: number;
}

export interface PolicyRule {
  name: string;
  /** Return a Decision to act on, or null to fall through to the next rule. */
  evaluate(call: ToolCallLike, ctx: PolicyContext): Decision | null;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  shellAllow: [
    'git',
    'ls',
    'cat',
    'head',
    'tail',
    'echo',
    'pwd',
    'npm test',
    'npm run test',
    'npx vitest',
    'npx tsc',
    'node -e',
  ],
  shellDeny: [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf .',
    'del /f /s /q C:\\',
    'format ',
    'mkfs',
    'dd if=',
    ':(){:|:&};:',
    'shutdown',
    'reboot',
    'bcdedit',
  ],
  readSizeAskMiB: 5,
};

/**
 * Compose multiple rules. The first rule to return a Decision wins.
 * If none return a Decision, the default is `allow`.
 */
export class PolicyEngine {
  constructor(
    private readonly rules: PolicyRule[],
    private readonly config: PolicyConfig = DEFAULT_POLICY_CONFIG,
  ) {}

  async evaluate(call: ToolCallLike, base: { cwd: string; transcript?: unknown; nonInteractive: boolean }): Promise<Decision> {
    const ctx: PolicyContext = {
      cwd: base.cwd,
      transcript: base.transcript,
      nonInteractive: base.nonInteractive,
      config: this.config,
    };
    for (const rule of this.rules) {
      const d = rule.evaluate(call, ctx);
      if (d) return d;
    }
    return { action: 'allow' };
  }
}

/** Builtin set of rules. Order matters: first match wins. */
export function builtinRules(): PolicyRule[] {
  return [
    shellDenyRule,
    shellAllowRule,
    writeFileCwdRule,
    readFileSizeRule,
  ];
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function startsWithAny(haystack: string, needles: string[]): boolean {
  const h = haystack.trim().toLowerCase();
  return needles.some((n) => {
    const nl = n.toLowerCase().replace(/\s+$/, ''); // strip trailing ws from needle
    return h === nl || h.startsWith(nl + ' ') || h.startsWith(nl + '\t');
  });
}

/** Hard-deny for obviously destructive shell patterns. */
export const shellDenyRule: PolicyRule = {
  name: 'shell-deny',
  evaluate(call, ctx) {
    if (call.name !== 'shell_exec' && call.name !== 'run_verify') return null;
    const cmd = asString(call.input.command);
    if (!cmd) return null;
    if (cmd.includes('..') && /rm|del/i.test(cmd) && /(\/|\b)([a-z]:)?[\\\/]\s*$|~|\/etc|\/usr|\/var|\/tmp/i.test(cmd)) {
      return { action: 'deny', reason: 'destructive command targeting system path' };
    }
    if (startsWithAny(cmd, ctx.config.shellDeny)) {
      return { action: 'deny', reason: `command matches deny list: ${cmd.slice(0, 60)}` };
    }
    // Pipe-to-shell: curl/wget/fetch piped into sh/bash/cmd.exe/PowerShell
    if (/\b(curl|wget|fetch|iwr|Invoke-WebRequest)\b.*\|\s*(sh|bash|zsh|cmd|powershell|pwsh|node|node\s+-e)\b/i.test(cmd)) {
      return { action: 'deny', reason: 'pipe-to-shell: remote download piped into an interpreter' };
    }
    return null;
  },
};

/** Allowlist for shell — exact or prefix. Anything not in the list asks. */
export const shellAllowRule: PolicyRule = {
  name: 'shell-allow',
  evaluate(call, ctx) {
    if (call.name !== 'shell_exec' && call.name !== 'run_verify') return null;
    const cmd = asString(call.input.command);
    if (!cmd) return null;
    if (startsWithAny(cmd, ctx.config.shellAllow)) return { action: 'allow' };
    if (ctx.nonInteractive) return { action: 'deny', reason: `non-interactive: '${cmd.slice(0, 40)}' not in allowlist` };
    return { action: 'ask', reason: `shell command not in allowlist: ${cmd.slice(0, 60)}` };
  },
};

/** Writes are auto-allowed if path resolves inside cwd (path-guard throws otherwise). */
export const writeFileCwdRule: PolicyRule = {
  name: 'write-file-cwd',
  evaluate(call) {
    if (call.name !== 'write_file' && call.name !== 'edit_file') return null;
    const p = asString(call.input.path);
    if (!p) return null;
    if (p.includes('..') || path.isAbsolute(p)) {
      return { action: 'deny', reason: 'path traversal or absolute path not allowed' };
    }
    return null;
  },
};

/** Reads > 5 MiB require confirmation (avoid filling the context window). */
export const readFileSizeRule: PolicyRule = {
  name: 'read-file-size',
  evaluate(call, ctx) {
    if (call.name !== 'read_file') return null;
    const size = typeof call.input.sizeBytes === 'number' ? call.input.sizeBytes : 0;
    if (size > ctx.config.readSizeAskMiB * 1024 * 1024) {
      if (ctx.nonInteractive) return { action: 'deny', reason: `file > ${ctx.config.readSizeAskMiB} MiB` };
      return { action: 'ask', reason: `file is ${(size / 1024 / 1024).toFixed(1)} MiB` };
    }
    return null;
  },
};

/** Convenience: evaluate via safe() so a buggy rule doesn't crash the loop. */
export async function evaluatePolicy(
  engine: PolicyEngine,
  call: ToolCallLike,
  ctx: { cwd: string; transcript?: unknown; nonInteractive: boolean },
): Promise<Decision> {
  const r = await safe(() => engine.evaluate(call, ctx));
  if (r.ok) return r.value;
  return { action: 'deny', reason: `policy error: ${r.error.message}` };
}

// Late import to avoid a circular dep with policy -> tools via path-guard.
// (path-guard is already in policy/, and tools/ depend on it. This keeps
//  policy/ depending only on tools/normalize, no other tool code.)
import * as path from 'node:path';
