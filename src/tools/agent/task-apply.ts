/**
 * task_apply tool — merge a succeeded child's work into the parent tree.
 *
 * For worktree-isolated children this merges the `klyro/<taskId>` branch and
 * emits `subtask.merged`; for shared-cwd children (whose edits already
 * landed in the parent tree) it is the explicit acknowledgement step that
 * emits `subtask.merged` and returns the summary. Non-succeeded tasks error
 * with NOT_READY; conflicts error with MERGE_CONFLICT.
 */
import { z } from 'zod';
import { defineTool } from '../types.js';
import { toToolError } from '../normalize.js';
import type { ChildSummary } from '../../agent/orchestrator.js';

const InputSchema = z.object({
  taskId: z.string().min(1).describe('Succeeded task id to apply (e.g. task_1)'),
});

export const taskApplyTool = defineTool({
  name: 'task_apply',
  description:
    'Merge a succeeded child task into the parent tree (emits subtask.merged). Errors with NOT_READY unless the task succeeded.',
  inputSchema: InputSchema,
  permission: 'admin',
  isConcurrencySafe: false,
  renderCall: (input) => `task_apply(${input.taskId})`,
  execute: async (input, ctx): Promise<{ ok: true; value: ChildSummary } | { ok: false; error: { code: string; message: string; details?: unknown } }> => {
    try {
      const bridge = ctx.agentBridge;
      if (!bridge) {
        return {
          ok: false as const,
          error: { code: 'NO_ORCHESTRATOR', message: 'task_apply requires an active orchestrator' },
        };
      }
      if (!bridge.applyTask) {
        return {
          ok: false as const,
          error: { code: 'UNSUPPORTED', message: 'task_apply is not supported by this orchestrator bridge' },
        };
      }
      return await bridge.applyTask(input.taskId);
    } catch (err) {
      return { ok: false as const, error: toToolError(err) };
    }
  },
});
