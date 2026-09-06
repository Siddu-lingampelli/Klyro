/**
 * recent_files — list files modified recently, newest first.
 *
 * Answers "what changed lately?" without forcing the model to walk the tree.
 * Skips the same dirs as glob/grep.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveWithinCwd } from '../../policy/path-guard.js';
import { safe } from '../normalize.js';

const InputSchema = z.object({
  cwd: z.string().optional(),
  sinceHours: z.number().int().min(0).max(24 * 365).optional().describe('Only files modified within this many hours (default 24)'),
  maxResults: z.number().int().min(1).max(500).optional().describe('Cap results (default 50)'),
  glob: z.string().optional().describe('Glob pattern to constrain (e.g. "src/**")'),
});

const DEFAULT_MAX = 50;
const DEFAULT_SINCE_HOURS = 24;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '.klyro']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.ttf', '.otf', '.exe', '.dll', '.bin', '.zip', '.tar', '.gz', '.map']);

export interface RecentFile {
  path: string;
  mtimeMs: number;
  ageHours: number;
}

export interface RecentFilesOutput {
  files: RecentFile[];
  truncated: boolean;
}

async function globToRegex(pattern: string): Promise<RegExp> {
  let p = pattern;
  const anchor = p.startsWith('**/') ? '^(?:.*/)?' : p === '**' ? '^.*' : '^';
  if (p.startsWith('**/')) p = p.slice(3);
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLESTAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/::DOUBLESTAR::/g, '.*');
  return new RegExp(`${anchor}${escaped}$`);
}

async function walk(root: string, dir: string, onFile: (full: string) => Promise<void>): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let isDir = false;
    try {
      const s = await fs.lstat(full);
      if (s.isSymbolicLink()) continue;
      isDir = s.isDirectory();
    } catch { continue; }
    if (isDir) await walk(root, full, onFile);
    else await onFile(full);
  }
}

export const recentFilesTool = defineTool({
  name: 'recent_files',
  description:
    'List files in the repo modified within the last N hours, newest first. Use to answer "what changed recently?" efficiently.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const base = input.cwd ? resolveWithinCwd(ctx.cwd, input.cwd).resolved : ctx.cwd;
      const max = input.maxResults ?? DEFAULT_MAX;
      const sinceHours = input.sinceHours ?? DEFAULT_SINCE_HOURS;
      const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
      const globRe = input.glob ? await globToRegex(input.glob) : null;

      const results: RecentFile[] = [];

      await walk(base, base, async (full) => {
        const ext = path.extname(full).toLowerCase();
        if (SKIP_EXT.has(ext)) return;
        const rel = path.relative(ctx.cwd, full).split(path.sep).join('/');
        if (globRe && !globRe.test(rel)) return;
        let mtimeMs = 0;
        try { mtimeMs = (await fs.stat(full)).mtimeMs; } catch { return; }
        if (mtimeMs < sinceMs) return;
        const ageHours = (Date.now() - mtimeMs) / (1000 * 60 * 60);
        results.push({ path: rel, mtimeMs, ageHours });
      });

      results.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const truncated = results.length > max;
      return { files: results.slice(0, max), truncated } satisfies RecentFilesOutput;
    });
  },
});

export type RecentFilesInput = z.infer<typeof InputSchema>;
