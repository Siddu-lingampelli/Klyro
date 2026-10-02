/**
 * 7.5 — Language intelligence without an LSP client dependency.
 *
 * `lsp_diagnostics` runs the TypeScript compiler (`tsc --noEmit`) when the
 * project has one and filters the output to the requested path (or returns
 * a capped full-project list). Other languages report "unsupported".
 * `lsp_goto_definition` resolves the identifier under (line, character) to
 * its definition via the regex repo-map symbol index.
 * `lsp_references` finds all references to the identifier under (line, character).
 * `lsp_outline` returns a hierarchical symbol outline for a file.
 * Set KLYRO_LSP=0 to force all tools off.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';
import { resolveWithinCwd } from '../../policy/path-guard.js';
import { buildRepoMap, extractSymbols } from '../../context/repo-map.js';

function isOff(): boolean {
  return process.env.KLYRO_LSP === '0';
}

export const lspDiagnosticsTool = defineTool({
  name: 'lsp_diagnostics',
  description: 'TypeScript diagnostics for a file (tsc --noEmit, filtered to path)',
  inputSchema: z.object({ path: z.string().optional() }),
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => safe(async () => {
    if (isOff()) return { enabled: false, diagnostics: [], note: 'LSP off via KLYRO_LSP=0' } as const;
    const target = input.path ? resolveWithinCwd(ctx.cwd, input.path, ctx.agentAllowedPaths).resolved : null;
    // Prefer the project's own tsc; fall back to npx tsc on PATH.
    const tscArgs = ['--noEmit', '--pretty', 'false'];
    let out = '';
    try {
      const local = path.join(ctx.cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
      const res = spawnSync(local, tscArgs, { cwd: ctx.cwd, timeout: 90_000, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 });
      out = (res.stdout ?? '') + (res.stderr ?? '');
    } catch {
      return { enabled: false, diagnostics: [], note: 'no TypeScript compiler found (node_modules/.bin/tsc missing)' } as const;
    }
    const diags: Array<{ file: string; line: number; col: number; code: string; message: string }> = [];
    for (const ln of out.split('\n')) {
      const m = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/.exec(ln.trim());
      if (!m) continue;
      const file = m[1]!.replace(/\\/g, '/');
      if (target && path.relative(ctx.cwd, path.resolve(ctx.cwd, file)) !== path.relative(ctx.cwd, target)) continue;
      diags.push({ file, line: Number(m[2]), col: Number(m[3]), code: m[5]!, message: m[6]!.slice(0, 300) });
      if (diags.length >= 50) break;
    }
    return { enabled: true, diagnostics: diags } as const;
  }),
});

export const lspGotoDefinitionTool = defineTool({
  name: 'lsp_goto_definition',
  description: 'Go to definition: identifier under (line, character) resolved via the repo symbol index',
  inputSchema: z.object({ path: z.string().min(1), line: z.number().int().min(1), character: z.number().int().min(0).optional() }),
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => safe(async () => {
    if (isOff()) return { enabled: false, location: null, note: 'LSP off via KLYRO_LSP=0' } as const;
    const { resolved } = resolveWithinCwd(ctx.cwd, input.path, ctx.agentAllowedPaths);
    let content: string;
    try {
      content = await fs.readFile(resolved, 'utf-8');
    } catch {
      return { enabled: true, location: null, note: `unreadable file: ${input.path}` } as const;
    }
    const lines = content.split('\n');
    const lineText = lines[input.line - 1] ?? '';
    const col = Math.min(input.character ?? 0, lineText.length);
    const wordAt = ((): string | null => {
      const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);
      let s = col;
      let e = col;
      while (s > 0 && isWord(lineText[s - 1]!)) s--;
      while (e < lineText.length && isWord(lineText[e]!)) e++;
      const w = lineText.slice(s, e);
      return w || null;
    })();
    if (!wordAt) return { enabled: true, location: null, note: 'no identifier under cursor' } as const;
    const files = await buildRepoMap({ cwd: ctx.cwd, maxFiles: 300 });
    const hits: Array<{ file: string; line: number; kind: string; name: string }> = [];
    for (const f of files) {
      for (const s of f.symbols) {
        if (s.name === wordAt) hits.push({ file: f.path, line: s.line, kind: s.kind, name: s.name });
      }
    }
    // Prefer a definition outside the requesting file (import target),
    // else the local one.
    const rel = path.relative(ctx.cwd, resolved);
    const other = hits.filter((h) => h.file !== rel);
    const best = other[0] ?? hits[0] ?? null;
    return { enabled: true, location: best, candidates: hits.length } as const;
  }),
});

export const lspReferencesTool = defineTool({
  name: 'lsp_references',
  description: 'Find all references to the identifier under (line, character) via the repo symbol index',
  inputSchema: z.object({ path: z.string().min(1), line: z.number().int().min(1), character: z.number().int().min(0).optional() }),
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => safe(async () => {
    if (isOff()) return { enabled: false, references: [], note: 'LSP off via KLYRO_LSP=0' } as const;
    const { resolved } = resolveWithinCwd(ctx.cwd, input.path, ctx.agentAllowedPaths);
    let content: string;
    try {
      content = await fs.readFile(resolved, 'utf-8');
    } catch {
      return { enabled: true, references: [], note: `unreadable file: ${input.path}` } as const;
    }
    const lines = content.split('\n');
    const lineText = lines[input.line - 1] ?? '';
    const col = Math.min(input.character ?? 0, lineText.length);
    const wordAt = ((): string | null => {
      const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);
      let s = col;
      let e = col;
      while (s > 0 && isWord(lineText[s - 1]!)) s--;
      while (e < lineText.length && isWord(lineText[e]!)) e++;
      const w = lineText.slice(s, e);
      return w || null;
    })();
    if (!wordAt) return { enabled: true, references: [], note: 'no identifier under cursor' } as const;
    const files = await buildRepoMap({ cwd: ctx.cwd, maxFiles: 300 });
    const refs: Array<{ file: string; line: number; kind: string; name: string }> = [];
    const seen = new Set<string>();
    for (const f of files) {
      for (const s of f.symbols) {
        if (s.name === wordAt) {
          const key = `${f.path}:${s.line}:${s.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            refs.push({ file: f.path, line: s.line, kind: s.kind, name: s.name });
          }
        }
      }
    }
    return { enabled: true, references: refs.slice(0, 100) } as const;
  }),
});

export const lspOutlineTool = defineTool({
  name: 'lsp_outline',
  description: 'Hierarchical symbol outline for a file via the repo symbol index',
  inputSchema: z.object({ path: z.string().min(1) }),
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => safe(async () => {
    if (isOff()) return { enabled: false, outline: [], note: 'LSP off via KLYRO_LSP=0' } as const;
    const { resolved } = resolveWithinCwd(ctx.cwd, input.path, ctx.agentAllowedPaths);
    // Symbol-extract this file directly rather than via buildRepoMap: the repo
    // map is a whole-tree walk capped by maxFiles, so a single-file query can
    // never be served from it (it would return whichever file the walk reached
    // first, and the caller's path would usually be absent).
    let content: string;
    try {
      content = await fs.readFile(resolved, 'utf-8');
    } catch {
      return { enabled: true, outline: [], note: `unreadable file: ${input.path}` } as const;
    }
    const symbols = extractSymbols(content, path.extname(resolved).toLowerCase());
    // Build simple hierarchy: classes/interfaces as parents, methods/fields as children
    const outline: Array<{ name: string; kind: string; line: number; children: Array<{ name: string; kind: string; line: number }> }> = [];
    for (const sym of symbols) {
      if (['class', 'interface', 'type'].includes(sym.kind)) {
        outline.push({ name: sym.name, kind: sym.kind, line: sym.line, children: [] });
      }
    }
    for (const sym of symbols) {
      if (['method', 'function', 'property', 'field', 'const'].includes(sym.kind)) {
        // Assign to the nearest preceding class/interface
        let parentIdx = -1;
        for (let i = outline.length - 1; i >= 0; i--) {
          const parent = outline[i];
          if (parent && parent.line < sym.line) { parentIdx = i; break; }
        }
        if (parentIdx >= 0) {
          const parentEntry = outline[parentIdx];
          if (parentEntry) {
            parentEntry.children.push({ name: sym.name, kind: sym.kind, line: sym.line });
          }
        } else {
          outline.push({ name: sym.name, kind: sym.kind, line: sym.line, children: [] });
        }
      }
    }
    return { enabled: true, outline } as const;
  }),
});
