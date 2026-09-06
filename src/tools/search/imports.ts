import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';
import { importsOf, importersOf } from '../../context/import-graph.js';

export const importsOfTool = defineTool({
  name: 'imports_of',
  description: 'List files imported by this file (cached import graph).',
  inputSchema: z.object({ path: z.string().min(1) }),
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => safe(async () => ({ file: input.path, imports: await importsOf(ctx.cwd, input.path) } as const)),
});
export const importersOfTool = defineTool({
  name: 'importers_of',
  description: 'List files that import this file (reverse graph). Powers L6 scoped tests.',
  inputSchema: z.object({ path: z.string().min(1) }),
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => safe(async () => ({ file: input.path, importers: await importersOf(ctx.cwd, input.path) } as const)),
});
