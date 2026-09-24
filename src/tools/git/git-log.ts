import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';
import { runGit } from './run-git.js';

const InputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe('Number of commits'),
  path: z.string().optional().describe('Filter by path'),
});

export const gitLogTool = defineTool({
  name: 'git_log',
  description: 'Show git log (read-only)',
  inputSchema: InputSchema,
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => {
    return safe(async () => {
      const args = ['log', '--oneline', `-${input.limit ?? 20}`];
      if (input.path) args.push('--', input.path);
      const res = await runGit(args, ctx.cwd);
      if (res.code !== 0) throw new Error(res.err || `git log failed`);
      return { log: res.out } as const;
    });
  },
});
