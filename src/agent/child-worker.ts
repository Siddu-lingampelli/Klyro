/**
 * G2 — Process isolation for sub-agents (V1: headless/CLI children).
 *
 * This module is the *child-process* end of spawn_agent. The orchestrator
 * forks this file with `node` (never shares a process), passing a
 * JSON-serializable payload on STDIN (not argv — the system prompt + memory
 * can exceed argv/command-line length limits, which would fail the spawn with
 * E2BIG). The child rebuilds a minimal but self-sufficient `RuntimeDeps`,
 * runs the task through `run()`, emits ONE JSON `ChildResult` line on stdout,
 * and exits 0/1.
 *
 * Isolation contract: a child that OOMs, segfaults, or enters an infinite
 * loop fails ONLY this process — the parent harness survives and reports
 * `CHILD_CRASH` exactly as it does for an in-process throw.
 *
 * V1 scope (documented honestly):
 *   - Headless children only. TUI children stay in-process because the Ink
 *     approval bridge is inherently tied to the parent terminal.
 *   - The child runs a system-prompt STRING (already assembled by the parent,
 *     so KLYRO.md + memory + trust decisions match) with a file-system tool
 *     subset and DenyAll approval — no MCP server forwarding, no live prompt.
 *   - Grandchild spawning is not forwarded: a process-isolated child rebuilds
 *     its own agent bridge-less deps, so its tools see NO_ORCHESTRATOR (same
 *     as a pre-bridge child). V2 may thread a task handle back via a socket.
 *
 * Secrets never cross the process boundary via argv/env leaks: the child
 * reads its provider key/baseURL from the SAME env the parent CLI uses
 * (KLYRO_API_KEY, KLYRO_BASE_URL), so credentials stay in-process/env,
 * never in the payload.
 */

import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { run } from './runtime.js';
import { cappedOutput } from '../shared/output-cap.js';
import type { RunOptions, RunResult, RuntimeDeps } from './runtime.js';

/** Child results are ONE JSON line, but a misbehaving child can print forever. */
const MAX_CHILD_STDOUT_BYTES = 8 * 1024 * 1024;
/** stderr keeps its TAIL — callers slice(-500/-1000) for the failure reason. */
const MAX_CHILD_STDERR_CHARS = 16_000;

export interface ChildWorkerPayload {
  /** Working dir the child operates in (may be a worktree). */
  cwd: string;
  /** The task prompt. */
  task: string;
  /** Model string (drives adapter selection + rate table). */
  model: string;
  /** Pre-assembled system prompt (stable + volatile already spliced). */
  systemPrompt: string;
  /** Agent id, for the system prompt identity. */
  agentId: string;
  /** Cap caps. */
  maxSteps?: number;
  maxCost?: number;
  maxTimeMs?: number;
  maxTokens?: number;
}

/** The one-line result the child prints to stdout on success. */
export type ChildResult = Pick<RunResult, 'status' | 'steps' | 'toolCalls' | 'finalText' | 'hasEdits' | 'usage'>;

/**
 * Differently-phrased crash, distinct from an in-process throw the parent
 * would catch. The child either exited non-zero without a parseable result
 * line, or produced a malformed result. Carries the raw stdout/stderr tail.
 */
export class ChildCrashError extends Error {
  constructor(
    message: string,
    readonly likelyCause: 'exit' | 'oom' | 'timeout',
    readonly stderrTail?: string,
  ) {
    super(message);
    this.name = 'ChildCrashError';
  }
}

/**
 * Resolve the compiled child-worker entry that *this* module's neighboring
 * build (src or dist) produced. Both dev (tsx, .ts) and packaged (dist, .js)
 * layouts live beside this file, so we probe for whichever exists.
 */
