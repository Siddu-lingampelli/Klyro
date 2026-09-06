/**
 * Lightweight repo map — extract top-level symbols from a small set of
 * source-file extensions. Regex-based so it works on any platform without
 * a native tree-sitter binary. Quality is intentionally low — the goal is
 * "give the model a useful index", not a full AST.
 *
 * Supported extensions: .ts, .tsx, .js, .jsx, .mjs, .cjs, .py, .go, .rs
 *
 * Output: per-file symbol list with kind and approximate line number.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type SymbolKind = 'class' | 'function' | 'method' | 'type' | 'const' | 'var' | 'module';

export interface Symbol {
  kind: SymbolKind;
  name: string;
  line: number;
}

export interface RepoFile {
  path: string;
  symbols: Symbol[];
}

const SUPPORTED_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs']);

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.klyro', 'coverage', 'out']);

/** Heuristic: walk cwd, return at most `maxFiles` files with symbols. */
export async function buildRepoMap(opts: { cwd: string; maxFiles?: number; maxFileBytes?: number }): Promise<RepoFile[]> {
  const maxFiles = opts.maxFiles ?? 500;
  const maxFileBytes = opts.maxFileBytes ?? 256 * 1024;
  const out: RepoFile[] = [];
  await walk(opts.cwd, async (file) => {
    if (out.length >= maxFiles) return false;
    const ext = path.extname(file).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) return true;
    let stat: import('node:fs').Stats;
    try { stat = await fs.stat(file); } catch { return true; }
    if (stat.size > maxFileBytes) return true;
    let content: string;
    try { content = await fs.readFile(file, 'utf-8'); } catch { return true; }
    out.push({ path: path.relative(opts.cwd, file), symbols: extractSymbols(content, ext) });
    return true;
  });
  return out;
}

async function walk(dir: string, visit: (file: string) => Promise<boolean>): Promise<void> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, visit);
    } else if (e.isFile()) {
      const keepGoing = await visit(full);
      if (!keepGoing) return;
    }
  }
}

/** Extract symbols with cheap regex per language. */
export function extractSymbols(content: string, ext: string): Symbol[] {
  const lines = content.split(/\r?\n/);
  const syms: Symbol[] = [];
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      extractJsLike(lines, syms);
      break;
    case '.py':
      extractPython(lines, syms);
      break;
    case '.go':
      extractGo(lines, syms);
      break;
    case '.rs':
      extractRust(lines, syms);
      break;
  }
  return syms;
}

function lineOf(lines: string[], idx: number): number { return idx + 1; }

function extractJsLike(lines: string[], out: Symbol[]): void {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    let m: RegExpMatchArray | null;
    if ((m = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(l)) && m[1]) {
      out.push({ kind: 'function', name: m[1], line: lineOf(lines, i) });
      continue;
    }
    if ((m = /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(l)) && m[1]) {
      out.push({ kind: 'class', name: m[1], line: lineOf(lines, i) });
      continue;
    }
    if ((m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/.exec(l)) && m[1]) {
      out.push({ kind: 'const', name: m[1], line: lineOf(lines, i) });
      continue;
    }
    if ((m = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/.exec(l)) && m[1]) {
      out.push({ kind: 'type', name: m[1], line: lineOf(lines, i) });
      continue;
    }
  }
}

function extractPython(lines: string[], out: Symbol[]): void {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    let m: RegExpMatchArray | null;
    if ((m = /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/.exec(l)) && m[1]) {
      out.push({ kind: 'function', name: m[1], line: lineOf(lines, i) });
      continue;
    }
    if ((m = /^\s*class\s+([A-Za-z_][\w]*)/.exec(l)) && m[1]) {
      out.push({ kind: 'class', name: m[1], line: lineOf(lines, i) });
    }
  }
}

function extractGo(lines: string[], out: Symbol[]): void {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    let m: RegExpMatchArray | null;
    if ((m = /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)/.exec(l)) && m[1]) {
      out.push({ kind: 'function', name: m[1], line: lineOf(lines, i) });
      continue;
    }
    if ((m = /^\s*type\s+([A-Za-z_][\w]*)\s+struct/.exec(l)) && m[1]) {
      out.push({ kind: 'type', name: m[1], line: lineOf(lines, i) });
    }
  }
}

function extractRust(lines: string[], out: Symbol[]): void {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    let m: RegExpMatchArray | null;
    if ((m = /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/.exec(l)) && m[1]) {
      out.push({ kind: 'function', name: m[1], line: lineOf(lines, i) });
      continue;
    }
    if ((m = /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/.exec(l)) && m[1]) {
      out.push({ kind: 'type', name: m[1], line: lineOf(lines, i) });
    }
  }
}

/** Format a RepoFile[] as a compact outline for the model. */
export function formatRepoMap(files: RepoFile[]): string {
  const lines: string[] = [];
  for (const f of files) {
    if (f.symbols.length === 0) continue;
    lines.push(`# ${f.path}`);
    for (const s of f.symbols) {
      lines.push(`  ${s.kind} ${s.name}  L${s.line}`);
    }
  }
  return lines.join('\n');
}
