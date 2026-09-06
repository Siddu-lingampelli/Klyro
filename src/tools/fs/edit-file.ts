/**
 * edit_file — find-and-replace in an existing file.
 * Strict: ambiguous matches fail unless replaceAll=true. Missing match fails.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveAndFollowSymlinks } from '../../policy/path-guard.js';
import { safe } from '../normalize.js';

const InputSchema = z.object({
  path: z.string().min(1),
  find: z.string().min(1).describe('Exact substring to match. Not a regex.'),
  replace: z.string(),
  replaceAll: z.boolean().optional().describe('If true, replace every occurrence.'),
});

export interface EditFileOutput {
  path: string;
  replacements: number;
  diff: string;
}

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Replace a substring in a file. Strict: if `find` is missing or ambiguous, the edit fails (unless replaceAll=true).',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, input.path);
      const original = await fs.readFile(resolved, 'utf-8');
      const count = countOccurrences(original, input.find);
      if (count === 0) {
        return {
          ok: false,
          error: { code: 'MATCH_NOT_FOUND', message: `find substring not present in ${input.path}` },
        } as const;
      }
      const replaceAll = input.replaceAll === true;
      if (!replaceAll && count > 1) {
        return {
          ok: false,
          error: {
            code: 'MATCH_AMBIGUOUS',
            message: `find substring occurs ${count} times in ${input.path}. Supply more context or pass replaceAll=true.`,
          },
        } as const;
      }
      const next = replaceAll ? original.split(input.find).join(input.replace) : original.replace(input.find, input.replace);
      const tmp = `${resolved}.klyro-edit-${process.pid}-${Date.now()}.tmp`;
      await fs.writeFile(tmp, next, 'utf-8');
      try {
        await fs.rename(tmp, resolved);
      } catch (err) {
        await fs.unlink(tmp).catch(() => undefined);
        throw err;
      }
      return {
        path: input.path,
        replacements: replaceAll ? count : 1,
        diff: simpleDiff(original, input.find, input.replace, replaceAll ? count : 1),
      } satisfies EditFileOutput;
    });
  },
});

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

function simpleDiff(original: string, find: string, replace: string, count: number): string {
  const firstIdx = original.indexOf(find);
  if (firstIdx < 0) return '';
  const start = Math.max(0, original.lastIndexOf('\n', firstIdx) + 1);
  const endLf = original.indexOf('\n', firstIdx + find.length);
  const end = endLf < 0 ? original.length : endLf;
  const beforeSnippet = original.slice(start, end);
  const afterSnippet = beforeSnippet.split(find).join(replace);
  const more = count > 1 ? `\n... and ${count - 1} more replacement(s)` : '';
  return `--- before\n${beforeSnippet}\n+++ after\n${afterSnippet}${more}`;
}

export type EditFileInput = z.infer<typeof InputSchema>;
