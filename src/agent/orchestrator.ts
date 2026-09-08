/**
 * AgentOrchestrator — spawns child agents and turns them into tasks.
 *
 * The lowest-level way to run Klyro is `run(options, deps)` (one agent,
 * one loop). Orchestration layers on top of that: a parent agent calls
 * `spawn_agent`, which resolves the target `AgentDefinition`, computes its
 * effective capabilities (via `resolveCapabilities`), creates a
 * `TaskRecord`, and runs a *scoped* child loop. The child runs in-process
 * with a `ScopedRegistry` (narrowed tool set), an optional model override,
 * a depth cap, and an AbortController wired to the parent's signal.
 *
 * The compact result is a `ChildSummary` — a `ToolResult` the parent model
 * can act on — never the full child transcript.
 */

import type { ProviderAdapter } from './provider-adapter.js';
import type { RuntimeDeps, RunOptions, RunResult } from './runtime.js';
import type { ToolResult } from '../tools/types.js';
import { run } from './runtime.js';
import { ScopedRegistry } from './scoped-registry.js';
import { globalBus } from '../events/bus.js';
import { TaskManager, type CreateTaskOpts, type TaskRecord, type TaskStatus, type TaskSummary } from './task-manager.js';
import { WorkerSpawner } from './worker-spawner.js';
import {
  resolveCapabilities,
  DEFAULT_WRITE_TOOLS,
  DEFAULT_SPAWN_TOOLS,
  DEFAULT_DENIED_TOOLS,
  type DropReason,
  type ResolveToolsInput,
} from './capabilities.js';

/** An agent a model can delegate to via `spawn_agent`. */
export interface AgentDefinition {
  id: string;
  description: string;
  /** Explicit allow-list. Undefined means "inherit every tool the parent has". */
  allowedTools?: string[];
  readonly?: boolean;
  /** Children cannot spawn further agents unless explicitly enabled. */
  canSpawn?: boolean;
  /** Per-agent model override. Must be honoured (or surfaced as an error). */
  model?: string;
  maxDepth?: number;
  maxSteps?: number;
  maxCost?: number;
  maxTimeMs?: number;
}

/** Default agents a model can delegate to. */
export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  {
    id: 'explorer',
    description: 'Read-only reconnaissance: map the repo, find symbols and tests.',
    readonly: true,
    canSpawn: false,
    allowedTools: ['read_file', 'list_dir', 'glob', 'grep', 'search_files', 'repo_map', 'find_symbol', 'git_status', 'git_log', 'git_diff', 'recent_files', 'imports_of', 'importers_of'],
  },
  {
    id: 'implementer',
    description: 'Write-capable worker for concrete, well-scoped coding tasks.',
    canSpawn: false,
    allowedTools: ['read_file', 'list_dir', 'glob', 'grep', 'search_files', 'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'shell_exec', 'git_status', 'git_log', 'git_diff', 'run_verify', 'todo_write'],
    maxSteps: 60,
  },
  {
    id: 'tester',
    description: 'Runs verification and tests, reports failures with diagnostics.',
    canSpawn: false,
    allowedTools: ['read_file', 'list_dir', 'glob', 'grep', 'shell_exec', 'run_verify', 'git_status', 'git_log', 'git_diff'],
    maxTimeMs: 120_000,
  },
  {
    id: 'reviewer',
    description: 'Read-only review of a diff or change set for bugs.',
    readonly: true,
    canSpawn: false,
    allowedTools: ['read_file', 'list_dir', 'glob', 'grep', 'search_files', 'git_status', 'git_diff', 'git_log', 'imports_of', 'importers_of', 'find_symbol'],
  },
];

/** Compact summary returned to the parent — the child's transcript stays separate. */
export interface ChildSummary {
  taskId: string;
  agentName: string;
  status: TaskStatus;
  durationMs: number;
  finalText?: string;
  changedFiles: string[];
  usage?: { input: number; output: number; estimated?: boolean };
  error?: { code: string; message: string };
  /** Tool drops from capability resolution, surfaced for parent visibility. */
  droppedTools?: { tool: string; reason: DropReason }[];
}

/** Capability context the bridge passes when the parent calls spawn_agent. */
export interface ParentContextRef {
  taskId?: string;
  parentTaskId?: string;
  sessionId: string;
  cwd: string;
  depth: number;
  maxDepth: number;
  allowedTools: ReadonlySet<string> | null;
  model?: string;
}

