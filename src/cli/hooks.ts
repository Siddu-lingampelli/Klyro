/**
 * Hooks engine (10.2, v2) — lifecycle + tool shell hooks.
 *
 * Events: `preToolUse` / `postToolUse` (per tool call), `sessionStart`
 * (once per run, may abort it), `sessionEnd` (once per run, best-effort),
 * `stop` (after each agent step).
 *
 * Config files:
 *   - project: `<cwd>/.klyro/hooks.json`
 *   - global:  `~/.klyro/hooks.json` (merged; project wins on name clash)
 *
 * Schema: `{ hooks: Array<{ name, event, command, matcher?, timeoutMs? }> }`.
 * `matcher` is a regex tested against the tool name — lifecycle events
 * (`sessionStart`/`sessionEnd`/`stop`) always match; tool events without a
 * matcher match every tool; invalid regex never matches.
 *
 * Verdict contract: stdout parsed as JSON yields `{decision, message,
 * context, continue|cont}`. preToolUse `decision:"deny"` blocks with
 * `message` (wins over exit code); `decision:"allow"` + `context` attaches
 * model-visible context to the tool result. stop `continue:true` grants one
 * more turn (max 3/run). Non-JSON stdout keeps pure exit-code semantics.
 *
 * `loadHooks` never throws — a missing file is `[]`, an invalid file is
 * `[]` plus a one-time stderr warning per path. `runHook` spawns the
 * command with `shell: true` (commands are strings, must work on win +
 * posix), a default 30s timeout, a filtered env, `KLYRO_TOOL_NAME` /
 * `KLYRO_TOOL_INPUT_JSON` for inspection, AND the full JSON payload on
 * stdin (`{ event, tool, input, sessionId, ... }`).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { stripBom } from '../shared/json.js';

export const HookEventSchema = z.enum(['preToolUse', 'postToolUse', 'sessionStart', 'sessionEnd', 'stop']);
export type HookEvent = z.infer<typeof HookEventSchema>;

export const HookSchema = z.object({
  name: z.string().min(1),
  event: HookEventSchema,
  command: z.string().min(1),
  /** Optional regex matched against the tool name (tool events only). */
  matcher: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const HooksFileSchema = z.object({
  hooks: z.array(HookSchema),
});

export type Hook = z.infer<typeof HookSchema>;

export interface HookResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /**
   * Structured verdict parsed from stdout when it is a JSON object
   * (mirrors CC hook JSON output). Fields:
   *   - decision: 'allow' | 'deny' (preToolUse; deny wins over exit code)
   *   - message: denial reason / continuation note
   *   - context: extra model-visible context (preToolUse allow only)
   *   - cont: stop-hook request to continue the loop one more turn
   */
  verdict?: {
    decision?: string;
    message?: string;
    context?: string;
    cont?: boolean;
  };
}

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const MAX_HOOK_OUTPUT_CHARS = 4000;

/** Paths already warned about (invalid JSON/schema) — warn once per path. */
const warnedPaths = new Set<string>();

function warnOnce(filePath: string, detail: string): void {
  warnOnceRaw(`invalid:${normWarnKey(filePath)}`, `klyro: hooks: ignoring invalid file ${filePath}: ${detail}\n`);
}

/**
 * Warn-once keys normalize the file identity (resolved absolute path +
 * NFKC) so the same content can't re-warn via `./x`, `X/../x`, case, or
 * slash variants — each real file warns at most once.
 */
function normWarnKey(filePath: string): string {
  try {
    return path.resolve(filePath).normalize('NFKC');
  } catch {
    return filePath;
  }
}

/** One stderr line per unique key (used for trust notices too). */
function warnOnceRaw(key: string, message: string): void {
  if (warnedPaths.has(key)) return;
  warnedPaths.add(key);
  try {
    process.stderr.write(message);
  } catch { /* ignore */ }
}

