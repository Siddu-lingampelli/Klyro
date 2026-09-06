/**
 * edit_file — find-and-replace in an existing file.
 * Strict: ambiguous matches fail unless replaceAll=true. Missing match fails.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveAndFollowSymlinks } from '../../policy/path-guard.js';
import { safe, TOOL_ERROR_CODES } from '../normalize.js';
import { wasRead } from './read-history.js';

const InputSchema = z.object({
  path: z.string().min(1),
  find: z.string().min(1).describe('Exact substring to match. Not a regex.'),
  replace: z.string(),
  replaceAll: z.boolean().optional().describe('If true, replace every occurrence.'),
});

export interface EditFileOutput {
  path: string;
  replacements: number;
  diff: string;
}

// Staleness map: path -> { mtime, hash }
const stalenessMap = new Map<string, { mtime: number; hash: string }>();
export function recordEditStaleness(path: string, mtime: number, hash: string): void {
  stalenessMap.set(path, { mtime, hash });
}
export function checkStaleness(path: string, currentMtime: number, currentHash: string): boolean {
  const prev = stalenessMap.get(path);
  if (!prev) return false;
  return prev.mtime !== currentMtime || prev.hash !== currentHash;
}

export const editFileTool = defineTool<z.infer<typeof InputSchema>, EditFileOutput>({
  name: 'edit_file',
  description:
    'Replace a substring in a file. Strict: if `find` is missing or ambiguous, the edit fails (unless replaceAll=true). Preserves EOL/BOM/trailing newline, checks staleness.',
  inputSchema: InputSchema,
  permission: 'edit',
  isConcurrencySafe: false,
  renderCall: (input) => `edit_file ${input.path} find:${input.find.slice(0, 40)}`,
  renderResult: (output) => `${output.path} ${output.replacements} replacement(s)`,
  execute: async (input, ctx) => {
    return safe(async () => {
      const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, input.path);
      // 4.1: staleness check via mtime+hash
      const stat = await fs.stat(resolved);
      const raw = await fs.readFile(resolved, 'utf-8');
      // Detect BOM
      const hasBOM = raw.charCodeAt(0) === 0xfeff;
      const withoutBOM = hasBOM ? raw.slice(1) : raw;
      // Detect EOL
      const eol = withoutBOM.includes('\r\n') ? '\r\n' : '\n';
      const hasTrailingNewline = withoutBOM.endsWith('\n');
      // Detect original for staleness
      const currentHash = crypto.createHash('sha256').update(withoutBOM, 'utf-8').digest('hex');
      if (checkStaleness(resolved, stat.mtimeMs, currentHash)) {
        throw Object.assign(new Error(`File ${input.path} changed externally since last read — please re-read before editing`), { code: 'STALE' });
      }
      let original = withoutBOM;
      let findStr = input.find;
      let count = countOccurrences(original, findStr);
      let fuzzyTier: string | null = null;
      // 4.2 fuzzy tiers (only after exact fails)
      if (count === 0) {
        const tiers: Array<{ name: string; transform: (s: string) => string }> = [
          { name: 'trailing-whitespace', transform: (s) => s.replace(/[ \t]+$/gm, '') },
          { name: 'indent-width', transform: (s) => s.replace(/^ {2,}/gm, (m) => '\t'.repeat(m.length / 2)) },
          { name: 'unicode-quotes', transform: (s) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/—/g, '-') },
        ];
        for (const tier of tiers) {
          const tFind = tier.transform(findStr);
          const tOrig = tier.transform(original);
          const c = countOccurrences(tOrig, tFind);
          if (c > 0) {
            findStr = tFind;
            original = tOrig;
            fuzzyTier = tier.name;
            count = c;
            break;
          }
        }
        // Line-window similarity >=0.95
        if (count === 0) {
          const lines = original.split('\n');
          let bestScore = 0;
          let bestIdx = -1;
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? '';
            const score = line.length > 0 ? [...findStr].filter((ch, idx) => line[idx] === ch).length / Math.max(line.length, findStr.length) : 0;
            if (score > bestScore) bestScore = score;
            if (score >= 0.95) { bestIdx = i; break; }
            if (score > bestScore) bestIdx = i;
          }
          if (bestScore >= 0.95 && bestIdx >= 0) {
            findStr = lines[bestIdx] ?? findStr;
            count = 1;
            fuzzyTier = 'line-window-0.95';
          }
        }
      }
      if (count === 0) {
        const closest = findClosestMatch(original, input.find);
        throw Object.assign(
          new Error(
            `find substring not present in ${input.path}. Closest match (similarity ${(closest.similarity * 100).toFixed(0)}%): line ${closest.lineRange[0]}-${closest.lineRange[1]} "${closest.snippet.slice(0, 80)}" — re-read and retry with exact context${fuzzyTier ? ` (tried fuzzy: ${fuzzyTier})` : ''}`,
          ),
          { code: 'MATCH_NOT_FOUND', details: closest },
        );
      }
      const replaceAll = input.replaceAll === true;
      if (!replaceAll && count > 1) {
        throw Object.assign(
          new Error(`find substring occurs ${count} times in ${input.path}. Supply more context or pass replaceAll=true.`),
          { code: 'MATCH_AMBIGUOUS' },
        );
      }
      let next = replaceAll ? original.split(findStr).join(input.replace) : original.replace(findStr, input.replace);
      // Preserve EOL: normalize then convert
      if (eol === '\r\n') {
        next = next.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      } else {
        next = next.replace(/\r\n/g, '\n');
      }
      // Preserve trailing newline
      if (hasTrailingNewline && !next.endsWith('\n')) next += eol;
      else if (!hasTrailingNewline && next.endsWith(eol)) next = next.slice(0, -eol.length);
      // Preserve BOM
      if (hasBOM) next = '\uFEFF' + next;
      const tmp = `${resolved}.klyro-edit-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, next, 'utf-8');
      // Ensure fsync before rename (like write_file)
      const fh = await fs.open(tmp, 'r+');
      try { await fh.sync(); } finally { await fh.close().catch(() => undefined); }
      try {
        await fs.rename(tmp, resolved);
      } catch (err) {
        await fs.unlink(tmp).catch(() => undefined);
        throw err;
      }
      // Update staleness after successful edit
      const newStat = await fs.stat(resolved);
      const newHash = crypto.createHash('sha256').update(next.replace(/^\uFEFF/, ''), 'utf-8').digest('hex');
      recordEditStaleness(resolved, newStat.mtimeMs, newHash);
      const diffNote = fuzzyTier ? ` [fuzzy:${fuzzyTier}]` : '';
      return {
        path: input.path,
        replacements: replaceAll ? count : 1,
        diff: simpleDiff(original, findStr, input.replace, replaceAll ? count : 1) + diffNote,
      } satisfies EditFileOutput;
    });
  },
});

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

function findClosestMatch(text: string, needle: string): { snippet: string; lineRange: [number, number]; similarity: number } {
  const lines = text.split('\n');
  let bestIdx = 0;
  let bestScore = -1;
  let bestSnippet = '';
  // Simple similarity: longest common substring ratio
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Compute similarity as shared chars / max length (very rough)
    let score = 0;
    const minLen = Math.min(line.length, needle.length);
    for (let k = 0; k < minLen; k++) if (line[k] === needle[k]) score++;
    score = minLen > 0 ? score / Math.max(line.length, needle.length) : 0;
    // Also check if needle substring inside line
    if (line.includes(needle.slice(0, Math.min(10, needle.length)))) score += 0.3;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
      bestSnippet = line;
    }
  }
  const start = Math.max(0, bestIdx - 2);
  const end = Math.min(lines.length - 1, bestIdx + 2);
  const snippet = lines.slice(start, end + 1).join('\n');
  return { snippet, lineRange: [start + 1, end + 1], similarity: Math.min(1, bestScore) };
}

function simpleDiff(original: string, find: string, replace: string, count: number): string {
  const firstIdx = original.indexOf(find);
  if (firstIdx < 0) return '';
  const start = Math.max(0, original.lastIndexOf('\n', firstIdx) + 1);
  const endLf = original.indexOf('\n', firstIdx + find.length);
  const end = endLf < 0 ? original.length : endLf;
  const beforeSnippet = original.slice(start, end);
  const afterSnippet = beforeSnippet.split(find).join(replace);
  const more = count > 1 ? `\n... and ${count - 1} more replacement(s)` : '';
  return `--- before\n${beforeSnippet}\n+++ after\n${afterSnippet}${more}`;
}

export type EditFileInput = z.infer<typeof InputSchema>;
