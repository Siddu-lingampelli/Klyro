/**
 * list_directory — list entries inside a directory.
 *
 * Refuses paths outside cwd. Skips node_modules and .git by default.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveAndFollowSymlinks } from '../../policy/path-guard.js';
import { TOOL_ERROR_CODES, safe } from '../normalize.js';

const DEFAULT_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage']);

const InputSchema = z.object({
  path: z.string().min(1).default('.').describe('Directory path relative to cwd. Defaults to cwd.'),
  maxDepth: z.number().int().min(1).max(5).optional().describe('How deep to recurse (default: 1 = top level only).'),
  skip: z.array(z.string()).optional().describe('Directory names to skip (default: node_modules, .git, etc.)'),
});

export interface ListEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
}

export interface ListDirOutput {
  path: string;
  entries: ListEntry[];
}

export const listDirTool = defineTool({
  name: 'list_directory',
  description: 'List entries inside a directory. Skips node_modules, .git, and common build dirs by default.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, input.path);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        return {
          ok: false,
          error: { code: TOOL_ERROR_CODES.INVALID_INPUT, message: `Not a directory: ${input.path}` },
        } as const;
      }
      const skip = new Set([...DEFAULT_SKIP, ...(input.skip ?? [])]);
      const maxDepth = input.maxDepth ?? 1;
      const entries: ListEntry[] = [];
      await walk(resolved, resolved, 0, maxDepth, skip, entries);
      return { path: input.path, entries } satisfies ListDirOutput;
    });
  },
});

async function walk(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  skip: Set<string>,
  out: ListEntry[],
): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (skip.has(name)) continue;
    if (name.startsWith('.') && name !== '.' && name !== '..') continue;
    const full = path.join(dir, name);
    let entry: ListEntry;
    try {
      const s = await fs.lstat(full);
      if (s.isSymbolicLink()) {
        entry = { name: path.relative(root, full), type: 'symlink', size: s.size };
      } else if (s.isDirectory()) {
        entry = { name: path.relative(root, full), type: 'directory', size: s.size };
      } else if (s.isFile()) {
        entry = { name: path.relative(root, full), type: 'file', size: s.size };
      } else {
        entry = { name: path.relative(root, full), type: 'other', size: s.size };
      }
    } catch {
      continue;
    }
    out.push(entry);
    if (entry.type === 'directory' && depth + 1 < maxDepth) {
      await walk(root, full, depth + 1, maxDepth, skip, out);
    }
  }
}

export type ListDirInput = z.infer<typeof InputSchema>;
