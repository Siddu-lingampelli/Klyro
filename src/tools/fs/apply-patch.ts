/**
 * 4.2 — apply_patch: Codex-style unified patch with REAL hunk application.
 *
 * Format:
 *   *** Begin Patch
 *   *** Update File: <path>     (must contain @@ hunks for existing files)
 *   *** Add File: <path>        (created from + lines)
 *   *** End Patch
 *
 * Hunks are standard unified diff: `@@ -a,b +c,d @@` headers, ' ' context,
 * '-' removals, '+' additions. Context/removals must match the file (exact
 * first, trailing-whitespace-insensitive fallback with ±3 line drift);
 * otherwise INVALID_PATCH names the file+hunk instead of corrupting it.
 *
 * Legacy compat: a file section with NO @@ lines and only + lines is treated
 * as file creation (the old tolerant behavior) — but never as an edit to an
 * existing file, where hunk-less appends used to corrupt content.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveAndFollowSymlinks } from '../../policy/path-guard.js';
import { safe, TOOL_ERROR_CODES } from '../normalize.js';
import { wasRead } from './read-history.js';

const InputSchema = z.object({
  patch: z.string().min(1).describe('Unified diff patch text'),
});

interface Hunk {
  header: string;
  oldStart: number;
  lines: Array<{ kind: 'context' | 'remove' | 'add'; text: string }>;
}

function parseHunks(lines: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (m) {
      cur = { header: line, oldStart: parseInt(m[1]!, 10), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('\\ ')) continue; // "\ No newline at end of file"
    if (!cur) continue; // stray lines outside hunks are ignored
    if (line.startsWith('+')) cur.lines.push({ kind: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) cur.lines.push({ kind: 'remove', text: line.slice(1) });
    else if (line.startsWith(' ')) cur.lines.push({ kind: 'context', text: line.slice(1) });
    else if (line === '') cur.lines.push({ kind: 'context', text: '' });
    // any other prefix inside a hunk is ignored (tolerant)
  }
  return hunks;
}

function linesEqual(a: string, b: string): boolean {
  return a === b || a.replace(/[ \t]+$/g, '') === b.replace(/[ \t]+$/g, '');
}

/** Match the hunk's old block (context+removals) starting at `at`. */
function matchAt(fileLines: string[], hunk: Hunk, at: number): boolean {
  let i = at;
  for (const l of hunk.lines) {
    if (l.kind === 'add') continue;
    if (i < 0 || i >= fileLines.length) return false;
    if (!linesEqual(fileLines[i]!, l.text)) return false;
    i++;
  }
  return true;
}

function applyHunks(filePath: string, fileLines: string[], hunks: Hunk[]): string[] {
  const out = [...fileLines];
  // Apply last hunk first so earlier line numbers stay valid.
  const ordered = hunks
    .map((h, idx) => ({ h, idx }))
    .sort((a, b) => b.h.oldStart - a.h.oldStart || b.idx - a.idx);
  for (const { h, idx } of ordered) {
    const want = Math.max(0, h.oldStart - 1);
    let at = -1;
    for (let drift = 0; drift <= 3; drift++) {
      if (matchAt(out, h, want + drift)) {
        at = want + drift;
        break;
      }
      if (drift > 0 && matchAt(out, h, want - drift)) {
        at = want - drift;
        break;
      }
    }
    if (at === -1) {
      throw Object.assign(
        new Error(`hunk ${idx + 1} (${h.header}) does not match ${filePath} — re-read the file and regenerate the patch`),
        { code: 'HUNK_MISMATCH' },
      );
    }
    const replacement: string[] = [];
    for (const l of h.lines) {
      if (l.kind === 'add' || l.kind === 'context') replacement.push(l.text);
    }
    const oldLen = h.lines.filter((l) => l.kind !== 'add').length;
    out.splice(at, oldLen, ...replacement);
  }
  return out;
}

