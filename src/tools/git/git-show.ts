import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';
import { runGit } from './run-git.js';

const InputSchema = z.object({
  target: z.string().min(1).describe('Commit hash, branch name, or tag to show'),
});

export const gitShowTool = defineTool({
  name: 'git_show',
  description: 'Show the patch/content of a specific commit. Read-only.',
  inputSchema: InputSchema,
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => {
    return safe(async () => {
      const res = await runGit(['show', '--no-color', input.target], ctx.cwd);
      if (res.code !== 0) throw new Error(res.err || `git show failed`);
      return { content: res.out } as const;
    });
  },
});
