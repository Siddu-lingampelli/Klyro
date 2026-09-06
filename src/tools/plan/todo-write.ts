import { z } from 'zod';
import { defineTool } from '../types.js';
import { safe } from '../normalize.js';

const TodoSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done', 'failed', 'skipped']),
  files: z.array(z.string()).optional(),
});

const InputSchema = z.object({
  todos: z.array(TodoSchema),
});

export const todoWriteTool = defineTool({
  name: 'todo_write',
  description: 'Update the live plan checklist. Persisted and re-injected when stale.',
  inputSchema: InputSchema,
  permission: 'read',
  isConcurrencySafe: true,
  execute: async (input, ctx) => {
    return safe(async () => {
      // Persist to .klyro/plans/todos.json for 5.3
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const dir = path.join(ctx.cwd, '.klyro', 'plans');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'todos.json');
      await fs.writeFile(file, JSON.stringify(input.todos, null, 2), 'utf-8');
      return { updated: input.todos.length } as const;
    });
  },
});