/** Interface exposed to the runtime/tools for a child spawn request. */
export interface AgentSpawnBridge {
  parent: ParentContextRef;
  spawnAgent(input: { agent: string; task: string; cwd?: string; model?: string; timeoutMs?: number }): Promise<ToolResult<ChildSummary>>;
  listAgents(): AgentDefinition[];
  getAgent(id: string): AgentDefinition | undefined;
  listTasks(filter?: { parentTaskId?: string; status?: TaskStatus }): TaskSummary[];
  getTask(id: string): TaskSummary & { error?: { code: string; message: string } } | undefined;
}

/** Constructor options for the orchestrator — the parent runtime's deps. */
export interface OrchestratorOpts {
  sessionId: string;
  deps: RuntimeDeps;
  taskManager?: TaskManager;
  workerSpawner?: WorkerSpawner;
}

/** Map a runtime `RunResult.status` to a task status. */
function mapResultStatus(status: RunResult['status']): 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'blocked' {
  switch (status) {
    case 'complete':
      return 'succeeded';
    case 'aborted':
      return 'cancelled';
    case 'blocked':
      return 'blocked';
    case 'max_steps':
    case 'no_final':
    case 'verify_failed':
    case 'limit':
    case 'stuck':
      return 'failed';
  }
}

export class AgentOrchestrator {
  readonly sessionId: string;
  readonly deps: RuntimeDeps;
  readonly taskManager: TaskManager;
  readonly workerSpawner: WorkerSpawner;

  constructor(opts: OrchestratorOpts) {
    this.sessionId = opts.sessionId;
    this.deps = opts.deps;
    this.taskManager = opts.taskManager ?? new TaskManager({ sessionId: opts.sessionId });
    this.workerSpawner = opts.workerSpawner ?? new WorkerSpawner();
  }

  listAgents(): AgentDefinition[] {
    return [...BUILTIN_AGENTS];
  }

  getAgent(id: string): AgentDefinition | undefined {
    return BUILTIN_AGENTS.find((a) => a.id === id);
  }

  /** Build the bridge the parent's runtime hands to tools. */
  bridgeFor(parent: ParentContextRef): AgentSpawnBridge {
    return {
      parent,
      listAgents: () => this.listAgents(),
      getAgent: (id) => this.getAgent(id),
      spawnAgent: (input) => this.spawnAgent(input, parent),
      listTasks: (filter) => this.taskManager.list(filter),
      getTask: (id) => {
        const r = this.taskManager.get(id);
        if (!r) return undefined;
        const s = this.taskManager.toSummary(r);
        return r.error ? { ...s, error: { code: r.error.code, message: r.error.message } } : s;
      },
    };
  }

  /** Compute a child's effective capabilities from the parent's own. */
  private resolveChild(
    def: AgentDefinition,
    parent: ParentContextRef,
    registryTools: ReadonlySet<string>,
  ): { allowed: ReadonlySet<string>; dropped: { tool: string; reason: DropReason }[]; model?: string; maxDepth: number; readonly: boolean; canSpawn: boolean } {
    const input: ResolveToolsInput = {
      parentTools: parent.allowedTools,
      agent: def,
      policyAllowed: registryTools,
      registryTools,
      writeTools: DEFAULT_WRITE_TOOLS,
      spawnTools: DEFAULT_SPAWN_TOOLS,
      denied: DEFAULT_DENIED_TOOLS,
    };
    const resolved = resolveCapabilities({ ...input, maxDepth: parent.maxDepth });
    return resolved;
  }

