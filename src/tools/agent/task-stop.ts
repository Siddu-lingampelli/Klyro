/**
 * task_stop tool — cancel a running child task via `taskManager.cancel`.
 * Idempotent on terminal tasks (returns the current status).
 */
import { z } from 'zod';
import { defineTool } from '../types.js';
import { toToolError } from '../normalize.js';

const InputSchema = z.object({
  taskId: z.string().min(1).describe('Task id to stop (e.g. task_1)'),
});

export const taskStopTool = defineTool({
  name: 'task_stop',
  description: 'Cancel a running child-agent task. Returns { taskId, status }. Idempotent on terminal tasks.',
  inputSchema: InputSchema,
  permission: 'admin',
  isConcurrencySafe: false,
  renderCall: (input) => `task_stop(${input.taskId})`,
  execute: async (input, ctx) => {
    try {
      const bridge = ctx.agentBridge;
      if (!bridge) {
        return {
          ok: false as const,
          error: { code: 'NO_ORCHESTRATOR', message: 'task_stop requires an active orchestrator' },
        };
      }
      if (!bridge.cancelTask) {
        return {
          ok: false as const,
          error: { code: 'UNSUPPORTED', message: 'task_stop is not supported by this orchestrator bridge' },
        };
      }
      return bridge.cancelTask(input.taskId);
    } catch (err) {
      return { ok: false as const, error: toToolError(err) };
    }
  },
});
