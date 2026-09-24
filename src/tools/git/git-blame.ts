import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';
import { runGit } from './run-git.js';

const InputSchema = z.object({
  path: z.string().min(1).describe('File path to blame'),
});

export const gitBlameTool = defineTool({
  name: 'git_blame',
  description: 'Show git blame for a file, line by line. Read-only.',
  inputSchema: InputSchema,
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => {
    return safe(async () => {
      const res = await runGit(['blame', '--', input.path], ctx.cwd);
      if (res.code !== 0) throw new Error(res.err || `git blame failed`);
      return { blame: res.out } as const;
    });
  },
});