/** Read + validate one hooks file. Missing → []. Invalid → [] + warn once. */
function readHooksFile(filePath: string): Hook[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return []; // missing/unreadable — silent, zero-cost fast path stays silent
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (err) {
    warnOnce(filePath, err instanceof Error ? err.message : String(err));
    return [];
  }
  const checked = HooksFileSchema.safeParse(parsed);
  if (!checked.success) {
    const first = checked.error.issues[0];
    warnOnce(filePath, first ? `${first.path.join('.') || 'hooks'}: ${first.message}` : 'schema mismatch');
    return [];
  }
  return checked.data.hooks;
}

function globalHooksPath(): string {
  try {
    return path.join(os.homedir() || process.cwd(), '.klyro', 'hooks.json');
  } catch {
    return path.join(process.cwd(), '.klyro', 'hooks.json');
  }
}

/**
 * Load hooks for a run. Global first, then project — a project hook with
 * the same `name` replaces the global one. Never throws.
 *
 * Project hooks are repo-authored and run with `shell: true`, so they are
 * gated on trust (see `projectHooksTrusted`): a cloned repo must not execute
 * code just because someone ran `klyro` in it, and an untrusted project can
 * not shadow a global hook by name.
 */
export function loadHooks(cwd: string): Hook[] {
  let out: Hook[] = [];
  try {
    const byName = new Map<string, Hook>();
    for (const h of readHooksFile(globalHooksPath())) byName.set(h.name, h);
    const projectFile = projectHooksPath(cwd);
    if (fs.existsSync(projectFile)) {
      if (projectHooksTrusted(cwd)) {
        for (const h of readHooksFile(projectFile)) byName.set(h.name, h);
      } else {
        warnOnceRaw(
          `untrusted:${normWarnKey(projectFile)}`,
          `klyro: hooks: project hooks ${projectFile} are NOT trusted — review the file, then run \`klyro hooks trust\` (or set KLYRO_TRUST_PROJECT_HOOKS=1)\n`,
        );
      }
    }
    out = [...byName.values()];
  } catch {
    return [];
  }
  return out;
}

/** Absolute path of the project's hook file (may not exist). */
export function projectHooksPath(cwd: string): string {
  return path.join(cwd, '.klyro', 'hooks.json');
}

/** Hash-pinned trust store: `{ "<resolved absolute path>": "<sha256 hex>" }`. */
function trustStorePath(): string {
  return path.join(os.homedir() || process.cwd(), '.klyro', 'trusted-hooks.json');
}

function sha256File(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function trustedHashes(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(trustStorePath(), 'utf-8')) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch { /* missing or invalid — nothing trusted */ }
  return {};
}

