import { z } from 'zod';
import { defineTool } from './types.js';
import { safe } from './normalize.js';
import { expandResult } from '../context/lifecycle.js';
export const expandResultTool = defineTool({
  name: 'expand_result',
  description: 'Expand a previously truncated large result by id.',
  inputSchema: z.object({ id: z.string().min(1) }),
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input) => safe(async () => {
    const out = expandResult(input.id);
    if (out === null) return { id: input.id, output: null, note: 'not found or expired' } as const;
    return { id: input.id, output: out } as const;
  }),
});