async function guardWrite(cwd: string, relPath: string, resolved: string): Promise<void> {
  try {
    const existing = await fs.readFile(resolved, 'utf-8');
    if (!wasRead(relPath, cwd) && existing.length > 200) {
      throw Object.assign(
        new Error('File was not read this session and is >200 bytes — re-read before writing (POLICY_DENIED)'),
        { code: 'POLICY_DENIED' },
      );
    }
  } catch (e: unknown) {
    if (e && typeof e === 'object' && (e as { code?: string }).code === 'POLICY_DENIED') throw e;
    // missing file → creation path, no guard needed
  }
}

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  description: 'Apply a unified diff patch (Codex-style). Real hunk application with context matching; mismatches fail loudly.',
  inputSchema: InputSchema,
  permission: 'edit',
  isConcurrencySafe: false,
  execute: async (input, ctx) => {
    return safe(async () => {
      const lines = input.patch.split('\n');
      interface FileSection {
        op: 'update' | 'add';
        path: string;
        body: string[];
      }
      const sections: FileSection[] = [];
      let cur: FileSection | null = null;
      for (const line of lines) {
        if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) continue;
        if (line.startsWith('*** Update File:')) {
          cur = { op: 'update', path: line.replace('*** Update File:', '').trim(), body: [] };
          sections.push(cur);
          continue;
        }
        if (line.startsWith('*** Add File:')) {
          cur = { op: 'add', path: line.replace('*** Add File:', '').trim(), body: [] };
          sections.push(cur);
          continue;
        }
        if (cur) cur.body.push(line);
      }
      if (sections.length === 0) {
        throw Object.assign(new Error('No files patched — invalid patch format'), { code: 'INVALID_PATCH' });
      }
      const patchedFiles: string[] = [];
      for (const sec of sections) {
        if (!sec.path) throw Object.assign(new Error('Patch section missing file path'), { code: 'INVALID_PATCH' });
        const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, sec.path);
        const hunks = parseHunks(sec.body);
        if (sec.op === 'add' || hunks.length === 0) {
          // Creation path: content from + lines (legacy tolerant format).
          // For *** Update File *** this is only valid when the file does NOT
          // exist yet — editing an existing file without hunks is rejected
          // instead of appending junk at EOF (the old corruption).
          let exists = false;
          try {
            await fs.stat(resolved);
            exists = true;
          } catch { /* missing → create */ }
          if (exists && sec.op === 'update') {
            throw Object.assign(
              new Error(`No hunks for existing file ${sec.path} — provide @@ hunks (refusing hunk-less edit)`),
              { code: 'INVALID_PATCH' },
            );
          }
          const content = sec.body
            .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
            .map((l) => l.slice(1))
            .join('\n');
          await guardWrite(ctx.cwd, sec.path, resolved);
          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, content ? content + '\n' : '', 'utf-8');
          patchedFiles.push(sec.path);
          continue;
        }
        // Update path: apply hunks against current content.
        let current: string;
        try {
          current = await fs.readFile(resolved, 'utf-8');
        } catch {
          throw Object.assign(new Error(`Cannot update missing file ${sec.path} with hunks — use *** Add File ***`), {
            code: 'INVALID_PATCH',
          });
        }
        await guardWrite(ctx.cwd, sec.path, resolved);
        const hasTrailingNewline = current.endsWith('\n');
        const fileLines = current.split('\n');
        if (hasTrailingNewline && fileLines[fileLines.length - 1] === '') fileLines.pop();
        const next = applyHunks(sec.path, fileLines, hunks);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, next.join('\n') + (hasTrailingNewline ? '\n' : ''), 'utf-8');
        patchedFiles.push(sec.path);
      }
      if (patchedFiles.length === 0) throw Object.assign(new Error('No files patched — invalid patch format'), { code: 'INVALID_PATCH' });
      return { patchedFiles, count: patchedFiles.length } as const;
    });
  },
});
