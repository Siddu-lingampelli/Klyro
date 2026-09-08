/**
 * P1 tool tests (6-10fix.md §8): spawn_agent / task_list / task_get
 * return read-only snapshots and require an active orchestrator bridge.
 */
import { describe, it, expect } from 'vitest';
import { builtinRegistry } from '../registry.js';
import { spawnAgentTool } from './spawn-agent.js';
import { taskListTool } from './task-list.js';
import { taskGetTool } from './task-get.js';
import type { ToolContext } from '../types.js';
import type { AgentSpawnBridge } from '../../agent/orchestrator.js';

const baseCtx: ToolContext = { cwd: process.cwd(), env: {} };

function fakeBridge(overrides: Partial<AgentSpawnBridge> = {}): AgentSpawnBridge {
  return {
    parent: { sessionId: 'sess', cwd: process.cwd(), depth: 0, maxDepth: 1, allowedTools: null },
    spawnAgent: async () => ({ ok: true, value: { taskId: 'task_1', agentName: 'explorer', status: 'succeeded', durationMs: 1, changedFiles: [] } }),
    listAgents: () => [],
    getAgent: () => undefined,
    listTasks: () => [],
    getTask: () => undefined,
    ...overrides,
  };
}

describe('agent tools', () => {
  it('registers spawn_agent, task_list, task_get in builtinRegistry', () => {
    const names = new Set(builtinRegistry().list().map((t) => t.name));
    expect(names.has('spawn_agent')).toBe(true);
    expect(names.has('task_list')).toBe(true);
    expect(names.has('task_get')).toBe(true);
  });

  it('spawn_agent without a bridge returns NO_ORCHESTRATOR', async () => {
    const r = await spawnAgentTool.execute({ agent: 'explorer', task: 'map repo' }, baseCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NO_ORCHESTRATOR');
  });

  it('spawn_agent delegates to the bridge and returns the ChildSummary', async () => {
    const bridge = fakeBridge();
    const r = await spawnAgentTool.execute({ agent: 'explorer', task: 'map repo' }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.taskId).toBe('task_1');
  });

  it('spawn_agent surfaces bridge errors (e.g. UNKNOWN_AGENT)', async () => {
    const bridge = fakeBridge({
      spawnAgent: async () => ({ ok: false, error: { code: 'UNKNOWN_AGENT', message: 'Unknown agent: nope' } }),
    });
    const r = await spawnAgentTool.execute({ agent: 'nope', task: 'x' }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNKNOWN_AGENT');
  });

  it('task_list without a bridge returns NO_ORCHESTRATOR', async () => {
    const r = await taskListTool.execute({}, baseCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NO_ORCHESTRATOR');
  });

  it('task_list returns bridge snapshots', async () => {
    const bridge = fakeBridge({
      listTasks: () => [{ id: 'task_1', agentName: 'explorer', sessionId: 'sess', status: 'succeeded', cwd: '/tmp', depth: 1 }],
    });
    const r = await taskListTool.execute({}, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(1);
  });

  it('task_get returns NOT_FOUND for unknown ids', async () => {
    const bridge = fakeBridge({ getTask: () => undefined });
    const r = await taskGetTool.execute({ taskId: 'task_9' }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('task_get returns the task snapshot', async () => {
    const bridge = fakeBridge({
      getTask: (id: string) => ({ id, agentName: 'tester', sessionId: 'sess', status: 'running', cwd: '/tmp', depth: 1 }),
    });
    const r = await taskGetTool.execute({ taskId: 'task_1' }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe('task_1');
  });
});
