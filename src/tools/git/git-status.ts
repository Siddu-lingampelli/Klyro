/**
 * git_status — one or two commands that both read the repo:
 *   - `git status --porcelain --untracked-files=all`
 *   - `git log -n 10 --oneline` for recent history
 * The agent needs working-tree state AND recent history to plan edits.
 */

import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';
import { runGit } from './run-git.js';

const InputSchema = z.object({
  showLog: z.boolean().optional().describe('Also include the last 10 commit messages (default true)'),
});

export interface GitStatusOutput {
  porcelain: string;
  recentCommits?: string;
  branch?: string;
}

export const gitStatusTool = defineTool({
  name: 'git_status',
  description:
    'Show working-tree status (porcelain) and, optionally, the last 10 commit messages and current branch. Read-only.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const status = await runGit(['status', '--porcelain', '--untracked-files=all'], ctx.cwd);
      if (status.code !== 0) {
        // Not a git repo or git unavailable
        return {
          ok: false,
          error: { code: 'NOT_A_GIT_REPO', message: status.err.trim() || 'git status failed', details: { code: status.code } },
        } as const;
      }
      const result: GitStatusOutput = { porcelain: status.out || '(clean)' };
      const branch = await runGit(['branch', '--show-current'], ctx.cwd);
      if (branch.code === 0 && branch.out.trim()) result.branch = branch.out.trim();
      if (input.showLog !== false) {
        const log = await runGit(['log', '-n', '10', '--oneline', '--no-show-signature'], ctx.cwd);
        if (log.code === 0 && log.out.trim()) result.recentCommits = log.out.trim();
      }
      return result;
    });
  },
});

export type GitStatusInput = z.infer<typeof InputSchema>;