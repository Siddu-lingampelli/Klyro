/**
 * task_wait tool — await one or more child tasks without cancelling them.
 *
 * Delegates to `AgentSpawnBridge.waitForTasks` when available, otherwise
 * polls `getTask` until every id is terminal or `timeoutMs` elapses.
 * Entries that do not settle in time come back with status `'running'` —
 * the underlying task keeps running. Documented contract: waiting never
 * cancels.
 */
import { z } from 'zod';
import { defineTool } from '../types.js';
import { toToolError } from '../normalize.js';
import type { ChildSummary } from '../../agent/orchestrator.js';
import type { TaskStatus } from '../../agent/task-manager.js';

const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'blocked',
]);

const InputSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).describe('Task ids to await (e.g. ["task_1"])'),
  timeoutMs: z.number().int().positive().optional().describe('Per-task wait timeout in ms (unset = wait indefinitely)'),
});

export interface WaitTaskEntry {
  taskId: string;
  status: TaskStatus;
  summary?: ChildSummary;
  error?: { code: string; message: string };
}

export const taskWaitTool = defineTool({
  name: 'task_wait',
  description:
    'Await child-agent tasks until they settle. Entries that time out return status "running" — the task is NOT cancelled. Never cancels.',
  inputSchema: InputSchema,
  permission: 'read',
  isConcurrencySafe: true,
  renderCall: (input) => `task_wait(${input.taskIds.join(', ')})`,
  execute: async (input, ctx) => {
    try {
      const bridge = ctx.agentBridge;
      if (!bridge) {
        return {
          ok: false as const,
          error: { code: 'NO_ORCHESTRATOR', message: 'task_wait requires an active orchestrator' },
        };
      }
      if (bridge.waitForTasks) {
        const r = await bridge.waitForTasks(input.taskIds, input.timeoutMs);
        return { ok: true as const, value: r };
      }
      // Fallback for bridges without waitForTasks: poll getTask snapshots.
      const deadline = input.timeoutMs !== undefined ? Date.now() + input.timeoutMs : undefined;
      const tasks: WaitTaskEntry[] = [];
      for (const taskId of input.taskIds) {
        let snap = bridge.getTask(taskId);
        if (!snap) {
          tasks.push({ taskId, status: 'failed', error: { code: 'NOT_FOUND', message: `Unknown task: ${taskId}` } });
          continue;
        }
        while (!TERMINAL.has(snap.status) && (deadline === undefined || Date.now() < deadline)) {
          await new Promise((r) => setTimeout(r, 10));
          const next = bridge.getTask(taskId);
          if (next) snap = next;
        }
        tasks.push({
          taskId,
          status: snap.status,
          summary: {
            taskId: snap.id,
            agentName: snap.agentName,
            status: snap.status,
            durationMs: snap.durationMs ?? 0,
            changedFiles: [],
            ...(snap.error ? { error: { code: snap.error.code, message: snap.error.message } } : {}),
          },
          ...(snap.error ? { error: { code: snap.error.code, message: snap.error.message } } : {}),
        });
      }
      return { ok: true as const, value: { tasks } };
    } catch (err) {
      return { ok: false as const, error: toToolError(err) };
    }
  },
});
