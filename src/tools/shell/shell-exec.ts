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

import { spawn, spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
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

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000; // head+tail cap per 3.3
const FULL_OUTPUT_DIR = (() => {
  try {
    const home = os.homedir() || process.cwd();
    return path.join(home, '.klyro', 'tool-output');
  } catch { return path.join(process.cwd(), '.klyro', 'tool-output'); }
})();

// Persistent cwd across calls (3.3)
let persistentCwd: string | null = null;

// Filtered env — only safe vars, secrets stripped
const ALLOWED_ENV_PREFIXES = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'NODE_', 'NPM_', 'PNPM_', 'YARN_'];
function filteredEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('KLYRO_') && k.includes('API_KEY')) continue;
    if (k.includes('SECRET') || k.includes('TOKEN') || k === 'ANTHROPIC_API_KEY' || k === 'OPENAI_API_KEY') continue;
    if (ALLOWED_ENV_PREFIXES.some((p) => k.startsWith(p)) || k === 'PWD' || k === 'TMPDIR' || k === 'TEMP') {
      out[k] = v;
    }
  }
  // Always allow basic
  out.PATH = process.env.PATH;
  if (extra) Object.assign(out, extra);
  return out;
}

// Interactive command detection (3.3)
const INTERACTIVE_PATTERNS = [/^\s*vim\b/, /^\s*nano\b/, /^\s*htop\b/, /^\s*less\b/, /^\s*more\b/, /^\s*ssh\b/, /^\s*tmux\b/];

