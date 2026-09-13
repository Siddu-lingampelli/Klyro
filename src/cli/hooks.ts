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
 * matcher match every tool.
 *
 * `loadHooks` never throws — a missing file is `[]`, an invalid file is
 * `[]` plus a one-time stderr warning per path. `runHook` spawns the
 * command with `shell: true` (commands are strings, must work on win +
 * posix), a default 30s timeout, a filtered env, `KLYRO_TOOL_NAME` /
 * `KLYRO_TOOL_INPUT_JSON` for inspection, AND the full JSON payload on
 * stdin (`{ event, tool, input, sessionId, ... }`).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

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
}

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const MAX_HOOK_OUTPUT_CHARS = 4000;

/** Paths already warned about (invalid JSON/schema) — warn once per path. */
const warnedPaths = new Set<string>();

function warnOnce(filePath: string, detail: string): void {
  if (warnedPaths.has(filePath)) return;
  warnedPaths.add(filePath);
  try {
    process.stderr.write(`klyro: hooks: ignoring invalid file ${filePath}: ${detail}\n`);
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
    parsed = JSON.parse(raw);
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
 */
export function loadHooks(cwd: string): Hook[] {
  let out: Hook[] = [];
  try {
    const byName = new Map<string, Hook>();
    for (const h of readHooksFile(globalHooksPath())) byName.set(h.name, h);
    const projectFile = path.join(cwd, '.klyro', 'hooks.json');
    for (const h of readHooksFile(projectFile)) byName.set(h.name, h);
    out = [...byName.values()];
  } catch {
    return [];
  }
  return out;
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
      resolve({
        ok: exitCode === 0,
        exitCode,
        stdout: stdout.slice(0, MAX_HOOK_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_HOOK_OUTPUT_CHARS),
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
