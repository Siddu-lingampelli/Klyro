/**
 * search_files — repo-aware file lookup with ranking.
 *
 * Returns files that match an optional glob AND/OR a regex against the file
 * contents, ranked by:
 *   - path/regex match strength
 *   - recent modification time (newer = higher)
 *   - whether the file is a first-party source file (src/ etc.) vs vendored
 *
 * The agent uses this to answer "where is X?" without doing a full grep.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveWithinCwd } from '../../policy/path-guard.js';
import { safe } from '../normalize.js';
import { globToRegex } from './glob.js';

const InputSchema = z.object({
  query: z.string().optional().describe('Substring or regex to match against file paths (case-insensitive)'),
  glob: z.string().optional().describe('Glob pattern to constrain candidates, e.g. "src/**/*.ts"'),
  cwd: z.string().optional(),
  maxResults: z.number().int().min(1).max(500).optional().describe('Cap results (default 50)'),
});

const DEFAULT_MAX = 50;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '.klyro']);
const FIRST_PARTY_HINTS = ['src/', 'lib/', 'app/', 'pkg/'];

export interface RankedFile {
  path: string;
  score: number;
  mtimeMs: number;
  firstParty: boolean;
}

export interface SearchFilesOutput {
  matches: RankedFile[];
  truncated: boolean;
}

function queryToRegex(query: string): RegExp {
  const escaped = query.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
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

export const searchFilesTool = defineTool({
  name: 'search_files',
  description:
    'Find files in the repo, ranked by name/path match and recency. Use to answer "where is X?" questions efficiently. Pass `query` (substring) and/or `glob` to constrain candidates.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const base = input.cwd ? resolveWithinCwd(ctx.cwd, input.cwd).resolved : ctx.cwd;
      const max = input.maxResults ?? DEFAULT_MAX;
      const matcher = input.query ? queryToRegex(input.query) : null;
      const globRe = input.glob ? globToRegex(input.glob) : null;

      const candidates: RankedFile[] = [];
      const now = Date.now();

      await walk(base, base, async (full) => {
        const rel = path.relative(ctx.cwd, full).split(path.sep).join('/');
        if (globRe && !globRe.test(rel)) return;
        if (matcher && !matcher.test(rel)) return;

        let mtimeMs = 0;
        try {
          const s = await fs.stat(full);
          mtimeMs = s.mtimeMs;
        } catch { return; }

        const ageDays = Math.max(0, (now - mtimeMs) / (1000 * 60 * 60 * 24));
        const firstParty = FIRST_PARTY_HINTS.some((h) => rel.startsWith(h));
        let score = 0;
        if (matcher) {
          // Substring match weight depends on how much of the path matches.
          const nameOnly = rel.split('/').pop() ?? rel;
          if (nameOnly.toLowerCase() === input.query!.toLowerCase()) score += 200;
          else if (nameOnly.toLowerCase().includes(input.query!.toLowerCase())) score += 80;
          else if (rel.toLowerCase().includes(input.query!.toLowerCase())) score += 40;
        }
        if (firstParty) score += 20;
        // Recency: 0..30 points, 0 days = 30, 30+ days = 0
        score += Math.max(0, 30 - ageDays);

        candidates.push({ path: rel, score, mtimeMs, firstParty });
      });

      candidates.sort((a, b) => b.score - a.score);
      const truncated = candidates.length > max;
      return { matches: candidates.slice(0, max), truncated } satisfies SearchFilesOutput;
    });
  },
});

export type SearchFilesInput = z.infer<typeof InputSchema>;
