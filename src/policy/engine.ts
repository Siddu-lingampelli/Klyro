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
  /**
   * Tool risk class from the registry (`read|edit|execute|network|admin`).
   * The runtime always passes this; when present, `execute`/`network`/
   * `admin` tools fall through to ask/deny instead of the legacy
   * default-allow (see evaluate). Omitted in unit tests → legacy
   * default-allow.
   */
  permission?: 'read' | 'edit' | 'execute' | 'network' | 'admin';
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
 * If none return a Decision, privileged tools (`execute`/`network`/`admin`,
 * when the caller passes `permission`) fall through to ask (interactive) or
 * deny (headless) instead of allow; everything else defaults to `allow`.
 * `auto` mode keeps the legacy allow-everything behavior.
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
      if (
        call.name === 'write_file' ||
        call.name === 'edit_file' ||
        call.name === 'multi_edit' ||
        call.name === 'apply_patch' ||
        call.name === 'memory_write'
      ) {
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

    // Centralized .env guard: any tool with a string `path` input pointing
    // at an env file is denied unless an allow rule explicitly names that
    // tool+path (exact/glob match — substring `.includes('.env')` is NOT enough).
    const maybePath = typeof call.input.path === 'string' ? String(call.input.path) : null;
    if (maybePath !== null && isEnvPath(maybePath)) {
      const allowed = isExplicitlyAllowedForPath(call.name, maybePath, ctx.config.allow);
      if (!allowed) {
        return { action: 'deny', reason: 'write to .env denied by policy — add to allow list or use --yolo' };
      }
    }
    // apply_patch carries paths inside the patch text, not `input.path`.
    if (call.name === 'apply_patch' && typeof call.input.patch === 'string') {
      const targets = extractPatchPaths(String(call.input.patch)).filter(isEnvPath);
      if (targets.length > 0) {
        const allAllowed = targets.every((t) => isExplicitlyAllowedForPath(call.name, t, ctx.config.allow));
        if (!allAllowed) {
          return { action: 'deny', reason: 'write to .env denied by policy — add to allow list or use --yolo' };
        }
      }
    }
    // Shell redirection into .env (e.g. `echo x > .env`, `cmd >> .env.local`).
    if (call.name === 'shell_exec' && typeof call.input.command === 'string') {
      const cmd = String(call.input.command);
      if (/>+\s*['"]?[^'"\s]*\.env/i.test(cmd)) {
        return { action: 'deny', reason: 'write to .env via shell redirection denied' };
      }
    }

    for (const rule of this.rules) {
      const d = rule.evaluate(call, ctx);
      if (d) return d;
    }
    // Privileged-class default: an `execute`/`network`/`admin` tool that no
    // rule explicitly allowed must not run silently. Interactive sessions
    // get an approval prompt; headless sessions get a denial naming the
    // escape hatch (an explicit `tool`/`tool(glob)` allow rule).
    if (ctx.config.mode !== 'auto' && (call.permission === 'execute' || call.permission === 'network' || call.permission === 'admin')) {
      if (ctx.nonInteractive) {
        return { action: 'deny', reason: `${call.name} is a privileged ${call.permission} tool — pre-approve with an allow rule (e.g. "${call.name}")` };
      }
      return { action: 'ask', reason: `${call.name} is a privileged ${call.permission} tool and needs approval` };
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

  /**
   * Session rule management — appends a glob rule (`tool(glob)` grammar)
   * if not already present. Used for persisted "always allow" patterns
   * (loaded at startup) and live additions (approval `always→settings`).
   */
  addAllow(rule: string): void {
    const list = (this.config.allow ??= []);
    if (!list.includes(rule)) list.push(rule);
  }

  addDeny(rule: string): void {
    const list = (this.config.deny ??= []);
    if (!list.includes(rule)) list.push(rule);
  }

  addAsk(rule: string): void {
    const list = (this.config.ask ??= []);
    if (!list.includes(rule)) list.push(rule);
  }

  applyRules(rules: { allow?: string[]; deny?: string[]; ask?: string[] }): void {
    for (const r of rules.allow ?? []) this.addAllow(r);
    for (const r of rules.deny ?? []) this.addDeny(r);
    for (const r of rules.ask ?? []) this.addAsk(r);
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

function isEnvPath(p: string): boolean {
  const lower = p.toLowerCase();
  // Sample/template carve-out: `.env.example`-style files are documentation,
  // not secrets — reads AND writes are allowed.
  if (/[.](example|sample|template|dist)$/.test(lower)) return false;
  return /(^|\/)\.env(\.|$)/.test(lower) || lower.endsWith('.env');
}

function extractPatchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('*** Update File:')) out.push(line.replace('*** Update File:', '').trim());
    else if (line.startsWith('*** Add File:')) out.push(line.replace('*** Add File:', '').trim());
  }
  return out.filter(Boolean);
}

/** True when an allow rule explicitly names this tool+path (exact/glob match, not substring). */
function isExplicitlyAllowedForPath(callName: string, envPath: string, allow: string[] | undefined): boolean {
  if (!allow || allow.length === 0) return false;
  const synthetic: ToolCallLike = { name: callName, input: { path: envPath } };
  return allow.some((r) => matchesGlobRule(synthetic, r));
}

export function matchesGlobRule(call: ToolCallLike, rule: string): boolean {
  // Rule grammar: tool or tool(glob). e.g. "write_file", "write_file(.env)", "shell_exec(npm *)".
  // Digits are allowed so generated names (e.g. mcp__server__tool2) can be targeted.
  const m = /^([a-z0-9_]+)(?:\((.*)\))?$/.exec(rule.trim());
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

/** Branches that `git push` must never target without an explicit opt-out. */
export const PROTECTED_BRANCHES = ['main', 'master', 'production'];

/** Matches `push` with a protected branch name later on the same line. */
export const PROTECTED_PUSH_RE = /\bpush\b[^\n]*\b(main|master|production)\b/;

const GIT_PUSH_RE = /\bgit\b[^\n]*\bpush\b/;

/**
 * True when the command is a `git push` with NO ref/positional args
 * (e.g. `git push`, `git push -f`) — i.e. it pushes whatever is checked
 * out. `git push origin feature` is explicit, not bare.
 */
export function isBareGitPush(cmd: string): boolean {
  if (!GIT_PUSH_RE.test(cmd)) return false;
  const idx = cmd.search(/\bpush\b/);
  const rest = idx >= 0 ? cmd.slice(idx + 4) : '';
  const segment = (rest.split(/[;&|]/)[0] ?? '').split(/\n/)[0] ?? '';
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const positionals = tokens.filter((t) => {
    const unquoted = t.replace(/^["']|["']$/g, '');
    return unquoted.length > 0 && !unquoted.startsWith('-');
  });
  return positionals.length === 0;
}

/**
 * Resolve the currently checked-out branch via `git branch --show-current`.
 * Returns null on any failure (not a repo, git missing) — callers treat
 * null as "unknown" and allow the normal policy flow to continue.
 */
export function currentGitBranch(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, 'branch', '--show-current'], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    const branch = String(out).trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
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
    // Exfiltration denylist (mirrors shell_exec DANGEROUS_PATTERNS).
    if (/\bcurl\b.*(?:\s-d\b|\s--data(?:-binary|-urlencode)?\b|\s--upload-file\b)/i.test(cmd)) {
      return { action: 'deny', reason: 'exfiltration: curl with --data/-d/--upload-file denied' };
    }
    if (/\bwget\b.*--post-(data|file)\b/i.test(cmd)) {
      return { action: 'deny', reason: 'exfiltration: wget --post-data/--post-file denied' };
    }
    if (/\b(powershell|pwsh)\b.*-e(nc|ncodedcommand)\b/i.test(cmd)) {
      return { action: 'deny', reason: 'exfiltration: powershell -enc denied' };
    }
    if (/\bInvoke-Expression\b/i.test(cmd) || /\biex\s*\(/i.test(cmd)) {
      return { action: 'deny', reason: 'exfiltration: Invoke-Expression/iex denied' };
    }
    if (/\bcertutil\b.*-urlcache\b/i.test(cmd)) {
      return { action: 'deny', reason: 'exfiltration: certutil -urlcache denied' };
    }
    if (/\bbitsadmin\b.*\/transfer\b/i.test(cmd)) {
      return { action: 'deny', reason: 'exfiltration: bitsadmin /transfer denied' };
    }
    // .env writes via tee / PowerShell (mirrors shell_exec DANGEROUS_PATTERNS).
    if (/\|\s*tee\b[^\n]*\.env/i.test(cmd)) {
      return { action: 'deny', reason: 'write to .env via tee denied' };
    }
    if (/\b(Set-Content|Out-File)\b[^\n]*\.env/i.test(cmd)) {
      return { action: 'deny', reason: 'write to .env via Set-Content/Out-File denied' };
    }
    // Shell-redirection containment: deny `>` / `>>` into dotfiles.
    // Home/abs dotfile target (e.g. `> ~/.klyro/mcp.json`, `> /home/u/.config/x`).
    // The `(?<![0-9])` guard excludes the `2>` stderr-redirect prefix.
    if (/(?<![0-9])>+\s*["']?(~|\/)[^"'\s]*\/\.[^"'\s]+/.test(cmd)) {
      return { action: 'deny', reason: 'redirect into dotfile under home/abs path denied' };
    }
    // Bare project dotfile target (e.g. `> .mcp.json`, `>> .env.local`).
    if (/(?<![0-9])>+\s*["']?\.[^"'\s\/][^"'\s]*/.test(cmd)) {
      return { action: 'deny', reason: 'redirect into project dotfile denied' };
    }
    // Upload-form exfiltration (mirrors shell_exec DANGEROUS_PATTERNS).
    if (/\bcurl\b.*(?:\s-F\b|\s--form\b)/i.test(cmd)) {
      return { action: 'deny', reason: 'exfiltration: curl -F/--form denied' };
    }
    if (/\bwget\b.*(?:\s--method=POST\b|\s--body-data\b)/i.test(cmd)) {
      return { action: 'deny', reason: 'exfiltration: wget --method=POST/--body-data denied' };
    }
    if (/\bInvoke-RestMethod\b/i.test(cmd)) {
      return { action: 'deny', reason: 'exfiltration: Invoke-RestMethod denied' };
    }
    if (/\bStart-BitsTransfer\b/i.test(cmd)) {
      return { action: 'deny', reason: 'exfiltration: Start-BitsTransfer denied' };
    }
    // Windows has no native sandbox backend, so PowerShell network primitives
    // are the primary upload/exfil vectors there — denied outright (mirrors
    // shell_exec DANGEROUS_PATTERNS).
    if (/\b(Invoke-WebRequest|iwr)\b/i.test(cmd)) {
      return { action: 'deny', reason: 'exfiltration: Invoke-WebRequest/iwr denied (no win32 sandbox backend)' };
    }
    if (/\bSystem\.Net\.WebClient\b/i.test(cmd)) {
      return { action: 'deny', reason: 'exfiltration: System.Net.WebClient denied (no win32 sandbox backend)' };
    }
    // Protected-branch push deny (mirrors shell_exec DANGEROUS_PATTERNS).
    // Explicit `git push ... main|master|production` is denied outright;
    // a bare `git push` (no ref args) is denied when the checkout is on a
    // protected branch. Escape hatch: KLYRO_ALLOW_MAIN_PUSH=1.
    if (process.env.KLYRO_ALLOW_MAIN_PUSH !== '1') {
      if (PROTECTED_PUSH_RE.test(cmd)) {
        return { action: 'deny', reason: 'protected-branch push denied (main/master/production) — set KLYRO_ALLOW_MAIN_PUSH=1 to override' };
      }
      if (isBareGitPush(cmd)) {
        const branch = currentGitBranch(ctx.cwd);
        if (branch !== null && PROTECTED_BRANCHES.includes(branch)) {
          return { action: 'deny', reason: `bare git push on protected branch '${branch}' denied — set KLYRO_ALLOW_MAIN_PUSH=1 to override` };
        }
        // currentGitBranch null (not a repo / git missing) → allow normal flow.
      }
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
import { execFileSync } from 'node:child_process';
import { resolveWithinCwd } from './path-guard.js';
