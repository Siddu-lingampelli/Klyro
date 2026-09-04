/**
 * Tiny unified-diff parser.
 *
 * Handles the subset of `git diff` output that the runtime cares about:
 *   - `diff --git a/x b/x` headers
 *   - `+++ b/path` / `--- a/path` path lines
 *   - `@@ ... @@` hunk headers
 *   - `+`, `-`, ` ` (context) lines
 *
 * Skips:
 *   - `index ...` lines
 *   - `Binary files ... differ` lines
 *   - "no newline at end of file" markers
 *
 * Returns one DiffHunk per file. Lines are preserved in order.
 */

import type { DiffHunk, DiffLine } from './diff.js';

export function parseUnifiedDiff(raw: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) out.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = stripDiffPrefix(line.slice(4));
      if (path) current = { path, lines: [] };
      continue;
    }
    if (line.startsWith('--- ')) {
      // Path on the "from" side — we prefer the "to" path so the
      // heading matches the file the user is editing.
      continue;
    }
    if (line.startsWith('@@')) {
      if (current) current.lines.push({ kind: 'header', text: line });
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', text: line.slice(1) });
      continue;
    }
    if (line.startsWith('-')) {
      current.lines.push({ kind: 'remove', text: line.slice(1) });
      continue;
    }
    if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1) });
      continue;
    }
    if (line.startsWith('index ') || line.startsWith('Binary files')) continue;
    if (line === '\\ No newline at end of file') continue;
    // Unknown line — keep as context so we don't lose info.
    current.lines.push({ kind: 'context', text: line });
  }
  if (current) out.push(current);
  return out;
}

function stripDiffPrefix(s: string): string {
  // "b/src/foo.ts" → "src/foo.ts"; "a/src/foo.ts" → "src/foo.ts"
  if (s.startsWith('b/') || s.startsWith('a/')) return s.slice(2);
  return s;
}
