/**
 * Level-6 context: project map + repo map + recent files + dependencies.
 *
 * Computed once per run, formatted compactly, and prepended to the system
 * prompt. Each sub-block is independently optional — if a sub-step errors
 * (e.g. unreadable package.json), we omit that block rather than failing
 * the whole context load.
 *
 * Token budget: we cap each sub-block so the total added context is bounded
 * (≤ ~6 KB). The exact budget is exposed via Level6Options.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildProjectMap, formatProjectMap } from './project-map.js';
import { buildRepoMap, formatRepoMap } from './repo-map.js';

export interface Level6Options {
  cwd: string;
  /** Cap on the formatted total (in characters). */
  maxTotalChars?: number;
  /** Skip the project map block. */
  skipProjectMap?: boolean;
  /** Skip the repo map block. */
  skipRepoMap?: boolean;
  /** Skip the recent files block. */
  skipRecentFiles?: boolean;
  /** Skip the dependencies block. */
  skipDeps?: boolean;
  /** Hours window for "recent". */
  recentHours?: number;
}

const DEFAULT_MAX_TOTAL_CHARS = 12_000;
const RECENT_LIMIT = 15;
const RECENT_GLOB = 'src/**';

export interface Level6Context {
  formatted: string;
  hasProjectMap: boolean;
  hasRepoMap: boolean;
  hasRecentFiles: boolean;
  hasDeps: boolean;
  /** Number of bytes saved to disk cache (0 if cache disabled). */
  cacheBytes?: number;
}

async function buildRecentFilesBlock(cwd: string, hours: number): Promise<string> {
  const sinceMs = Date.now() - hours * 60 * 60 * 1000;
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.klyro']);
  const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.ttf', '.otf', '.map']);

  async function walk(dir: string, onFile: (full: string, rel: string) => Promise<void>): Promise<void> {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      let isDir = false;
      try {
        const s = await fs.lstat(full);
        if (s.isSymbolicLink()) continue;
        isDir = s.isDirectory();
      } catch { continue; }
      const rel = path.relative(cwd, full).split(path.sep).join('/');
      if (isDir) {
        if (rel.startsWith(RECENT_GLOB.replace('/**', '/'))) await walk(full, onFile);
      } else {
        const ext = path.extname(full).toLowerCase();
        if (SKIP_EXT.has(ext)) continue;
        if (!rel.startsWith(RECENT_GLOB.replace('/**', '/'))) continue;
        await onFile(full, rel);
      }
    }
  }

  const recent: { rel: string; mtimeMs: number }[] = [];
  await walk(cwd, async (full, rel) => {
    try {
      const mtimeMs = (await fs.stat(full)).mtimeMs;
      if (mtimeMs >= sinceMs) recent.push({ rel, mtimeMs });
    } catch { /* noop */ }
  });
  recent.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = recent.slice(0, RECENT_LIMIT);
  if (!top.length) return '';
  const lines = ['# Recently changed (in src/, last ' + hours + 'h)'];
  for (const f of top) {
    const ageH = ((Date.now() - f.mtimeMs) / (1000 * 60 * 60)).toFixed(1);
    lines.push(`- ${f.rel}  (${ageH}h ago)`);
  }
  return lines.join('\n');
}

async function buildDepsBlock(cwd: string): Promise<string> {
  // Quick-and-dirty: only package.json for now (Python/Go/Rust fall back
  // to the dedicated `dependencies` tool the model can call).
  let pkgText: string | null = null;
  try {
    const s = await fs.stat(path.join(cwd, 'package.json'));
    if (s.isFile() && s.size <= 64 * 1024) {
      pkgText = await fs.readFile(path.join(cwd, 'package.json'), 'utf-8');
    }
  } catch { /* no package.json */ }
  if (!pkgText) return '';
  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(pkgText) as Record<string, unknown>; } catch { return ''; }
  const sections: Record<string, Record<string, string>> = {};
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const d = pkg[k];
    if (!d || typeof d !== 'object') continue;
    sections[k] = d as Record<string, string>;
  }
  if (!Object.keys(sections).length) return '';
  const lines = ['# Direct dependencies (npm)'];
  for (const [k, obj] of Object.entries(sections)) {
    const entries = Object.entries(obj);
    if (!entries.length) continue;
    lines.push(`## ${k}`);
    for (const [n, v] of entries) lines.push(`- ${n} ${v}`);
  }
  return lines.join('\n');
}