  /**
   * Spawn a child agent for a given capability context, await its run, and
   * return a compact summary. Blocks until the child settles (P0 scope;
   * async task_wait arrives in a later slice).
   */
  async spawnAgent(
    input: { agent: string; task: string; cwd?: string; model?: string; timeoutMs?: number },
    parent: ParentContextRef,
  ): Promise<ToolResult<ChildSummary>> {
    const def = this.getAgent(input.agent);
    if (!def) {
      return {
        ok: false,
        error: { code: 'UNKNOWN_AGENT', message: `Unknown agent: ${input.agent}` },
      };
    }

    // Depth guard — block before creating a (running) task.
    const childDepth = parent.depth + 1;
    const maxDepth = def.maxDepth ?? parent.maxDepth;
    if (childDepth > maxDepth) {
      return {
        ok: false,
        error: {
          code: 'RECURSION_LIMIT',
          message: `maxDepth exceeded for agent "${def.id}": cannot spawn at depth ${childDepth} (cap ${maxDepth})`,
        },
      };
    }

    const registryTools = new Set(this.deps.registry.list().map((t) => t.name));
    const resolved = this.resolveChild(def, parent, registryTools);
    const childModel = input.model ?? resolved.model ?? parent.model;

    const childCwd = input.cwd ?? parent.cwd;
    const createOpts: CreateTaskOpts = {
      agentName: def.id,
      cwd: childCwd,
      depth: childDepth,
      maxDepth,
      model: childModel,
      parentTaskId: parent.taskId,
      timeoutMs: input.timeoutMs ?? def.maxTimeMs,
      abortOnParent: undefined, // wired below via the parent signal
    };
    const record = this.taskManager.create(createOpts);

    const childRegistry = new ScopedRegistry(this.deps.registry, resolved.allowed);
    const childDeps: RuntimeDeps = { ...this.deps, registry: childRegistry };

    const childOptions: RunOptions = {
      task: input.task,
      cwd: childCwd,
      model: childModel ?? 'inherit', // model override must reach the adapter (see runtime)
      maxSteps: def.maxSteps,
      maxCost: def.maxCost,
      maxTimeMs: def.maxTimeMs ?? input.timeoutMs,
      signal: record.abortController.signal,
      nonInteractive: true,
    };

    // Lifecycle events on the shared bus (mirror TaskManager transitions).
    globalBus.emit({
      type: 'subtask.started',
      ts: Date.now(),
      sessionId: this.sessionId,
      taskId: record.id,
      ...(record.parentTaskId ? { parentTaskId: record.parentTaskId } : {}),
      agentName: def.id,
      depth: childDepth,
      ...(typeof childModel === 'string' ? { model: childModel } : {}),
    });

    const handle = this.workerSpawner.spawn(async () => {
      let result: RunResult;
      try {
        result = await run(childOptions, childDeps);
      } catch (err) {
        this.taskManager.finish(record.id, 'failed', {
          error: { code: 'CHILD_CRASH', message: err instanceof Error ? err.message : String(err) },
        });
        return;
      }
      const status = mapResultStatus(result.status);
      if (status === 'cancelled') {
        this.taskManager.cancel(record.id, 'parent aborted');
      } else {
        this.taskManager.finish(record.id, status, {
          summary: [`status: ${status}`, `steps: ${result.steps}`, `toolCalls: ${result.toolCalls}`],
          error:
            status === 'failed'
              ? { code: mapFailureCode(result.status), message: result.finalText?.slice(0, 300) ?? 'child failed' }
              : undefined,
        });
      }
      const final = this.taskManager.get(record.id)!;
      const durationMs = final.finishedAt ? final.finishedAt - final.startedAt : 0;
      if (status === 'succeeded') {
        globalBus.emit({
          type: 'subtask.completed',
          ts: Date.now(),
          sessionId: this.sessionId,
          taskId: record.id,
          status: 'succeeded',
          durationMs,
          steps: result?.steps ?? 0,
          toolCalls: result?.toolCalls ?? 0,
        });
      } else {
        globalBus.emit({
          type: 'subtask.failed',
          ts: Date.now(),
          sessionId: this.sessionId,
          taskId: record.id,
          status: status as 'failed' | 'cancelled' | 'timed_out' | 'blocked',
          durationMs,
          error: final.error ? { code: final.error.code, message: final.error.message } : undefined,
        });
      }
    }, { label: `agent:${def.id}` });

    await handle.done.catch(() => undefined);
    const finalRecord = this.taskManager.get(record.id);
    if (!finalRecord) {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: `task ${record.id} missing after child run` },
      };
    }
    return { ok: true, value: this.toChildSummary(finalRecord, def, resolved.dropped) };
  }

  private toChildSummary(
    r: TaskRecord,
    def: AgentDefinition,
    dropped: { tool: string; reason: DropReason }[],
  ): ChildSummary {
    const s: TaskSummary = this.taskManager.toSummary(r);
    return {
      taskId: s.id,
      agentName: s.agentName,
      status: s.status,
      durationMs: s.durationMs ?? 0,
      ...(def.model ? { model: def.model } : {}),
      changedFiles: r.summary.filter((line) => line.startsWith('changed: ')).map((line) => line.slice('changed: '.length)),
      droppedTools: dropped.length ? dropped : undefined,
      error: r.error ? { code: r.error.code, message: r.error.message } : undefined,
    };
  }
}

function mapFailureCode(status: RunResult['status']): string {
  switch (status) {
    case 'max_steps':
      return 'MAX_STEPS';
    case 'verify_failed':
      return 'VERIFY_FAILED';
    case 'limit':
      return 'LIMIT';
    case 'stuck':
      return 'STUCK';
    case 'no_final':
    default:
      return 'NO_FINAL';
  }
}

/** Module-scoped holder the orchestrator sets so children inherit the parent's signal. */
export const parentAbortSignalRef: { current: AbortSignal | null } = { current: null };