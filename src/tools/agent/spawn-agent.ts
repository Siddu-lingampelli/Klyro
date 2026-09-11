/**
 * P1.1 — spawn_agent tool (6-10fix.md §5).
 *
 * Async: starts the child worker and returns IMMEDIATELY with
 * `{ taskId, status: 'running', ... }` — never the child transcript.
 * Await completion with `task_wait`, poll with `task_get` / `task_list`,
 * merge the child's worktree with `task_apply`, or abort with `task_stop`.
 */
import { z } from 'zod';
import { defineTool } from '../types.js';
import { toToolError } from '../normalize.js';
import type { ChildSummary } from '../../agent/orchestrator.js';

const InputSchema = z.object({
  agent: z.string().min(1).describe('Agent id (e.g. explorer, implementer, tester, reviewer)'),
  task: z.string().min(1).describe('Task brief for the child agent'),
  cwd: z.string().optional().describe('Working directory override (defaults to parent cwd)'),
  model: z.string().optional().describe('Model override for the child (must be honoured or error)'),
  timeoutMs: z.number().int().positive().optional().describe('Child runtime timeout in ms'),
});

export const spawnAgentTool = defineTool({
  name: 'spawn_agent',
  description:
    'Spawn a child agent asynchronously; returns immediately with { taskId, status: "running", ... }. Child transcript stays separate — await it with task_wait, poll with task_get, merge with task_apply, abort with task_stop.',
  inputSchema: InputSchema,
  permission: 'admin',
  isConcurrencySafe: false,
  renderCall: (input) => `spawn_agent(${input.agent}): ${input.task.slice(0, 80)}`,
  execute: async (input, ctx) => {
    try {
      const bridge = ctx.agentBridge;
      if (!bridge) {
        return {
          ok: false as const,
          error: {
            code: 'NO_ORCHESTRATOR',
            message: 'spawn_agent requires an active orchestrator (run with --agent or via a parent agent)',
          },
        };
      }
      return await bridge.spawnAgent({
        agent: input.agent,
        task: input.task,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
    } catch (err) {
      return { ok: false as const, error: toToolError(err) };
    }
  },
});

export type SpawnAgentOutput = ChildSummary;
