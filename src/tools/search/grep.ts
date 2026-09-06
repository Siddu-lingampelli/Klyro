/**
 * grep — regex search over file contents. Bounded results.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveWithinCwd } from '../../policy/path-guard.js';
import { safe, TOOL_ERROR_CODES } from '../normalize.js';

const InputSchema = z.object({
  pattern: z.string().min(1).describe('JavaScript regular expression (not ripgrep syntax)'),
  cwd: z.string().optional(),
  include: z.string().optional().describe('Glob filter for included files (e.g. "*.ts")'),
  maxResults: z.number().int().min(1).max(5_000).optional().describe('Cap hits (default 500)'),
  contextLines: z.number().int().min(0).max(5).optional().describe('Lines of context around each hit (default 0)'),
});

const DEFAULT_MAX = 500;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '.klyro']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.ttf', '.otf', '.exe', '.dll', '.bin', '.zip', '.tar', '.gz']);

export interface GrepHit {
  file: string;
  line: number;
  text: string;
  context?: { before: string[]; after: string[] };
}

export interface GrepOutput {
  pattern: string;
  hits: GrepHit[];
  truncated: boolean;
  searchedFiles: number;
}

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search file contents with a JavaScript regex. Skips binary files and common build dirs. Returns hits with optional context lines.',
  inputSchema: InputSchema,
  execute: async (input, ctx) => {
    return safe(async () => {
      const base = input.cwd ? resolveWithinCwd(ctx.cwd, input.cwd).resolved : ctx.cwd;
      let re: RegExp;
      try {
        re = new RegExp(input.pattern, 'g');
      } catch (e) {
        return {
          ok: false,
          error: { code: TOOL_ERROR_CODES.INVALID_INPUT, message: `Invalid regex: ${e instanceof Error ? e.message : String(e)}` },
        } as const;
      }
      const incRe = input.include ? globToRegex(input.include) : null;
      const max = input.maxResults ?? DEFAULT_MAX;
      const ctxLines = input.contextLines ?? 0;
      const hits: GrepHit[] = [];
      let searched = 0;
      let truncated = false;
      await walk(base, async (file) => {
        if (hits.length >= max) {
          truncated = true;
          return;
        }
        if (incRe && !incRe.test(path.relative(base, file).split(path.sep).join('/'))) return;
        const ext = path.extname(file).toLowerCase();
        if (SKIP_EXT.has(ext)) return;
        const stat = await fs.stat(file).catch(() => null);
        if (!stat || stat.size > DEFAULT_MAX_FILE_BYTES) return;
        searched++;
        const text = await fs.readFile(file, 'utf-8').catch(() => null);
        if (text === null) return;
        if (text.includes('\0')) return; // binary
        const lines = text.split(/\r\n|\r|\n/);
        for (let i = 0; i < lines.length && hits.length < max; i++) {
          const line = lines[i];
          if (line === undefined) continue;
          re.lastIndex = 0;
          if (re.test(line)) {
            const hit: GrepHit = {
              file: path.relative(ctx.cwd, file),
              line: i + 1,
              text: line,
            };
            if (ctxLines > 0) {
              hit.context = {
                before: lines.slice(Math.max(0, i - ctxLines), i),
                after: lines.slice(i + 1, i + 1 + ctxLines),
              };
            }
            hits.push(hit);
          }
        }
      });
      return { pattern: input.pattern, hits, truncated, searchedFiles: searched } satisfies GrepOutput;
    });
  },
});

function globToRegex(g: string): RegExp {
  const escaped = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DS::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/::DS::/g, '.*');
  return new RegExp(`^${escaped}$`);
}

async function walk(dir: string, visit: (f: string) => Promise<void>): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let isDir = false;
    try {
      const s = await fs.lstat(full);
      if (s.isSymbolicLink()) continue;
      isDir = s.isDirectory();
    } catch {
      continue;
    }
    if (isDir) await walk(full, visit);
    else await visit(full);
  }
}

export type GrepInput = z.infer<typeof InputSchema>;
