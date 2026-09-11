/**
 * 7.3 — Import graph (cached) — powers L6 scoped tests + imports_of / importers_of
 * Parses TS/JS/Py/Go imports via regex, builds adjacency, caches by mtime.
 *
 * Freshness: the cached graph stores per-file {mtimeMs, size} alongside it.
 * On a cache hit every file in the graph is re-statted (stat-only, bounded
 * to files already in the graph) — any mtime/size mismatch rebuilds.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ImportGraph { nodes: Set<string>; edges: Map<string, Set<string>>; mtime: number; }

interface FileStat { mtimeMs: number; size: number; }

let cache: { cwd: string; graph: ImportGraph; stats: Map<string, FileStat> } | null = null;

async function parseImports(file: string, content: string): Promise<string[]> {
  const ext = path.extname(file);
  const out: string[] = [];
  const re = ext === '.py'
    ? /^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/gm
    : /(?:import\s+.*?from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const spec = m[1] ?? m[2];
    if (spec && spec.startsWith('.')) out.push(spec);
  }
  return out;
}

/** Re-stat every file in the cached graph; true when all stats still match. */
async function statsStillMatch(cwd: string, stats: Map<string, FileStat>): Promise<boolean> {
  for (const [rel, prev] of stats) {
    try {
      const s = await fs.stat(path.join(cwd, rel));
      if (s.mtimeMs !== prev.mtimeMs || s.size !== prev.size) return false;
    } catch {
      return false; // deleted (or unreadable) — rebuild
    }
  }
  return true;
}

/** Invalidate the import-graph cache (tests + callers that mutate the tree). */
export function clearImportGraphCache(): void {
  cache = null;
}

export async function buildImportGraph(cwd: string): Promise<ImportGraph> {
  if (cache && cache.cwd === cwd && Date.now() - cache.graph.mtime < 60_000) {
    if (await statsStillMatch(cwd, cache.stats)) return cache.graph;
    cache = null;
  }
  const graph: ImportGraph = { nodes: new Set(), edges: new Map(), mtime: Date.now() };
  const stats = new Map<string, FileStat>();
  async function walk(dir: string, depth = 0) {
    if (depth > 6) return;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['node_modules','.git','dist','.klyro'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth+1);
      else if (e.isFile() && /\.(ts|tsx|js|jsx|py|go)$/.test(e.name)) {
        const rel = path.relative(cwd, full).replace(/\\/g,'/');
        graph.nodes.add(rel);
        try {
          const st = await fs.stat(full);
          stats.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
          const txt = await fs.readFile(full, 'utf-8');
          const imps = await parseImports(rel, txt);
          for (const imp of imps) {
            const resolved = path.normalize(path.join(path.dirname(rel), imp)).replace(/\\/g,'/');
            if (!graph.edges.has(rel)) graph.edges.set(rel, new Set());
            graph.edges.get(rel)!.add(resolved);
          }
        } catch { /* ignore */ }
      }
    }
  }
  await walk(cwd);
  cache = { cwd, graph, stats };
  return graph;
}

export async function importsOf(cwd: string, file: string): Promise<string[]> {
  const g = await buildImportGraph(cwd);
  const rel = path.relative(cwd, path.resolve(cwd, file)).replace(/\\/g,'/');
  return [...(g.edges.get(rel) ?? new Set())];
}

export async function importersOf(cwd: string, file: string): Promise<string[]> {
  const g = await buildImportGraph(cwd);
  const target = path.relative(cwd, path.resolve(cwd, file)).replace(/\\/g,'/');
  const out: string[] = [];
  for (const [src, deps] of g.edges) if ([...deps].some((d) => target.includes(d) || d.includes(target))) out.push(src);
  return out;
}
