/**
 * shell_exec — run a shell command.
 *
 * Safety:
 *   - Hard-coded dangerous patterns are always blocked (fork bomb, rm -rf /, etc.)
 *   - Per-call timeout (default 30s)
 *   - stdout/stderr are truncated at 128 KiB so a runaway command can't OOM us
 *   - Non-zero exit is returned as a successful tool call (with exitCode in
 *     the output). The agent reads exitCode to decide what to do next.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveWithinCwd } from '../../policy/path-guard.js';
import { safe, TOOL_ERROR_CODES } from '../normalize.js';

const InputSchema = z.object({
  command: z.string().min(1).describe('Shell command to execute (interpreted by /bin/sh -c on Unix, cmd.exe /c on Windows)'),
  cwd: z.string().optional().describe('Working directory; defaults to the workspace cwd'),
  timeoutMs: z.number().int().min(1).max(600_000).optional().describe('Timeout in milliseconds (default 30000, max 600000)'),
  env: z.record(z.string(), z.string()).optional().describe('Extra env vars merged onto process.env'),
});

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

// Hard-coded dangerous patterns. These are non-overridable in MVP.
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-rf?\s+\//, reason: 'recursive delete at filesystem root' },
  { pattern: /del\s+\/s\s+\/q\s+[a-z]:\\/i, reason: 'recursive delete on Windows drive root' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'overwrite raw block device' },
  { pattern: /mkfs(\.|\s)/, reason: 'format filesystem' },
  { pattern: /dd\s+.*of=\/dev\//, reason: 'dd write to device' },
];

export interface ShellOutput {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export const shellExecTool = defineTool({
  name: 'shell_exec',
  description:
    'Execute a shell command. Default timeout 30s. Output is truncated at 128 KiB. Returns exitCode (or null if killed by signal). Non-zero exit code is NOT a tool error — the tool succeeds and the agent sees the exit code in the output.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      for (const { pattern, reason } of DANGEROUS_PATTERNS) {
        if (pattern.test(input.command)) {
          return {
            ok: false,
            error: { code: TOOL_ERROR_CODES.COMMAND_DENIED, message: `Command blocked: ${reason}` },
          } as const;
        }
      }
      let cwd = ctx.cwd;
      if (input.cwd) {
        cwd = resolveWithinCwd(ctx.cwd, input.cwd).resolved;
      }
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const env = { ...process.env, ...(input.env ?? {}) };
      const start = Date.now();

      const child = spawn(input.command, {
        cwd,
        env: env as NodeJS.ProcessEnv,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        signal: ctx.signal,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalOut = 0;
      let totalErr = 0;
      let truncated = false;

      child.stdout?.on('data', (chunk: Buffer) => {
        if (totalOut + chunk.length > MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        stdoutChunks.push(chunk);
        totalOut += chunk.length;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (totalErr + chunk.length > MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        stderrChunks.push(chunk);
        totalErr += chunk.length;
      });

      // Resolve on the FIRST of: process exit, or the timeout timer. Awaiting
      // `close` alone would deadlock on Windows, where a grandchild (e.g. ping)
      // inherits the stdio pipes and keeps them open after the shell wrapper
      // exits. We listen to `exit` for the code and let the timer force-kill.
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve) => {
        let done = false;
        const finish = (o: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(o);
        };
        const timer = setTimeout(() => {
          // On Windows, `child.kill()` only kills the shell wrapper, leaving
          // grandchildren (e.g. ping) holding the stdio pipes open. Use
          // `taskkill /F /T` to nuke the entire process tree; on POSIX,
          // -SIGKILL signals the group so children go too.
          if (process.platform === 'win32') {
            try {
              require('node:child_process').spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
            } catch { /* already gone */ }
          } else {
            try { child.kill('SIGKILL'); } catch { /* already dead */ }
          }
          finish({ code: null, signal: 'SIGKILL', timedOut: true });
        }, timeoutMs);
        child.on('exit', (code, signal) => finish({ code, signal, timedOut: false }));
        child.on('error', () => finish({ code: null, signal: null, timedOut: false }));
      });
      const { code: exitCode, signal, timedOut } = outcome;

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      return {
        command: input.command,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
        truncated,
      } satisfies ShellOutput;
    });
  },
});

export type ShellInput = z.infer<typeof InputSchema>;
