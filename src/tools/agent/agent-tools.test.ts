/**
 * P1 tool tests (6-10fix.md §8): spawn_agent / task_list / task_get
 * return read-only snapshots and require an active orchestrator bridge.
 * Plus P2: task_wait / task_stop / task_apply delegation (incl. timeout and
 * stop-while-running) and orchestrator spawn budgets (CONCURRENCY_LIMIT).
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { builtinRegistry } from '../registry.js';
import { spawnAgentTool } from './spawn-agent.js';
import { taskListTool } from './task-list.js';
import { taskGetTool } from './task-get.js';
import { taskWaitTool } from './task-wait.js';
import { taskStopTool } from './task-stop.js';
import { taskApplyTool } from './task-apply.js';
import type { ToolContext } from '../types.js';
import { AgentOrchestrator, type AgentSpawnBridge, type ParentContextRef } from '../../agent/orchestrator.js';
import { globalBus } from '../../events/bus.js';
import type { RuntimeDeps } from '../../agent/runtime.js';

const baseCtx: ToolContext = { cwd: process.cwd(), env: {} };

function fakeBridge(overrides: Partial<AgentSpawnBridge> = {}): AgentSpawnBridge {
  return {
    parent: { sessionId: 'sess', cwd: process.cwd(), depth: 0, maxDepth: 1, allowedTools: null },
    spawnAgent: async () => ({ ok: true, value: { taskId: 'task_1', agentName: 'explorer', status: 'succeeded', durationMs: 1, changedFiles: [] } }),
    listAgents: () => [],
    getAgent: () => undefined,
    listTasks: () => [],
    getTask: () => undefined,
    drainCompletions: () => [],
    waitForTasks: async (taskIds: string[]) => ({
      tasks: taskIds.map((taskId) => ({
        taskId,
        status: 'succeeded' as const,
        summary: { taskId, agentName: 'explorer', status: 'succeeded' as const, durationMs: 1, changedFiles: [] },
      })),
    }),
    cancelTask: (taskId: string) => ({ ok: true as const, value: { taskId, status: 'cancelled' as const } }),
    applyTask: async (taskId: string) => ({
      ok: true as const,
      value: { taskId, agentName: 'implementer', status: 'succeeded' as const, durationMs: 1, changedFiles: [] },
    }),
    ...overrides,
  };
}

describe('agent tools', () => {
  it('registers spawn_agent, task_list, task_get, task_wait, task_stop, task_apply in builtinRegistry', () => {
    const names = new Set(builtinRegistry().list().map((t) => t.name));
    for (const n of ['spawn_agent', 'task_list', 'task_get', 'task_wait', 'task_stop', 'task_apply']) {
      expect(names.has(n)).toBe(true);
    }
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

describe('task_wait / task_stop / task_apply tools', () => {
  it('each returns NO_ORCHESTRATOR without a bridge', async () => {
    for (const r of [
      await taskWaitTool.execute({ taskIds: ['task_1'] }, baseCtx),
      await taskStopTool.execute({ taskId: 'task_1' }, baseCtx),
      await taskApplyTool.execute({ taskId: 'task_1' }, baseCtx),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('NO_ORCHESTRATOR');
    }
  });

  it('task_wait delegates to bridge.waitForTasks', async () => {
    const bridge = fakeBridge();
    const r = await taskWaitTool.execute({ taskIds: ['task_1', 'task_2'] }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tasks).toHaveLength(2);
      expect(r.value.tasks[0]?.status).toBe('succeeded');
    }
  });

  it('task_wait surfaces timeout entries as running (task NOT cancelled)', async () => {
    const bridge = fakeBridge({
      waitForTasks: async (taskIds: string[]) => ({
        tasks: taskIds.map((taskId) => ({
          taskId,
          status: 'running' as const,
          summary: { taskId, agentName: 'explorer', status: 'running' as const, durationMs: 0, changedFiles: [] },
        })),
      }),
    });
    const r = await taskWaitTool.execute({ taskIds: ['task_1'], timeoutMs: 50 }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tasks[0]?.status).toBe('running');
  });

  it('task_wait falls back to polling getTask when the bridge lacks waitForTasks', async () => {
    const bridge = fakeBridge({ waitForTasks: undefined });
    bridge.getTask = () => ({ id: 'task_1', agentName: 'explorer', sessionId: 'sess', status: 'running', cwd: '/tmp', depth: 1 });
    const r = await taskWaitTool.execute({ taskIds: ['task_1'], timeoutMs: 30 }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tasks[0]?.status).toBe('running');
  });

  it('task_wait fallback resolves immediately for terminal tasks', async () => {
    const bridge = fakeBridge({ waitForTasks: undefined });
    bridge.getTask = (id: string) => ({ id, agentName: 'explorer', sessionId: 'sess', status: 'succeeded', cwd: '/tmp', depth: 1 });
    const r = await taskWaitTool.execute({ taskIds: ['task_1'] }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tasks[0]?.status).toBe('succeeded');
  });

  it('task_stop cancels a running task via the bridge', async () => {
    const seen: string[] = [];
    const bridge = fakeBridge({
      getTask: (id: string) => ({ id, agentName: 'implementer', sessionId: 'sess', status: 'running', cwd: '/tmp', depth: 1 }),
      cancelTask: (taskId: string) => {
        seen.push(taskId);
        return { ok: true as const, value: { taskId, status: 'cancelled' as const } };
      },
    });
    const r = await taskStopTool.execute({ taskId: 'task_7' }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ taskId: 'task_7', status: 'cancelled' });
      expect(seen).toEqual(['task_7']);
    }
  });

  it('task_stop returns UNSUPPORTED when the bridge lacks cancelTask', async () => {
    const bridge = fakeBridge({ cancelTask: undefined });
    const r = await taskStopTool.execute({ taskId: 'task_1' }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNSUPPORTED');
  });

  it('task_apply returns the merged summary', async () => {
    const bridge = fakeBridge();
    const r = await taskApplyTool.execute({ taskId: 'task_1' }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.taskId).toBe('task_1');
      expect(r.value.status).toBe('succeeded');
    }
  });

  it('task_apply surfaces NOT_READY for non-succeeded tasks', async () => {
    const bridge = fakeBridge({
      applyTask: async (taskId: string) => ({
        ok: false as const,
        error: { code: 'NOT_READY', message: `task ${taskId} is running, not succeeded` },
      }),
    });
    const r = await taskApplyTool.execute({ taskId: 'task_1' }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_READY');
  });

  it('task_apply returns UNSUPPORTED when the bridge lacks applyTask', async () => {
    const bridge = fakeBridge({ applyTask: undefined });
    const r = await taskApplyTool.execute({ taskId: 'task_1' }, { ...baseCtx, agentBridge: bridge });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNSUPPORTED');
  });
});

describe('orchestrator spawn budgets and guards', () => {
  const stubDeps = (toolNames: string[] = []): RuntimeDeps =>
    ({ registry: { list: () => toolNames.map((name) => ({ name })) } }) as unknown as RuntimeDeps;

  const parent = (overrides: Partial<ParentContextRef> = {}): ParentContextRef => ({
    sessionId: 'sess',
    cwd: process.cwd(),
    depth: 0,
    maxDepth: 2,
    allowedTools: null,
    ...overrides,
  });

  it('RECURSION_LIMIT pre-check creates no task', async () => {
    const orch = new AgentOrchestrator({ sessionId: 'sess', deps: stubDeps() });
    const before = orch.taskManager.list().length;
    const r = await orch.spawnAgent({ agent: 'explorer', task: 'deep' }, parent({ depth: 2, maxDepth: 2 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RECURSION_LIMIT');
    expect(orch.taskManager.list()).toHaveLength(before);
  });

  it('PATH_ESCAPE rejects a cwd outside the parent', async () => {
    const orch = new AgentOrchestrator({ sessionId: 'sess', deps: stubDeps() });
    const r = await orch.spawnAgent(
      { agent: 'explorer', task: 'x', cwd: path.join(process.cwd(), '..', 'klyro-escape-xyz') },
      parent(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PATH_ESCAPE');
  });

  it('WRITES_REQUIRE_GIT rejects write-capable spawns outside a git repo', async () => {
    // Hermit dir under the drive root: os.tmpdir() may sit under a repo
    // ancestor (8.3 aliases defeat ceiling matching), so tmpdir is unusable
    // for "not a repo" hermeticity.
    const dir = await fs.mkdtemp(path.join(path.parse(process.cwd()).root, 'klyro-norepo-'));
    try {
      const tools = ['read_file', 'list_directory', 'glob', 'grep', 'search_files', 'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'shell_exec', 'git_status', 'git_log', 'git_diff', 'run_verify', 'todo_write'];
      const orch = new AgentOrchestrator({ sessionId: 'sess', deps: stubDeps(tools) });
      const r = await orch.spawnAgent({ agent: 'implementer', task: 'x' }, parent({ cwd: dir }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('WRITES_REQUIRE_GIT');
      // Rejected pre-worktree: no task may have been created.
      expect(orch.taskManager.list()).toHaveLength(0);
    } finally {
      for (let i = 0; i < 5; i++) {
        try {
          await fs.rm(dir, { recursive: true, force: true });
          break;
        } catch {
          if (i === 4) throw new Error(`cleanup failed for ${dir}`);
          await new Promise((r) => setTimeout(r, 100 * (i + 1)));
        }
      }
    }
  });

  it('CONCURRENCY_LIMIT at maxConcurrentTasks creates no task', async () => {
    const orch = new AgentOrchestrator({ sessionId: 'sess', deps: stubDeps() });
    for (let i = 0; i < 4; i++) orch.taskManager.create({ agentName: 'explorer', cwd: '/tmp', depth: 1, maxDepth: 2 });
    const before = orch.taskManager.list().length;
    const r = await orch.spawnAgent({ agent: 'explorer', task: 'x' }, parent());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONCURRENCY_LIMIT');
    expect(orch.taskManager.list()).toHaveLength(before);
  });

  it('CONCURRENCY_LIMIT at maxTasksPerParent creates no task', async () => {
    const orch = new AgentOrchestrator({ sessionId: 'sess', deps: stubDeps() });
    for (let i = 0; i < 8; i++) {
      orch.taskManager.create({ agentName: 'explorer', cwd: '/tmp', depth: 1, maxDepth: 2, parentTaskId: 'task_p', autoStart: false });
    }
    const before = orch.taskManager.list().length;
    const r = await orch.spawnAgent({ agent: 'explorer', task: 'x' }, parent({ taskId: 'task_p' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONCURRENCY_LIMIT');
    expect(orch.taskManager.list()).toHaveLength(before);
  });

  it('CONCURRENCY_LIMIT at maxTotalTasksPerSession creates no task', async () => {
    const orch = new AgentOrchestrator({ sessionId: 'sess', deps: stubDeps() });
    for (let i = 0; i < 32; i++) {
      orch.taskManager.create({ agentName: 'explorer', cwd: '/tmp', depth: 1, maxDepth: 2, parentTaskId: `other_${i}`, autoStart: false });
    }
    const before = orch.taskManager.list().length;
    const r = await orch.spawnAgent({ agent: 'explorer', task: 'x' }, parent());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CONCURRENCY_LIMIT');
    expect(orch.taskManager.list()).toHaveLength(before);
  });

  it('applyTask on a shared-cwd task emits subtask.merged with merged:false', async () => {
    const orch = new AgentOrchestrator({ sessionId: 'sess', deps: stubDeps() });
    const rec = orch.taskManager.create({ agentName: 'explorer', cwd: '/tmp', depth: 1, maxDepth: 2 });
    orch.taskManager.finish(rec.id, 'succeeded');
    const r = await orch.applyTask(rec.id);
    expect(r.ok).toBe(true);
    const merged = globalBus.getHistory().filter((e) => e.type === 'subtask.merged' && e.taskId === rec.id);
    expect(merged).toHaveLength(1);
    const ev = merged[0]!;
    expect(ev.type).toBe('subtask.merged');
    if (ev.type === 'subtask.merged') expect(ev.merged).toBe(false);
  });

  it('cancelTask/applyTask/drainCompletions handle unknown/empty state', async () => {
    const orch = new AgentOrchestrator({ sessionId: 'sess', deps: stubDeps() });
    expect(orch.drainCompletions()).toEqual([]);
    const c = orch.cancelTask('task_9');
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error.code).toBe('NOT_FOUND');
    const a = await orch.applyTask('task_9');
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe('NOT_FOUND');
  });
});
