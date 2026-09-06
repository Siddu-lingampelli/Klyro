/**
 * run_verify — the verification engine's tool. Runs a user-supplied command
 * (e.g. `npm test`, `tsc --noEmit`) and returns the structured result.
 *
 * Differentiated from `shell_exec` so that downstream code (the verification
 * engine) can pick a more permissive policy for the verify command: it can
 * run `npm test`, which shell_exec might want approval for in some configs.
 */

import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe, TOOL_ERROR_CODES } from '../normalize.js';

const InputSchema = z.object({
  command: z.string().min(1).describe('Verification command, e.g. "npm test" or "tsc --noEmit"'),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional().describe('Default 300000 (5 min)'),
});

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface VerifyOutput {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  ok: boolean;
  truncated: boolean;
}

export const runVerifyTool = defineTool({
  name: 'run_verify',
  description:
    'Run a verification command (e.g. tests, typecheck) and return exit code, stdout, stderr. Default timeout 5 minutes. Output is truncated at 256 KiB. Returns ok=true iff exit code is 0.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const cwd = input.cwd ?? ctx.cwd;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const env = process.env;
      const start = Date.now();

      const child = spawn(input.command, {
        cwd,
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        signal: ctx.signal,
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let totalOut = 0;
      let totalErr = 0;
      let truncated = false;

      child.stdout?.on('data', (b: Buffer) => {
        if (totalOut + b.length > MAX_OUTPUT_BYTES) { truncated = true; return; }
        stdout.push(b); totalOut += b.length;
      });
      child.stderr?.on('data', (b: Buffer) => {
        if (totalErr + b.length > MAX_OUTPUT_BYTES) { truncated = true; return; }
        stderr.push(b); totalErr += b.length;
      });

      // Resolve on the FIRST of exit/timer/error — see shell-exec.ts for why
      // awaiting `close` alone deadlocks on Windows with a pipe-holding grandchild.
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve) => {
        let done = false;
        const finish = (o: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(o);
        };
        const timer = setTimeout(() => {
          // Windows grandchild cleanup — see shell-exec.ts for why.
          if (process.platform === 'win32') {
            try {
              spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
            } catch { /* already gone */ }
          } else {
            try { child.kill('SIGKILL'); } catch { /* noop */ }
          }
          finish({ code: null, signal: 'SIGKILL', timedOut: true });
        }, timeoutMs);
        child.on('exit', (code, signal) => finish({ code, signal, timedOut: false }));
        child.on('error', () => finish({ code: null, signal: null, timedOut: false }));
      });
      const { code: exitCode, signal, timedOut } = outcome;

      const ok = exitCode === 0 && !timedOut;
      if (!ok) {
        // Tool still succeeds — non-zero exit is a verify failure, not a tool
        // failure. The verification engine consumes this output. We *do*
        // escalate timeout to TIMEOUT, since that's a hard error mode.
        if (timedOut) {
          return {
            ok: false,
            error: { code: TOOL_ERROR_CODES.TIMEOUT, message: `verify command timed out after ${timeoutMs}ms`, details: { command: input.command } },
          } as const;
        }
      }

      return {
        command: input.command,
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        durationMs: Date.now() - start,
        timedOut,
        ok,
        truncated,
      } satisfies VerifyOutput;
    });
  },
});

export type RunVerifyInput = z.infer<typeof InputSchema>;