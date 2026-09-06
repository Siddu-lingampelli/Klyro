/**
 * 7.5 — LSP bridge stub (off by default, /lsp to enable)
 * Provides diagnostics / goto_definition when LS available, otherwise no-op.
 */
import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';

export const lspDiagnosticsTool = defineTool({
  name: 'lsp_diagnostics',
  description: 'LSP diagnostics (stub — off unless KLYRO_LSP=1)',
  inputSchema: z.object({ path: z.string().optional() }),
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => safe(async () => {
    if (process.env.KLYRO_LSP !== '1') return { enabled: false, diagnostics: [], note: 'LSP off — use /lsp to enable' } as const;
    // Real would spawn language server; stub returns empty
    return { enabled: true, diagnostics: [] } as const;
  }),
});
export const lspGotoDefinitionTool = defineTool({
  name: 'lsp_goto_definition',
  description: 'LSP goto_definition (stub)',
  inputSchema: z.object({ path: z.string().min(1), line: z.number().int().min(1), character: z.number().int().min(0).optional() }),
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input) => safe(async () => ({ enabled: process.env.KLYRO_LSP === '1', location: null, note: 'stub' } as const)),
});
