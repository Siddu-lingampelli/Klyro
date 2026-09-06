/**
 * Snippet reader — read a slice of a file (line window). Used by the
 * runtime when the model needs a specific region, not the whole file.
 */

import * as fs from 'node:fs/promises';
import { resolveWithinCwd } from '../policy/path-guard.js';

export interface Snippet {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface SnippetOptions {
  cwd: string;
  path: string;
  startLine?: number;
  maxLines?: number;
}

export async function readSnippet(opts: SnippetOptions): Promise<Snippet> {
  const { resolved } = resolveWithinCwd(opts.cwd, opts.path);
  const content = await fs.readFile(resolved, 'utf-8');
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, opts.startLine ?? 1);
  const max = Math.min(opts.maxLines ?? 200, lines.length - start + 1);
  const end = start + max - 1;
  return { path: opts.path, startLine: start, endLine: end, content: lines.slice(start - 1, end).join('\n') };
}
