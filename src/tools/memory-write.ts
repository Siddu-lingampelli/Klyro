import { z } from 'zod';
import { defineTool } from './types.js';
import { safe } from './normalize.js';
import { memoryWrite } from '../context/memory.js';
export const memoryWriteTool = defineTool({
  name: 'memory_write',
  description: 'Write to .klyro/memory/session-notes.md (≤1k tokens injected, survives compaction)',
  inputSchema: z.object({ content: z.string().min(1) }),
  permission: 'edit',
  isConcurrencySafe: false,
  execute: async (input, ctx) => safe(async () => {
    const p = await memoryWrite(ctx.cwd, input.content);
    return { path: p, bytes: input.content.length } as const;
  }),
});
