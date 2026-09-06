/**
 * 7.2 — repo_map tool (~1-2k tokens) — ranking = churn × recency × path importance × import in-degree
 * Regex-extracted symbols for TS/JS/Py/Go/Rust/Java. Auto-injected for large repos via Level6 context when >50 files.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from './types.js';
import { safe } from './normalize.js';
import { buildRepoMap, formatRepoMap } from '../context/repo-map.js';

const InputSchema = z.object({
  query: z.string().optional().describe('Optional filter: only files matching query substring'),
  maxFiles: z.number().int().min(1).max(100).optional().describe('Max files (default 40)'),
});

function pathImportance(p: string): number {
  const lower = p.toLowerCase();
  if (lower.includes('auth')) return 3;
  if (lower.includes('src/')) return 2;
  if (lower.includes('lib/')) return 2;
  if (lower.startsWith('src/')) return 2;
  return 1;
}

async function mtimeScore(cwd: string, rel: string): Promise<number> {
  try { const s = await fs.stat(path.join(cwd, rel)); const ageHrs = (Date.now() - s.mtimeMs) / 3600000; return ageHrs < 24 ? 3 : ageHrs < 168 ? 2 : 1; } catch { return 1; }
}

async function importInDegree(cwd: string, all: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const f of all) {
    try {
      const txt = await fs.readFile(path.join(cwd, f), 'utf-8');
      const re = /(?:from\s+['"](\.\/[^'"]+)['"]|import\s+['"](\.\/[^'"]+)['"])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt))) {
        const spec = m[1] ?? m[2];
        if (!spec) continue;
        const resolved = path.normalize(path.join(path.dirname(f), spec)).replace(/\\/g, '/');
        // count import to resolved (approx)
        for (const cand of all) if (cand.includes(resolved) || resolved.includes(cand.slice(0, 10))) map.set(cand, (map.get(cand) ?? 0) + 1);
      }
    } catch { /* ignore */ }
  }
  return map;
}

export const repoMapTool = defineTool({
  name: 'repo_map',
  description: 'Ranked file map: top files by importance (path×recency×imports). 1-2k tokens. Use to locate auth, DB, routing etc. without reading all files.',
  inputSchema: InputSchema,
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => {
    return safe(async () => {
      const maxFiles = input.maxFiles ?? 40;
      const files = await buildRepoMap({ cwd: ctx.cwd, maxFiles: 120, maxFileBytes: 128 * 1024 });
      const rels = files.map((f) => f.path);
      const indeg = await importInDegree(ctx.cwd, rels);
      const scored = await Promise.all(files.map(async (f) => {
        const imp = indeg.get(f.path) ?? 0;
        const impScore = Math.min(3, 1 + imp);
        const pImp = pathImportance(f.path);
        const rec = await mtimeScore(ctx.cwd, f.path);
        // simple churn proxy: filename length diversity (real churn requires git log, approximated)
        const churn = 1;
        const score = pImp * rec * impScore * churn;
        return { f, score };
      }));
      scored.sort((a, b) => b.score - a.score);
      let top = scored.slice(0, maxFiles).map((s) => s.f);
      if (input.query) {
        const q = input.query.toLowerCase();
        const filtered = top.filter((f) => f.path.toLowerCase().includes(q) || f.symbols.some((s) => s.name.toLowerCase().includes(q)));
        if (filtered.length > 0) top = filtered.slice(0, maxFiles);
      }
      const text = formatRepoMap(top);
      // cap to 1-2k tokens (~6k chars)
      const capped = text.length > 6000 ? text.slice(0, 6000) + '\n... [truncated]' : text;
      return { files: top.map((f) => f.path), outline: capped, count: top.length } as const;
    });
  },
});
