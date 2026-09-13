/**
 * File-based extensibility: `.klyro/commands/*.md` (project) +
 * `~/.klyro/commands/*.md` (global). Project wins on name clash.
 *
 * Format: YAML-ish frontmatter (`---` fences) with `name` (default:
 * filename), `description`/`hint`, then a body supporting `$1..$9` and
 * `$@` (all args). A custom command expands to prompt text and runs
 * through the normal prompt path (with recursion depth guard).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface FrontmatterResult {
  data: Record<string, string>;
  body: string;
}

/** Minimal frontmatter parser: `---` fences + `key: value` lines only. */
export function parseFrontmatter(text: string): FrontmatterResult {
  const data: Record<string, string> = {};
  if (!text.startsWith('---')) return { data, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data, body: text };
  const head = text.slice(3, end);
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trimEnd());
    if (m) data[m[1]!.toLowerCase()] = (m[2] ?? '').trim();
  }
  return { data, body: text.slice(end + 4).replace(/^\r?\n/, '') };
}

/** Parse a scalar list: `[a, b]`, `a, b`, or newline/`- ` items. */
export function parseList(value: string | undefined): string[] {
  if (!value) return [];
  let v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  const out: string[] = [];
  for (const chunk of v.split(/[\n,]/)) {
    const t = chunk.trim().replace(/^-+\s*/, '').replace(/^['"]|['"]$/g, '');
    if (t) out.push(t);
  }
  return out;
}

export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(true|yes|1|on)$/i.test(value.trim());
}

export function parseInt_(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export interface CustomCommand {
  name: string;
  description: string;
  body: string;
  source: 'project' | 'global';
}

/** Expand `$1..$9` and `$@` (all args joined by space). Missing args → ''. */
export function expandArgs(body: string, args: string[]): string {
  const all = args.join(' ');
  return body
    .replace(/\$@/g, () => all)
    .replace(/\$([1-9])/g, (_m, d: string) => args[Number(d) - 1] ?? '');
}

function commandsDir(home: string): string[] {
  return [path.join(home, '.klyro', 'commands')];
}

function readCommandFile(file: string, source: 'project' | 'global'): CustomCommand | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  const fallback = path.basename(file, path.extname(file)).toLowerCase();
  const name = (data['name'] || fallback).toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) return null;
  if (!body.trim()) return null;
  return { name, description: data['description'] || data['hint'] || '', body: body.trim(), source };
}

function listCommandFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/** Load custom commands: global first, project wins on name clash. Never throws. */
export function loadCustomCommands(cwd: string): CustomCommand[] {
  const byName = new Map<string, CustomCommand>();
  try {
    const home = os.homedir() || process.cwd();
    for (const dir of commandsDir(home)) {
      for (const f of listCommandFiles(dir)) {
        const c = readCommandFile(f, 'global');
        if (c) byName.set(c.name, c);
      }
    }
    const projectDir = path.join(cwd, '.klyro', 'commands');
    for (const f of listCommandFiles(projectDir)) {
      const c = readCommandFile(f, 'project');
      if (c) byName.set(c.name, c);
    }
  } catch {
    return [...byName.values()];
  }
  return [...byName.values()];
}

const COMPLETABLE_IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.klyro', 'out', '.next', 'target', 'vendor']);
const MAX_COMPLETABLE_FILES = 1000;

/**
 * Relative file paths for `@`-completion: recursive walk, ignored dirs
 * skipped, capped (directories sort first via trailing `/`).
 */
export function listCompletableFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    if (out.length >= MAX_COMPLETABLE_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of sorted) {
      if (out.length >= MAX_COMPLETABLE_FILES) return;
      if (rel === '' && COMPLETABLE_IGNORED.has(e.name)) continue;
      if (e.name.startsWith('.') && rel === '') {
        // Top-level dotfiles are completable (e.g. .env.example) but never traversed.
        if (e.isFile()) out.push(e.name);
        continue;
      }
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        out.push(`${r}/`);
        walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        out.push(r);
      }
    }
  };
  try {
    walk(cwd, '');
  } catch {
    return out;
  }
  return out;
}
