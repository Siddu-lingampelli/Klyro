/**
 * git_status — one or two commands that both read the repo:
 *   - `git status --porcelain --untracked-files=all`
 *   - `git log -n 10 --oneline` for recent history
 * The agent needs working-tree state AND recent history to plan edits.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';

const InputSchema = z.object({
  showLog: z.boolean().optional().describe('Also include the last 10 commit messages (default true)'),
});

export interface GitStatusOutput {
  porcelain: string;
  recentCommits?: string;
  branch?: string;
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

export const gitStatusTool = defineTool({
  name: 'git_status',
  description:
    'Show working-tree status (porcelain) and, optionally, the last 10 commit messages and current branch. Read-only.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const status = await run(['status', '--porcelain', '--untracked-files=all'], ctx.cwd);
      if (status.code !== 0) {
        // Not a git repo or git unavailable
        return {
          ok: false,
          error: { code: 'NOT_A_GIT_REPO', message: status.err.trim() || 'git status failed', details: { code: status.code } },
        } as const;
      }
      const result: GitStatusOutput = { porcelain: status.out || '(clean)' };
      const branch = await run(['branch', '--show-current'], ctx.cwd);
      if (branch.code === 0 && branch.out.trim()) result.branch = branch.out.trim();
      if (input.showLog !== false) {
        const log = await run(['log', '-n', '10', '--oneline', '--no-show-signature'], ctx.cwd);
        if (log.code === 0 && log.out.trim()) result.recentCommits = log.out.trim();
      }
      return result;
    });
  },
});

export type GitStatusInput = z.infer<typeof InputSchema>;