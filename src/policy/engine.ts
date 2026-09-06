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

export type PermissionMode = 'default' | 'accept-edits' | 'plan' | 'auto';

export interface PolicyConfig {
  /** Permission mode */
  mode?: PermissionMode;
  /** Shell commands that are pre-approved (prefix match). */
  shellAllow: string[];
  /** Hard-deny shell commands (prefix or full match). */
  shellDeny: string[];
  /** File size limit in MiB for reads without confirmation. */
  readSizeAskMiB: number;
  /** Glob rules: e.g. "write_file", "write_file(.env)", "shell_exec(npm *)" */
  allow?: string[];
  deny?: string[];
  ask?: string[];
  /** Additional allowed directories (sandbox) */
  additionalDirs?: string[];
}

export interface PolicyRule {
  name: string;
  /** Return a Decision to act on, or null to fall through to the next rule. */
  evaluate(call: ToolCallLike, ctx: PolicyContext): Decision | null;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  mode: 'default',
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
  allow: [],
  deny: [],
  ask: [],
  additionalDirs: [],
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

    // 3.4 — Permission modes
    if (ctx.config.mode === 'auto') {
      // auto / --yolo: allow everything (except hard deny already handled)
    } else if (ctx.config.mode === 'plan') {
      // plan mode: block all writes (edit)
      if (call.name === 'write_file' || call.name === 'edit_file') {
        return { action: 'deny', reason: 'plan mode: writes blocked — use /permissions to allow or switch mode' };
      }
    } else if (ctx.config.mode === 'accept-edits') {
      // accept-edits: auto-allow edit tools
      if (call.name === 'write_file' || call.name === 'edit_file') {
        // fall through to allow, but still check .env below
      }
    }

    // 3.4 — Glob rules allow/deny/ask with precedence deny → allow → ask
    const globDecision = this.evaluateGlobRules(call);
    if (globDecision) return globDecision;

    // 3.4 — .env guard: deny writes to .env files unless explicitly allowed
    if ((call.name === 'write_file' || call.name === 'edit_file') && typeof call.input.path === 'string') {
      const p = String(call.input.path);
      if (/(^|\/)\.env(\.|$)/.test(p) || p.endsWith('.env')) {
        // Check if explicitly allowed via allow list
        const allowed = (ctx.config.allow ?? []).some((r) => r.includes('.env'));
        if (!allowed) {
          return { action: 'deny', reason: 'write to .env denied by policy — add to allow list or use --yolo' };
        }
      }
    }

    for (const rule of this.rules) {
      const d = rule.evaluate(call, ctx);
      if (d) return d;
    }
    return { action: 'allow' };
  }

  private evaluateGlobRules(call: ToolCallLike): Decision | null {
    const check = (list: string[] | undefined, action: Decision['action']): Decision | null => {
      if (!list || list.length === 0) return null;
      for (const rule of list) {
        if (matchesGlobRule(call, rule)) {
          if (action === 'allow') return { action: 'allow' };
          if (action === 'deny') return { action: 'deny', reason: `denied by rule: ${rule}` };
          return { action: 'ask', reason: `requires approval per rule: ${rule}` };
        }
      }
      return null;
    };
    // Precedence: deny → allow → ask
    return check(this.config.deny, 'deny') ?? check(this.config.allow, 'allow') ?? check(this.config.ask, 'ask') ?? null;
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

function matchesGlobRule(call: ToolCallLike, rule: string): boolean {
  // Rule grammar: tool or tool(glob). e.g. "write_file", "write_file(.env)", "shell_exec(npm *)"
  const m = /^([a-z_]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const tool = m[1]!;
  const glob = m[2];
  if (tool !== call.name) return false;
  if (glob === undefined) return true; // any input for that tool
  // For shell, match command; for file tools, match path
  const target = typeof call.input.command === 'string' ? String(call.input.command)
    : typeof call.input.path === 'string' ? String(call.input.path)
    : JSON.stringify(call.input);
  // Simple glob: * matches any, ? matches single, otherwise substring
  const regexStr = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const re = new RegExp(`^${regexStr}$`, 'i');
  return re.test(target);
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

/** Writes are auto-allowed if path resolves inside cwd or --add-dir (path-guard throws otherwise). */
export const writeFileCwdRule: PolicyRule = {
  name: 'write-file-cwd',
  evaluate(call, ctx) {
    if (call.name !== 'write_file' && call.name !== 'edit_file') return null;
    const p = asString(call.input.path);
    if (!p) return null;
    if (p.includes('..') || path.isAbsolute(p)) {
      // Check if absolute is inside additionalDirs
      if (path.isAbsolute(p)) {
        const allowed = (ctx.config.additionalDirs ?? []).some((dir) => {
          const rel = path.relative(path.resolve(dir), path.resolve(p));
          return !rel.startsWith('..') && !path.isAbsolute(rel);
        });
        if (allowed) return null;
      }
      return { action: 'deny', reason: 'path traversal or absolute path not allowed' };
    }
    return null;
  },
};

/**
 * Reads > readSizeAskMiB require confirmation (avoid filling the context).
 * Stats the file directly — the old sizeBytes input never existed in the
 * read_file schema, so this rule never fired (dead code until now).
 */
export const readFileSizeRule: PolicyRule = {
  name: 'read-file-size',
  evaluate(call, ctx) {
    if (call.name !== 'read_file') return null;
    const p = asString(call.input.path);
    if (!p) return null;
    let size = 0;
    try {
      const { resolved } = resolveWithinCwd(ctx.cwd, p);
      size = fsSync.statSync(resolved).size;
    } catch {
      return null; // unreadable → other rules/tools report it
    }
    if (size > ctx.config.readSizeAskMiB * 1024 * 1024) {
      if (ctx.nonInteractive) return { action: 'deny', reason: `file > ${ctx.config.readSizeAskMiB} MiB` };
      return { action: 'ask', reason: `file is ${(size / 1024 / 1024).toFixed(1)} MiB` };
    }
    return null;
  },
};

/**
 * Deep-clone a PolicyConfig so per-session tweaks (/mode, /sandbox) never
 * leak across engines via the shared DEFAULT_POLICY_CONFIG reference.
 */
export function clonePolicyConfig(base: PolicyConfig = DEFAULT_POLICY_CONFIG): PolicyConfig {
  return {
    ...base,
    shellAllow: [...base.shellAllow],
    shellDeny: [...base.shellDeny],
    allow: [...(base.allow ?? [])],
    deny: [...(base.deny ?? [])],
    ask: [...(base.ask ?? [])],
    additionalDirs: [...(base.additionalDirs ?? [])],
  };
}

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
import * as fsSync from 'node:fs';
import { resolveWithinCwd } from './path-guard.js';
