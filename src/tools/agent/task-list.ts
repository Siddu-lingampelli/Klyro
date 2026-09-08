/**
 * P1.2 — task_list tool (6-10fix.md §5). Read-only + concurrency-safe.
 * Returns TaskSummary[] snapshots from the orchestrator's TaskManager.
 */
import { z } from 'zod';
import { defineTool } from '../types.js';
import { toToolError } from '../normalize.js';

const InputSchema = z.object({
  parentTaskId: z.string().optional().describe('Filter by parent task id'),
  status: z
    .enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'blocked'])
    .optional()
    .describe('Filter by status'),
});

export const taskListTool = defineTool({
  name: 'task_list',
  description: 'List child-agent tasks (running and completed) with status summaries.',
  inputSchema: InputSchema,
  permission: 'read',
  isConcurrencySafe: true,
  renderCall: () => 'task_list',
  execute: async (input, ctx) => {
    try {
      const bridge = ctx.agentBridge;
      if (!bridge) {
        return {
          ok: false as const,
          error: { code: 'NO_ORCHESTRATOR', message: 'task_list requires an active orchestrator' },
        };
      }
      const tasks = bridge.listTasks({
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
        ...(input.status ? { status: input.status } : {}),
      });
      return { ok: true as const, value: tasks };
    } catch (err) {
      return { ok: false as const, error: toToolError(err) };
    }
  },
});
