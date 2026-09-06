/**
 * 7.4 — find_symbol (optional, eval-gated) — stub using regex repo-map
 * Real tree-sitter would be <5s/100k LOC, but ripgrep baseline wins on locate suite, so shipped disabled.
 * Enable with KLYRO_SYMBOLS=1 for experiment; decision recorded in docs/decisions/7.4-symbols.md
 */
import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';
import { buildRepoMap } from '../../context/repo-map.js';

export const findSymbolTool = defineTool({
  name: 'find_symbol',
  description: 'Find symbol by name (regex, disabled unless KLYRO_SYMBOLS=1 — ripgrep wins on locate suite)',
  inputSchema: z.object({ name: z.string().min(1), kind: z.string().optional() }),
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => safe(async () => {
    if (process.env.KLYRO_SYMBOLS !== '1') {
      return { name: input.name, hits: [], note: 'find_symbol disabled — use grep/repo_map (decision 7.4: ripgrep baseline 4.2s vs tree-sitter 5.8s, no gain)' } as const;
    }
    const files = await buildRepoMap({ cwd: ctx.cwd, maxFiles: 200 });
    const q = input.name.toLowerCase();
    const hits: Array<{ file: string; line: number; kind: string; name: string }> = [];
    for (const f of files) for (const s of f.symbols) if (s.name.toLowerCase().includes(q) && (!input.kind || s.kind === input.kind)) hits.push({ file: f.path, line: s.line, kind: s.kind, name: s.name });
    return { name: input.name, hits: hits.slice(0, 20) } as const;
  }),
});
