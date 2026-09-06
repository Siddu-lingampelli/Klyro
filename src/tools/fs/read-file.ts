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
import { markRead } from './read-history.js';
import { checkUnchanged, storeResult } from '../../context/lifecycle.js';

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

export const readFileTool = defineTool<z.infer<typeof InputSchema>, ReadFileOutput>({
  name: 'read_file',
  description:
    'Read a file from the workspace. Returns the lines and total line count. Use startLine/endLine to read a slice without pulling the whole file.',
  inputSchema: InputSchema,
  permission: 'read',
  isConcurrencySafe: true,
  renderCall: (input) => `read_file ${input.path}${input.startLine ? `:${input.startLine}-${input.endLine ?? ''}` : ''}`,
  renderResult: (output) => `${output.path} (${output.totalLines} lines, ${output.bytesRead} bytes${output.truncated ? ' truncated' : ''})`,
  execute: async (input, ctx) => {
    return safe(async () => {
      const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, input.path);
      const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        throw Object.assign(new Error(`Not a regular file: ${input.path}`), { code: TOOL_ERROR_CODES.INVALID_INPUT });
      }
      // >10MB refusal per 3.2 spec
      if (stat.size > 10 * 1024 * 1024) {
        throw Object.assign(new Error(`File too large (${stat.size} bytes) — >10MB refusal. Use startLine/endLine to read a slice.`), { code: TOOL_ERROR_CODES.INVALID_INPUT });
      }
      if (stat.size > maxBytes * 4 && !input.startLine && !input.endLine) {
        throw Object.assign(new Error(`File too large (${stat.size} bytes). Use startLine/endLine or raise maxBytes.`), { code: TOOL_ERROR_CODES.INVALID_INPUT });
      }
      const fh = await fs.open(resolved, 'r');
      try {
        const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        // Binary detection: null byte or high binary ratio
        if (buf.subarray(0, bytesRead).includes(0)) {
          throw Object.assign(new Error(`Binary file: ${input.path} (contains null byte). Use image handling or cat -n for text.`), { code: TOOL_ERROR_CODES.INVALID_INPUT });
        }
        const text = new TextDecoder('utf-8').decode(buf.subarray(0, bytesRead));
        const allLines = text.split(/\r\n|\r|\n/);
        const truncated = bytesRead < stat.size;
        const totalLines = truncated ? -1 : allLines.length;
        // 2000-line window per spec (cap)
        const windowSize = 2000;
        let lines: string[];
        if (input.startLine !== undefined || input.endLine !== undefined) {
          const s = (input.startLine ?? 1) - 1;
          const e = input.endLine ?? Math.min(allLines.length, s + windowSize);
          lines = allLines.slice(s, Math.min(e, s + windowSize));
        } else {
          lines = allLines.slice(0, Math.min(allLines.length, windowSize));
        }
        // Truncation to 8k tokens equivalent ~32k chars
        const maxChars = 32_000;
        let outLines = lines;
        let truncatedTokens = false;
        const asText = lines.join('\n');
        if (asText.length > maxChars) {
          outLines = asText.slice(0, maxChars).split('\n');
          truncatedTokens = true;
        }
        // cat -n style: prefix line numbers for model readability (when returning)
        // We keep raw lines but add hint in truncated case
        const result: ReadFileOutput = {
          path: input.path,
          totalLines,
          lines: outLines,
          bytesRead,
          truncated: truncated || truncatedTokens,
        };
        if (truncatedTokens) {
          (result as unknown as Record<string, unknown>).hint = 'Truncated to 8k tokens — use startLine/endLine to get more';
        }
        markRead(input.path);
        // 8.2 lifecycle: store large results, duplicate detection <50 tokens
        const asStr = outLines.join('\n');
        if (asStr.length > 2000) storeResult(asStr);
        const unchanged = checkUnchanged(input.path, asStr, 0);
        if (unchanged.unchanged) {
          (result as unknown as Record<string, unknown>).note = `unchanged since turn ${unchanged.sinceTurn}`;
        }
        return result satisfies ReadFileOutput;
      } finally {
        await fh.close().catch(() => undefined);
      }
    });
  },
});

export type ReadFileInput = z.infer<typeof InputSchema>;