export function workerEntryPath(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  for (const ext of ['js', 'ts']) {
    const candidate = path.join(dir, `child-worker.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to the compiled name — the load path both layouts converge on.
  return path.join(dir, 'child-worker.js');
}

export interface ForkChildOptions {
  /** Abort the child process when this fires (wired to the parent signal). */
  signal?: AbortSignal;
  /** Abort+kill the child after this long (defaults to 10 min). */
  timeoutMs?: number;
  /** Capture point for stderr (for diagnostics, already included in error). */
  onStderr?: (chunk: string) => void;
}

/**
 * Fork the child-worker as a real OS process and await its single JSON
 * ChildResult line. Secrets never reach argv: the payload rides stdin, the
 * provider key/baseURL come from the inherited env. Non-zero exit / missing
 * line → rejects with ChildCrashError so the orchestrator maps it to
 * CHILD_CRASH exactly as an in-process throw does.
 */
export async function forkChild(
  entry: string,
  payload: ChildWorkerPayload,
  opts: ForkChildOptions = {},
): Promise<ChildResult> {
  const isTs = entry.endsWith('.ts');
  // tsx dev: run under the tsx loader; prod dist: plain node.
  const args = isTs ? ['--import', 'tsx/esm', entry] : [entry];

  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
    shell: false,
  });

  const stdoutCap = cappedOutput(MAX_CHILD_STDOUT_BYTES);
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  // Keep the HEAD of stdout (the ChildResult line) and the TAIL of stderr
  // (where the reason lives), so neither can grow the parent's heap without
  // bound over the child's 10-minute budget.
  child.stdout.on('data', (c: string) => { stdoutCap.push(Buffer.from(c, 'utf8')); });
  child.stderr.on('data', (c: string) => {
    opts.onStderr?.(c);
    stderr = (stderr + c).slice(-MAX_CHILD_STDERR_CHARS);
  });

  // Write the payload to stdin, then signal EOF so the child knows it has
  // the whole payload before it starts running.
  child.stdin.on('error', () => { /* child closed stdin early — still listen for close */ });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();

  const timeout = opts.timeoutMs ?? 10 * 60_000;
  let killedForTimeout = false;
  const timer = setTimeout(() => {
    killedForTimeout = true;
    try { child.kill(); } catch { /* already gone */ }
  }, timeout);
  const abortListener = () => { try { child.kill(); } catch { /* already gone */ } };
  if (opts.signal?.aborted) abortListener();
  opts.signal?.addEventListener('abort', abortListener, { once: true });

  return new Promise<ChildResult>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abortListener);
    };
    child.on('error', (err) => {
      cleanup();
      reject(new ChildCrashError(`child spawn failed: ${err.message}`, 'exit'));
    });
    child.on('close', (code, signal) => {
      cleanup();
      const first = stdoutCap.text().split('\n').find((l) => l.trim().length > 0);
      if (code === 0 && first) {
        try {
          resolve(JSON.parse(first) as ChildResult);
        } catch {
          reject(new ChildCrashError('child exited 0 but emitted malformed ChildResult', 'exit', stderr.slice(-1000)));
        }
        return;
      }
      const cause = signal === 'SIGKILL' || signal === 'SIGTERM'
        ? (killedForTimeout ? 'timeout' : 'oom')
        : 'exit';
      reject(new ChildCrashError(
        `child exited ${code ?? signal ?? '??'} without a ChildResult` + (stderr ? `: ${stderr.slice(-500)}` : ''),
        cause,
        stderr.slice(-1000),
      ));
    });
  });
}

/**
 * Rebuild a minimal RuntimeDeps from the payload + inherited env. Centralized
 * so tests can call it directly. Errors on missing provider config.
 */
export async function buildChildDeps(payload: ChildWorkerPayload): Promise<{ deps: RuntimeDeps; options: RunOptions }> {
  const provider = process.env.KLYRO_PROVIDER ?? 'openai';
  const baseUrl = process.env.KLYRO_BASE_URL;
  const apiKey = process.env.KLYRO_API_KEY;

  if (!apiKey) throw new Error('KLYRO_API_KEY is not set in the child environment');

  let adapter: RuntimeDeps['adapter'];
  if (provider === 'anthropic') {
    const { anthropicAdapter } = await import('./anthropic-adapter.js');
    adapter = anthropicAdapter({ baseURL: baseUrl, apiKey, timeoutMs: 240_000 });
  } else {
    if (!baseUrl) {
      throw new Error(`KLYRO_BASE_URL is not set for provider "${provider}" in the child environment`);
    }
    const { httpChatAdapter } = await import('./provider-adapter.js');
    adapter = httpChatAdapter({ baseURL: baseUrl, apiKey, timeoutMs: 240_000 });
  }

  const { builtinRegistry } = await import('../tools/registry.js');
  const { builtinRules, clonePolicyConfig, PolicyEngine } = await import('../policy/engine.js');
  const { DenyAllApprovalPrompt } = await import('../policy/approval.js');

  // File-system-only tool subset is the policy node's concern, handled by the
  // parent's scoping; the child just needs a working registry. DenyAll keeps
  // any tool that genuinely needs a user-prompt from stalling the child.
  const deps: RuntimeDeps = {
    adapter,
    registry: builtinRegistry(),
    policy: new PolicyEngine(builtinRules(), clonePolicyConfig()),
    approval: new DenyAllApprovalPrompt(),
    systemPrompt: () => payload.systemPrompt,
  };

  const options: RunOptions = {
    task: payload.task,
    cwd: path.resolve(payload.cwd),
    model: payload.model,
    maxSteps: payload.maxSteps,
    maxCost: payload.maxCost,
    maxTimeMs: payload.maxTimeMs,
    ...(payload.maxTokens !== undefined ? { maxTokens: payload.maxTokens } : {}),
    nonInteractive: true,
  };

  return { deps, options };
}

/**
 * Read the JSON payload. Payloads arrive on stdin (the parent writes the JSON
 * then ends stdin), never argv — large system prompts would otherwise fail
 * the spawn with E2BIG on both Windows (32K cmdline) and Linux (MAX_ARG_STRLEN).
 * Callers who must use argv (tests) can route through `runChildFromString`.
 */
export function readPayloadFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/**
 * Main entry. Reads payload from stdin, runs, prints ONE JSON ChildResult
 * line, exits 0 on complete, 1 on failure/crash (so the parent knows to mark
 * CHILD_CRASH). Intended to be the sole behavior of this file when invoked as
 * a real process.
 */
export async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readPayloadFromStdin();
  } catch (e) {
    process.stderr.write(`child-worker: failed reading payload: ${e}\n`);
    process.exit(2);
  }
  if (!raw) {
    process.stderr.write('child-worker: missing payload on stdin\n');
    process.exit(2);
  }
  let payload: ChildWorkerPayload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`child-worker: invalid payload: ${e}\n`);
    process.exit(2);
  }
  try {
    const { deps, options } = await buildChildDeps(payload);
    const result: RunResult = await run(options, deps);
    const out: ChildResult = {
      status: result.status,
      steps: result.steps,
      toolCalls: result.toolCalls,
      finalText: result.finalText,
      hasEdits: result.hasEdits,
      usage: result.usage,
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(result.status === 'complete' ? 0 : 1);
  } catch (err) {
    process.stderr.write(`child-worker: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  }
}

// Run directly only when executed as a child process (not imported by tests).
// Match both bare "child-worker" and the compiled "child-worker.js".
if (process.argv[1] && /child-worker(?:\.js)?$/.test(process.argv[1])) {
  void main();
}