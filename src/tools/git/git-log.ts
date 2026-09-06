import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';
import { spawn } from 'node:child_process';

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
      const out = await runGit(args, ctx.cwd);
      return { log: out } as const;
    });
  },
});

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err || `git ${args[0]} failed`));
    });
  });
}