function writeTrustStore(store: Record<string, string>): void {
  const p = trustStorePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

/**
 * Is the project's hook file allowed to run? Two paths:
 *   1. `KLYRO_TRUST_PROJECT_HOOKS=1` — explicit per-shell opt-in, or
 *   2. the file's current sha256 is pinned in `~/.klyro/trusted-hooks.json`
 *      (recorded by an explicit `klyro hooks trust`; any later edit changes
 *      the hash, so the file re-locks until reviewed again).
 */
export function projectHooksTrusted(cwd: string): boolean {
  if (process.env.KLYRO_TRUST_PROJECT_HOOKS === '1') return true;
  const file = projectHooksPath(cwd);
  if (!fs.existsSync(file)) return false;
  const hash = sha256File(file);
  if (!hash) return false;
  const store = trustedHashes();
  const resolved = path.resolve(file);
  return store[resolved] === hash || store[file] === hash;
}

/** Describe the project's hook file for the `klyro hooks` surface. */
export function projectHooksStatus(cwd: string): { path: string; exists: boolean; trusted: boolean } {
  const file = projectHooksPath(cwd);
  const exists = fs.existsSync(file);
  return { path: file, exists, trusted: exists && projectHooksTrusted(cwd) };
}

/**
 * Trust (or re-trust) the project's hooks file at its current contents.
 * Throws when there is no project hooks file.
 */
export function trustProjectHooks(cwd: string): { path: string; hash: string } {
  const file = projectHooksPath(cwd);
  const hash = sha256File(file);
  if (!hash) throw new Error(`no project hooks file at ${file}`);
  const store = trustedHashes();
  store[path.resolve(file)] = hash;
  writeTrustStore(store);
  return { path: file, hash };
}

/** Remove the project's hook file from the trust store. False when absent. */
export function untrustProjectHooks(cwd: string): boolean {
  const resolved = path.resolve(projectHooksPath(cwd));
  const store = trustedHashes();
  if (store[resolved] === undefined) return false;
  delete store[resolved];
  writeTrustStore(store);
  return true;
}

/**
 * Minimal filtered env for hook children (mirrors the shell_exec policy:
 * secrets stripped, only safe prefixes pass). Kept local so the hooks
 * engine never depends on the tool layer at import time.
 */
function hookEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('KLYRO_') && k.includes('API_KEY')) continue;
    if (k.includes('SECRET') || k.includes('TOKEN') || k === 'ANTHROPIC_API_KEY' || k === 'OPENAI_API_KEY') continue;
    if (
      k.startsWith('PATH') || k.startsWith('HOME') || k.startsWith('USER') ||
      k.startsWith('SHELL') || k.startsWith('TERM') || k.startsWith('LANG') ||
      k.startsWith('NODE_') || k.startsWith('NPM_') || k.startsWith('PNPM_') ||
      k.startsWith('YARN_') || k === 'PWD' || k === 'TMPDIR' || k === 'TEMP' ||
      k === 'SystemRoot' || k === 'windir' || k === 'PATHEXT' || k === 'OS'
    ) {
      out[k] = v;
    }
  }
  out.PATH = process.env.PATH;
  return out;
}

export interface HookContext {
  toolName: string;
  input: unknown;
}

/** Lifecycle payload delivered on stdin (and merged into env where small). */
export interface HookPayload {
  event: HookEvent;
  tool?: string;
  input?: unknown;
  sessionId?: string;
  cwd?: string;
  status?: string;
  step?: number;
}

/**
 * Select hooks for an event. Tool events honor `matcher` (regex against the
 * tool name; invalid regex never matches); lifecycle events always match.
 * Exported pure for unit tests.
 */
export function hooksForEvent(hooks: Hook[], event: HookEvent, toolName?: string): Hook[] {
  return hooks.filter((h) => {
    if (h.event !== event) return false;
    if (h.matcher === undefined) return true;
    if (toolName === undefined) return true; // lifecycle events have no tool
    try {
      return new RegExp(h.matcher).test(toolName);
    } catch {
      return false;
    }
  });
}

/**
 * Run one hook. Resolves (never rejects) with the exit code + sliced
 * output. `ok` is true only when the process exited 0.
 *
 * `stdinJson` (when given) is written to the child's stdin as JSON —
 * the primary contract (mirrors CC's stdin-JSON hooks); the env vars are
 * kept as a convenience for shell one-liners.
 */
