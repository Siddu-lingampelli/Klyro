/**
 * Track files read this session for the write guard (3.2).
 *
 * Entries are stored normalized (lexical normalize + forward slashes, no
 * leading ./) in raw AND cwd-resolved absolute form, so `sub/../x`,
 * `./x`, and absolute-vs-relative spellings of the same file all match.
 * History is per task-session: hosts call clearReadHistory() when a new
 * task starts so reads don't leak across sessions in one process.
 */
import * as path from 'node:path';

const sessionReadFiles = new Set<string>();

function normalize(p: string): string {
  // Strip the drive letter: on Windows, path.normalize('/x') keeps the
  // slashes while path.resolve('/x') prepends the cwd drive (A:/x) — without
  // this, absolute-vs-relative spellings of the same file never match.
  return path
    .normalize(p)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^[A-Za-z]:/, '');
}

export function markRead(p: string, cwd?: string): void {
  sessionReadFiles.add(normalize(p));
  if (cwd) {
    try {
      sessionReadFiles.add(normalize(path.resolve(cwd, p)));
    } catch { /* ignore */ }
  }
}

export function wasRead(p: string, cwd?: string): boolean {
  if (sessionReadFiles.has(normalize(p))) return true;
  if (cwd) {
    try {
      if (sessionReadFiles.has(normalize(path.resolve(cwd, p)))) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export function clearReadHistory(): void {
  sessionReadFiles.clear();
}
