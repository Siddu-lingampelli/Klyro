/**
 * write_file — write content to a file in the workspace.
 *
 * Atomic write via tmp + rename. Refuses paths outside cwd. Creates parent
 * directories if needed.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveWithinCwd } from '../../policy/path-guard.js';
import { safe } from '../normalize.js';

const InputSchema = z.object({
  path: z.string().min(1).describe('Path relative to cwd or absolute (must be inside cwd)'),
  content: z.string().describe('File content. Use empty string to truncate.'),
});

export interface WriteFileOutput {
  path: string;
  bytesWritten: number;
}

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Write content to a file. Atomic: writes to a temp file then renames. Creates parent directories as needed.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const { resolved } = resolveWithinCwd(ctx.cwd, input.path);
      const parent = path.dirname(resolved);
      await fs.mkdir(parent, { recursive: true });

      const suffix = crypto.randomBytes(8).toString('hex');
      const tmp = path.join(parent, `.klyro-write-${process.pid}-${suffix}.tmp`);
      const data = Buffer.from(input.content, 'utf-8');
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close().catch(() => undefined);
      }
      try {
        await fs.rename(tmp, resolved);
      } catch (err) {
        await fs.unlink(tmp).catch(() => undefined);
        throw err;
      }
      return { path: input.path, bytesWritten: data.byteLength } satisfies WriteFileOutput;
    });
  },
});

export type WriteFileInput = z.infer<typeof InputSchema>;