export function runHook(hook: Hook, ctx: HookContext, stdinJson?: unknown): Promise<HookResult> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  return new Promise((resolve) => {
    let env: NodeJS.ProcessEnv;
    try {
      // Filtered env (same policy as shell_exec): secrets stripped, only
      // safe prefixes pass — plus the hook's own inspection vars below.
      env = hookEnv();
    } catch {
      env = { PATH: process.env.PATH };
    }
    env.KLYRO_TOOL_NAME = ctx.toolName;
    try {
      env.KLYRO_TOOL_INPUT_JSON = JSON.stringify(ctx.input ?? {}).slice(0, 16_000);
    } catch {
      env.KLYRO_TOOL_INPUT_JSON = '{}';
    }
    let payload = '';
    try {
      payload = JSON.stringify(stdinJson ?? { event: 'preToolUse', tool: ctx.toolName, input: ctx.input ?? {} });
    } catch {
      payload = '{}';
    }
    let child;
    try {
      child = spawn(hook.command, {
        cwd: process.cwd(),
        shell: true,
        windowsHide: true,
        timeout: timeoutMs,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, exitCode: -1, stdout: '', stderr: String(err instanceof Error ? err.message : err).slice(0, MAX_HOOK_OUTPUT_CHARS) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer | string) => {
      stdout += d.toString();
      if (stdout.length > MAX_HOOK_OUTPUT_CHARS * 2) stdout = stdout.slice(0, MAX_HOOK_OUTPUT_CHARS * 2);
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr += d.toString();
      if (stderr.length > MAX_HOOK_OUTPUT_CHARS * 2) stderr = stderr.slice(0, MAX_HOOK_OUTPUT_CHARS * 2);
    });
    child.on('error', (err) => {
      resolve({ ok: false, exitCode: -1, stdout: stdout.slice(0, MAX_HOOK_OUTPUT_CHARS), stderr: String(err.message ?? err).slice(0, MAX_HOOK_OUTPUT_CHARS) });
    });
    child.on('close', (code) => {
      const exitCode = typeof code === 'number' ? code : -1;
      const out = stdout.slice(0, MAX_HOOK_OUTPUT_CHARS);
      resolve({
        ok: exitCode === 0,
        exitCode,
        stdout: out,
        stderr: stderr.slice(0, MAX_HOOK_OUTPUT_CHARS),
        ...parseVerdict(out),
      });
    });
    // Deliver the stdin JSON contract, then close so the child never hangs
    // waiting for EOF. Write errors (EPIPE on early exit) are ignored —
    // the exit code below is what matters.
    try {
      if (child.stdin) {
        child.stdin.on('error', () => undefined);
        child.stdin.write(payload);
        child.stdin.end();
      }
    } catch { /* ignore */ }
  });
}

/** Parse a structured JSON verdict from hook stdout (best-effort). */
function parseVerdict(out: string): Pick<HookResult, 'verdict'> {
  const trimmed = out.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return {};
  try {
    const p = JSON.parse(trimmed) as Record<string, unknown>;
    const verdict: NonNullable<HookResult['verdict']> = {};
    if (typeof p['decision'] === 'string') verdict.decision = p['decision'];
    if (typeof p['message'] === 'string') verdict.message = (p['message'] as string).slice(0, 2000);
    if (typeof p['context'] === 'string') verdict.context = (p['context'] as string).slice(0, 2000);
    if (typeof p['continue'] === 'boolean') verdict.cont = p['continue'] as boolean;
    if (typeof p['cont'] === 'boolean' && verdict.cont === undefined) verdict.cont = p['cont'] as boolean;
    return Object.keys(verdict).length > 0 ? { verdict } : {};
  } catch {
    return {};
  }
}
/**
 * Run all `sessionEnd` hooks for a finished run (best-effort, sequential).
 * Returns hook outputs for logging. Never throws.
 */
export async function runSessionEndHooks(cwd: string, sessionId: string | undefined, status: string): Promise<Array<{ name: string; ok: boolean; output: string }>> {
  const out: Array<{ name: string; ok: boolean; output: string }> = [];
  let hooks: Hook[];
  try {
    hooks = hooksForEvent(loadHooks(cwd), 'sessionEnd');
  } catch {
    return out;
  }
  for (const h of hooks) {
    try {
      const r = await runHook(h, { toolName: '', input: {} }, { event: 'sessionEnd', sessionId, cwd, status });
      out.push({ name: h.name, ok: r.ok, output: (r.stdout || r.stderr || '').slice(0, 2000) });
    } catch {
      out.push({ name: h.name, ok: false, output: '' });
    }
  }
  return out;
}
