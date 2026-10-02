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

import type { DiffHunk } from './diff.js';

export function parseUnifiedDiff(raw: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  // Candidate path from the `--- ` side: used when the `+++ ` side is
  // /dev/null (deleted file) and therefore names no real path.
  let fromPath: string | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) out.push(current);
      current = null;
      fromPath = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const toRaw = line.slice(4).trim();
      // A new file section without a `diff --git` header must not swallow
      // the previous file's lines — flush first.
      if (current && current.lines.length > 0) {
        out.push(current);
        current = null;
      }
      const toPath = stripDiffPrefix(toRaw);
      if (toPath && toPath !== '/dev/null') {
        current = { path: toPath, lines: [] };
      } else if (fromPath && fromPath !== '/dev/null') {
        // Deleted file: `--- a/f` / `+++ /dev/null` — keep the real path,
        // not `/dev/null`.
        current = { path: fromPath, lines: [] };
      } else {
        current = null;
      }
      fromPath = null;
      continue;
    }
    if (line.startsWith('--- ')) {
      // Stash the "from" path (see `+++ ` handling above) — we still
      // prefer the "to" path so the heading matches the edited file.
      const cand = stripDiffPrefix(line.slice(4).trim());
      fromPath = cand || null;
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
