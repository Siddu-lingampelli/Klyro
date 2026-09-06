/**
 * git_diff — show unstaged (`git diff`) or staged (`git diff --cached`)
 * changes plus a compact per-file stat. Read-only.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe, TOOL_ERROR_CODES } from '../normalize.js';

const InputSchema = z.object({
  staged: z.boolean().optional().describe('Show staged changes instead of unstaged (default false)'),
  path: z.string().optional().describe('Limit to a specific path'),
});

export interface GitDiffOutput {
  diff: string;
  stat: string;
  patchedFiles: string[];
}

function run(args: string[], cwd: string, timeoutMs = 15_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out: Buffer.concat(out).toString('utf-8'), err: Buffer.concat(err).toString('utf-8') });
    });
  });
}

export const gitDiffTool = defineTool({
  name: 'git_diff',
  description:
    'Show the unified diff of working-tree changes (unstaged by default) or staged changes. Read-only. Returns the diff text, a per-file stat, and the list of changed file paths.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const base = input.staged ? ['diff', '--cached'] : ['diff'];
      const args = [...base, '--no-color'];
      if (input.path) args.push('--', input.path);
      const diff = await run(args, ctx.cwd);
      if (diff.code !== 0) {
        return {
          ok: false,
          error: { code: TOOL_ERROR_CODES.IO_ERROR, message: `git diff failed: ${diff.err.trim() || diff.out.trim()}` },
        } as const;
      }
      const statArgs = [...base, '--stat', '--no-color'];
      if (input.path) statArgs.push('--', input.path);
      const stat = await run(statArgs, ctx.cwd);

      // Parse changed file paths from `diff --git a/... b/...` lines.
      const patchedFiles: string[] = [];
      const newline = /\r?\n/;
      const re = /^diff --git a\/(.*?) b\/(.*\S)\s*$/;
      for (const line of diff.out.split(newline)) {
        const m = re.exec(line);
        const target = m?.[2];
        if (target) patchedFiles.push(target.replace(/\/$/, ''));
      }

      return {
        diff: diff.out.trim(),
        stat: stat.out.trim(),
        patchedFiles,
      } satisfies GitDiffOutput;
    });
  },
});

export type GitDiffInput = z.infer<typeof InputSchema>;