/**
 * 7.4 — find_symbol via the regex repo-map (no tree-sitter dependency).
 * Previously gated behind KLYRO_SYMBOLS=1; enabled by default now — the
 * regex symbol index is genuinely useful for name lookup even though
 * ripgrep wins on raw locate speed. Set KLYRO_SYMBOLS=0 to force the
 * disabled path (kept for the eval comparison).
 */
import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';
import { buildRepoMap } from '../../context/repo-map.js';

export const findSymbolTool = defineTool({
  name: 'find_symbol',
  description: 'Find a code symbol (function/class/interface/const) by name across the repo',
  inputSchema: z.object({ name: z.string().min(1), kind: z.string().optional() }),
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => safe(async () => {
    if (process.env.KLYRO_SYMBOLS === '0') {
      return { name: input.name, hits: [], note: 'find_symbol disabled via KLYRO_SYMBOLS=0 — use grep/repo_map' } as const;
    }
    const files = await buildRepoMap({ cwd: ctx.cwd, maxFiles: 200 });
    const q = input.name.toLowerCase();
    const hits: Array<{ file: string; line: number; kind: string; name: string }> = [];
    for (const f of files) for (const s of f.symbols) if (s.name.toLowerCase().includes(q) && (!input.kind || s.kind === input.kind)) hits.push({ file: f.path, line: s.line, kind: s.kind, name: s.name });
    return { name: input.name, hits: hits.slice(0, 20) } as const;
  }),
});
