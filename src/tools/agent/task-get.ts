/**
 * P1.3 — task_get tool (6-10fix.md §5). Read-only + concurrency-safe.
 * Returns one task's status and summary by id.
 */
import { z } from 'zod';
import { defineTool } from '../types.js';
import { toToolError } from '../normalize.js';

const InputSchema = z.object({
  taskId: z.string().min(1).describe('Task id (e.g. task_1)'),
});

export const taskGetTool = defineTool({
  name: 'task_get',
  description: "Return one child-agent task's status and summary by id.",
  inputSchema: InputSchema,
  permission: 'read',
  isConcurrencySafe: true,
  renderCall: (input) => `task_get(${input.taskId})`,
  execute: async (input, ctx) => {
    try {
      const bridge = ctx.agentBridge;
      if (!bridge) {
        return {
          ok: false as const,
          error: { code: 'NO_ORCHESTRATOR', message: 'task_get requires an active orchestrator' },
        };
      }
      const rec = bridge.getTask(input.taskId);
      if (!rec) {
        return {
          ok: false as const,
          error: { code: 'NOT_FOUND', message: `Unknown task: ${input.taskId}` },
        };
      }
      return { ok: true as const, value: rec };
    } catch (err) {
      return { ok: false as const, error: toToolError(err) };
    }
  },
});
