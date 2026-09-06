/**
 * read_file — read a file (or a slice of it) from the workspace.
 *
 * Inputs:
 *   - path: required, relative to cwd or absolute
 *   - startLine / endLine: optional 1-indexed inclusive window
 *   - maxBytes: optional cap (default 1 MiB)
 *
 * Behavior:
 *   - Refuses to read outside cwd
 *   - Refuses files > maxBytes unless line window keeps it small
 *   - On missing file returns NOT_FOUND, not throw
 *   - UTF-8 decode with a single TextDecoder
 */

import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveAndFollowSymlinks } from '../../policy/path-guard.js';
import { TOOL_ERROR_CODES, safe } from '../normalize.js';

const InputSchema = z.object({
  path: z.string().min(1).describe('Path relative to cwd, or absolute path inside cwd'),
  startLine: z.number().int().min(1).optional().describe('1-indexed inclusive start line'),
  endLine: z.number().int().min(1).optional().describe('1-indexed inclusive end line'),
  maxBytes: z.number().int().min(1).max(16 * 1024 * 1024).optional().describe('Max bytes to read (default 1 MiB)'),
});

export interface ReadFileOutput {
  path: string;
  totalLines: number;
  lines: string[];
  bytesRead: number;
  truncated: boolean;
}

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a file from the workspace. Returns the lines and total line count. Use startLine/endLine to read a slice without pulling the whole file.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, input.path);
      const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        return {
          ok: false,
          error: { code: TOOL_ERROR_CODES.INVALID_INPUT, message: `Not a regular file: ${input.path}` },
        } as const;
      }
      if (stat.size > maxBytes * 4 && !input.startLine && !input.endLine) {
        return {
          ok: false,
          error: {
            code: TOOL_ERROR_CODES.INVALID_INPUT,
            message: `File too large (${stat.size} bytes). Use startLine/endLine or raise maxBytes.`,
          },
        } as const;
      }
      const fh = await fs.open(resolved, 'r');
      try {
        const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const text = new TextDecoder('utf-8').decode(buf.subarray(0, bytesRead));
        const allLines = text.split(/\r\n|\r|\n/);
        const truncated = bytesRead < stat.size;
        const totalLines = truncated ? -1 : allLines.length;
        const lines =
          input.startLine !== undefined || input.endLine !== undefined
            ? allLines.slice((input.startLine ?? 1) - 1, input.endLine ?? allLines.length)
            : allLines;
        return {
          path: input.path,
          totalLines,
          lines,
          bytesRead,
          truncated,
        } satisfies ReadFileOutput;
      } finally {
        await fh.close().catch(() => undefined);
      }
    });
  },
});

export type ReadFileInput = z.infer<typeof InputSchema>;
