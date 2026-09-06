/**
 * glob — find files matching a pattern. Bounded output.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveWithinCwd } from '../../policy/path-guard.js';
import { safe } from '../normalize.js';

const InputSchema = z.object({
  pattern: z.string().min(1).describe('Glob pattern, e.g. "**/*.ts" or "src/**/*.json"'),
  cwd: z.string().optional().describe('Base directory; defaults to workspace cwd'),
  maxResults: z.number().int().min(1).max(10_000).optional().describe('Cap results (default 1000)'),
});

const DEFAULT_MAX = 1000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '.klyro']);

export interface GlobOutput {
  pattern: string;
  matches: string[];
  truncated: boolean;
}

export const globTool = defineTool({
  name: 'glob',
  description:
    'Find files matching a glob pattern. Standard glob syntax (** for recursion, * for any segment). Skips common build dirs.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const base = input.cwd ? resolveWithinCwd(ctx.cwd, input.cwd).resolved : ctx.cwd;
      const matcher = globToRegex(input.pattern);
      const max = input.maxResults ?? DEFAULT_MAX;
      const matches: string[] = [];
      let truncated = false;
      await walk(base, base, matcher, max + 1, matches, () => (truncated = true));
      // Normalize to relative, forward-slash paths from ctx.cwd (so
      // tool inputs/outputs are stable across Windows and POSIX).
      const rel = matches.slice(0, max).map((m) =>
        path.relative(ctx.cwd, m).split(path.sep).join('/'),
      );
      return { pattern: input.pattern, matches: rel, truncated } satisfies GlobOutput;
    });
  },
});

export function globToRegex(pattern: string): RegExp {
  // Convert glob to regex. Special-cases: a leading `**/` should match
  // zero or more path segments (so `**/*.ts` matches both `a.ts` and
  // `sub/a.ts`), and a bare `**` should match anything including paths
  // with no separators.
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

async function walk(
  root: string,
  dir: string,
  matcher: RegExp,
  cap: number,
  out: string[],
  onCap: () => void,
): Promise<void> {
  if (out.length >= cap) return;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= cap) return;
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let isDir = false;
    try {
      const s = await fs.lstat(full);
      if (s.isSymbolicLink()) continue; // skip symlinks for safety
      isDir = s.isDirectory();
    } catch {
      continue;
    }
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (matcher.test(rel)) {
      out.push(full);
      if (out.length >= cap) onCap();
    }
    if (isDir) await walk(root, full, matcher, cap, out, onCap);
  }
}

export type GlobInput = z.infer<typeof InputSchema>;