// Hard-coded dangerous patterns. These are non-overridable, configurable via --yolo only.
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-rf?\s+\//, reason: 'recursive delete at filesystem root' },
  { pattern: /rm\s+-rf?\s+\/\/+/, reason: 'recursive delete at filesystem root (//)' },
  { pattern: /rm\s+-rf?\s+\/\*/, reason: 'recursive delete at filesystem root (/*)' },
  { pattern: /rm\s+-rf?\s+\.\s*($|[;&|])/, reason: 'recursive delete current directory' },
  { pattern: /rm\s+-rf?\s+\*\s*($|[;&|])/, reason: 'recursive delete all files via *' },
  { pattern: /rm\s+-rf?\s+\.\/\*\s*($|[;&|])/, reason: 'recursive delete all files' },
  { pattern: /rm\s+-rf?\s+~(\/|$)/, reason: 'recursive delete home directory via ~' },
  { pattern: /rm\s+-rf?\s+\$HOME\b/, reason: 'recursive delete home via $HOME' },
  { pattern: /rm\s+-rf?\s+\$PWD\b/, reason: 'recursive delete via $PWD' },
  { pattern: /del\s+\/s\s+\/q\s+[a-z]:\\/i, reason: 'recursive delete on Windows drive root' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { pattern: /bomb\(\)\s*\{\s*bomb\|bomb/, reason: 'fork bomb variant' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'overwrite raw block device' },
  { pattern: /mkfs(\.|\s)/, reason: 'format filesystem' },
  { pattern: /dd\s+.*of=\/dev\//, reason: 'dd write to device' },
  { pattern: /chmod\s+-R\s+777\s+\//, reason: 'chmod 777 on root' },
  { pattern: /curl.*\|\s*(sh|bash|zsh|python|python3|perl|ruby|php)/i, reason: 'curl|sh to unknown host' },
  { pattern: /wget.*\|\s*(sh|bash|python|perl|ruby)/i, reason: 'wget|sh pipe' },
  { pattern: /rm\s+-rf\s+--no-preserve-root\s+\//, reason: 'recursive delete --no-preserve-root' },
  // Shell metacharacter escapes — block command substitution and chaining of dangerous cmds
  { pattern: /\$\(/, reason: 'command substitution $()' },
  { pattern: /`[^`]*`/, reason: 'command substitution via backticks' },
  { pattern: /\|\s*bash\b|\|\s*sh\b/, reason: 'pipe to shell' },
  { pattern: /;\s*rm\s+-rf/, reason: 'chained rm -rf' },
  { pattern: /&&\s*rm\s+-rf/, reason: 'chained rm -rf' },
  { pattern: /\|\|\s*rm\s+-rf/, reason: 'chained rm -rf' },
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

export const shellExecTool = defineTool<z.infer<typeof InputSchema>, ShellOutput>({
  name: 'shell_exec',
  description:
    'Execute a shell command. Default timeout 120s (max 600s). Output head+tail 30k chars, full to ~/.klyro/tool-output/<id>.txt. Persistent cwd, filtered env, tree-kill on timeout.',
  inputSchema: InputSchema,
  permission: 'execute',
  isConcurrencySafe: false,
  renderCall: (input) => `$ ${input.command.slice(0, 80)}`,
  renderResult: (output) => `exit ${output.exitCode} (${output.durationMs}ms${output.timedOut ? ' timedOut' : ''})`,
  execute: async (input, ctx) => {
    return safe(async () => {
      // Interactive detection
      for (const pat of INTERACTIVE_PATTERNS) {
        if (pat.test(input.command)) {
          throw Object.assign(new Error(`Interactive command blocked: ${input.command.split(' ')[0]} — hint: use non-interactive mode or run in background`), { code: TOOL_ERROR_CODES.COMMAND_DENIED });
        }
      }
      for (const { pattern, reason } of DANGEROUS_PATTERNS) {
        if (pattern.test(input.command)) {
          throw Object.assign(new Error(`Command blocked: ${reason}`), { code: TOOL_ERROR_CODES.COMMAND_DENIED });
        }
      }
      // Persistent cwd
      let cwd = persistentCwd ?? ctx.cwd;
      if (input.cwd) {
        cwd = resolveWithinCwd(ctx.cwd, input.cwd).resolved;
        persistentCwd = cwd;
      } else if (input.command.trim().startsWith('cd ')) {
        const m = /^\s*cd\s+(.+?)\s*(?:&&|;|$)/.exec(input.command);
        if (m?.[1]) {
          try {
            const target = m[1].replace(/^["']|["']$/g, '');
            const resolved = resolveWithinCwd(cwd, target).resolved;
            persistentCwd = resolved;
          } catch { /* ignore */ }
        }
      }
      const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const env = filteredEnv(input.env);
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
      const fullStdout: Buffer[] = [];
      const fullStderr: Buffer[] = [];
      let totalOut = 0;
      let totalErr = 0;
      let truncated = false;

      child.stdout?.on('data', (chunk: Buffer) => {
        fullStdout.push(chunk);
        if (totalOut + chunk.length > MAX_OUTPUT_CHARS) {
          truncated = true;
          // Keep head+tail: drop middle, keep first half and last half later
          if (stdoutChunks.length < 10) stdoutChunks.push(chunk);
          return;
        }
        stdoutChunks.push(chunk);
        totalOut += chunk.length;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        fullStderr.push(chunk);
        if (totalErr + chunk.length > MAX_OUTPUT_CHARS) {
          truncated = true;
          if (stderrChunks.length < 10) stderrChunks.push(chunk);
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
              spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
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

      const fullOutBuf = Buffer.concat(fullStdout);
      const fullErrBuf = Buffer.concat(fullStderr);
      // Write full output to ~/.klyro/tool-output/<id>.txt for 3.3
      const outId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        await fs.mkdir(FULL_OUTPUT_DIR, { recursive: true });
        const fullPath = path.join(FULL_OUTPUT_DIR, `${outId}.txt`);
        const fullContent = `STDOUT:\n${fullOutBuf.toString('utf-8')}\n\nSTDERR:\n${fullErrBuf.toString('utf-8')}\n`;
        await fs.writeFile(fullPath, fullContent, 'utf-8');
      } catch { /* ignore */ }

      // Head+tail truncation: keep first 15k and last 15k chars
      let stdout: string;
      let stderr: string;
      if (truncated) {
        const fullOutStr = fullOutBuf.toString('utf-8');
        const fullErrStr = fullErrBuf.toString('utf-8');
        const headTail = (s: string): string => {
          if (s.length <= MAX_OUTPUT_CHARS) return s;
          const head = s.slice(0, 15000);
          const tail = s.slice(-15000);
          return head + `\n... [truncated ${s.length - 30000} chars, full at ~/.klyro/tool-output/${outId}.txt]\n` + tail;
        };
        stdout = headTail(fullOutStr);
        stderr = headTail(fullErrStr);
      } else {
        stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        stderr = Buffer.concat(stderrChunks).toString('utf-8');
      }

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