/** Build a Level-6 context block for the given working directory. */
export async function buildLevel6Context(opts: Level6Options): Promise<Level6Context> {
  const maxChars = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const recentHours = opts.recentHours ?? 24;

  const blocks: string[] = [];
  const flags = { hasProjectMap: false, hasRepoMap: false, hasRecentFiles: false, hasDeps: false };

  if (!opts.skipProjectMap) {
    try {
      const m = await buildProjectMap(opts.cwd);
      const text = formatProjectMap(m);
      if (text) { blocks.push(text); flags.hasProjectMap = true; }
    } catch { /* swallow — project map is a soft signal */ }
  }

  if (!opts.skipRepoMap) {
    try {
      const files = await buildRepoMap({ cwd: opts.cwd, maxFiles: 80, maxFileBytes: 16 * 1024 });
      // Rank: prefer files with more named symbols + first-party paths.
      const ranked = files
        .map((f) => ({ f, score: f.symbols.length * 3 + (f.path.startsWith('src/') || f.path.startsWith('lib/') ? 5 : 0) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 40)
        .map((x) => x.f);
      const text = formatRepoMap(ranked);
      if (text) { blocks.push(text); flags.hasRepoMap = true; }
    } catch { /* swallow */ }
  }

  if (!opts.skipRecentFiles) {
    try {
      const text = await buildRecentFilesBlock(opts.cwd, recentHours);
      if (text) { blocks.push(text); flags.hasRecentFiles = true; }
    } catch { /* swallow */ }
  }

  if (!opts.skipDeps) {
    try {
      const text = await buildDepsBlock(opts.cwd);
      if (text) { blocks.push(text); flags.hasDeps = true; }
    } catch { /* swallow */ }
  }

  let formatted = blocks.join('\n\n');
  if (formatted.length > maxChars) {
    // Truncate at the last newline before maxChars, then append a marker.
    const cut = formatted.lastIndexOf('\n', maxChars);
    formatted = formatted.slice(0, cut > 0 ? cut : maxChars) + '\n[truncated]';
  }

  return { formatted, ...flags };
}

/** Persist the Level-6 context to a JSON cache under .klyro/. */
export async function writeLevel6Cache(cwd: string, ctx: Level6Context): Promise<string | null> {
  if (!ctx.formatted) return null;
  const dir = path.join(cwd, '.klyro');
  try { await fs.mkdir(dir, { recursive: true }); } catch { return null; }
  const file = path.join(dir, 'context.json');
  const payload = {
    generatedAt: new Date().toISOString(),
    formatted: ctx.formatted,
    hasProjectMap: ctx.hasProjectMap,
    hasRepoMap: ctx.hasRepoMap,
    hasRecentFiles: ctx.hasRecentFiles,
    hasDeps: ctx.hasDeps,
  };
  try {
    await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
    return file;
  } catch { return null; }
}

export async function readLevel6Cache(cwd: string): Promise<Level6Context | null> {
  const file = path.join(cwd, '.klyro', 'context.json');
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      formatted: typeof data.formatted === 'string' ? data.formatted : '',
      hasProjectMap: !!data.hasProjectMap,
      hasRepoMap: !!data.hasRepoMap,
      hasRecentFiles: !!data.hasRecentFiles,
      hasDeps: !!data.hasDeps,
    };
  } catch { return null; }
}
