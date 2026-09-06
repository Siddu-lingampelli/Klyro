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
import { resolveAndFollowSymlinks } from '../../policy/path-guard.js';
import { safe } from '../normalize.js';

const InputSchema = z.object({
  path: z.string().min(1).describe('Path relative to cwd or absolute (must be inside cwd)'),
  content: z.string().describe('File content. Use empty string to truncate.'),
});

export interface WriteFileOutput {
  path: string;
  bytesWritten: number;
}

import { wasRead } from './read-history.js';

export const writeFileTool = defineTool<z.infer<typeof InputSchema>, WriteFileOutput>({
  name: 'write_file',
  description:
    'Write content to a file. Atomic: writes to a temp file then renames. Creates parent directories as needed.',
  inputSchema: InputSchema,
  permission: 'edit',
  isConcurrencySafe: false,
  renderCall: (input) => `write_file ${input.path} (${input.content.length} chars)`,
  renderResult: (output) => `${output.path} written ${output.bytesWritten} bytes`,
  execute: async (input, ctx) => {
    return safe(async () => {
      const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, input.path);
      const parent = path.dirname(resolved);
      await fs.mkdir(parent, { recursive: true });

      // 3.2: if file exists and was not read this session, warn but allow with diff
      let existing: string | null = null;
      let needsApproval = false;
      try {
        existing = await fs.readFile(resolved, 'utf-8');
        if (!wasRead(input.path) && existing.length > 200) {
          needsApproval = true;
        }
      } catch {
        // not exists — fine
      }

      const suffix = crypto.randomBytes(8).toString('hex');
      const tmp = path.join(parent, `.klyro-write-${process.pid}-${suffix}.tmp`);
      const data = Buffer.from(input.content, 'utf-8');
      // Truncate to 8k tokens ~32k chars for result
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
      // Compute diff for approval UI if needed
      let diff = '';
      if (existing !== null) {
        const before = existing.split('\n').slice(0, 20).join('\n');
        const after = input.content.split('\n').slice(0, 20).join('\n');
        if (before !== after) diff = `--- before\n${before.slice(0, 500)}\n+++ after\n${after.slice(0, 500)}`;
      }
      const result: WriteFileOutput & { diff?: string; needsApproval?: boolean } = {
        path: input.path,
        bytesWritten: data.byteLength,
      };
      if (diff) (result as unknown as Record<string, unknown>).diff = diff;
      if (needsApproval) (result as unknown as Record<string, unknown>).needsApproval = true;
      return result as WriteFileOutput;
    });
  },
});

export type WriteFileInput = z.infer<typeof InputSchema>;
