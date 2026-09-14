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
import type { RuntimeDeps, RunOptions, RunResult, RuntimeEvent } from './runtime.js';
import type { ToolResult } from '../tools/types.js';
import { run, resolveSystemPrompt } from './runtime.js';
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
import { forkChild, workerEntryPath, type ChildWorkerPayload, type ChildCrashError } from './child-worker.js';
import { loadCustomAgents } from './custom-agents.js';
import { resolveAndFollowSymlinks } from '../policy/path-guard.js';
import {
  ensureGitRepo,
  createWorktree,
  mergeWorktree,
  removeWorktree,
  deleteBranch,
  type WorktreeInfo,
} from './worktree-manager.js';

/** Concurrency budgets enforced in `spawnAgent` (CONCURRENCY_LIMIT on exceed). */
export const MAX_CONCURRENT_TASKS = 4;
export const MAX_TASKS_PER_PARENT = 8;
export const MAX_TOTAL_TASKS_PER_SESSION = 32;

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
  /** Token budget forwarded to the child's run options. */
  maxTokens?: number;
  /**
   * Filesystem allow-list for this agent; intersected with the parent's at
   * spawn time (`undefined` = no additional constraint).
   */
  allowedPaths?: string[];
  /**
   * Specialist instructions (from `.klyro/agents/*.md` body or programmatic
   * defs). Prepended to the delegated task at spawn time.
   */
  prompt?: string;
  /** Where the definition came from (builtins omit this = 'builtin'). */
  source?: 'builtin' | 'project' | 'global';
}

/** Default agents a model can delegate to. */
export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  {
    id: 'explorer',
    description: 'Read-only reconnaissance: map the repo, find symbols and tests.',
    readonly: true,
    canSpawn: false,
    allowedTools: ['read_file', 'list_directory', 'glob', 'grep', 'search_files', 'repo_map', 'find_symbol', 'git_status', 'git_log', 'git_diff', 'recent_files', 'imports_of', 'importers_of'],
  },
  {
    id: 'implementer',
    description: 'Write-capable worker for concrete, well-scoped coding tasks.',
    canSpawn: false,
    allowedTools: ['read_file', 'list_directory', 'glob', 'grep', 'search_files', 'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'shell_exec', 'git_status', 'git_log', 'git_diff', 'run_verify', 'todo_write'],
    maxSteps: 60,
  },
  {
    id: 'tester',
    description: 'Runs verification and tests, reports failures with diagnostics.',
    canSpawn: false,
    allowedTools: ['read_file', 'list_directory', 'glob', 'grep', 'shell_exec', 'run_verify', 'git_status', 'git_log', 'git_diff'],
    maxTimeMs: 120_000,
  },
  {
    id: 'reviewer',
    description: 'Read-only review of a diff or change set for bugs.',
    readonly: true,
    canSpawn: false,
    allowedTools: ['read_file', 'list_directory', 'glob', 'grep', 'search_files', 'git_status', 'git_diff', 'git_log', 'imports_of', 'importers_of', 'find_symbol'],
  },
  {
    id: 'debugger',
    description: 'Read-only diagnosis: inspect failures, traces, and code paths without modifying files.',
    readonly: true,
    canSpawn: false,
    allowedTools: ['read_file', 'list_directory', 'glob', 'grep', 'search_files', 'repo_map', 'find_symbol', 'imports_of', 'importers_of', 'git_status', 'git_log', 'git_diff', 'recent_files', 'run_verify'],
  },
  {
    id: 'docs',
    description: 'Read-only documentation lookup: find and summarise docs, READMEs, and code structure.',
    readonly: true,
    canSpawn: false,
    allowedTools: ['read_file', 'list_directory', 'glob', 'grep', 'search_files', 'repo_map', 'recent_files'],
  },
];

/**
 * Layer specialist instructions into a child's system prompt (not the user
 * task). Pure — unit-tested directly. No-op when the def has no prompt.
 */
export function layerSpecialistPrompt(
  base: RuntimeDeps['systemPrompt'],
  def: Pick<AgentDefinition, 'id' | 'prompt'>,
): RuntimeDeps['systemPrompt'] {
  if (!def.prompt) return base;
  return (ctx) => {
    const r = base(ctx);
    const block = `\n\n<specialist id="${def.id}">\n${def.prompt}\n</specialist>`;
    return typeof r === 'string' ? r + block : { ...r, system: r.system + block };
  };
}

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
  /**
   * Effective filesystem allow-list threaded through to the child (sibling C
   * enforces it in fs tools). `undefined` = unconstrained.
   */
  allowedPaths?: string[];
}

/** One awaited task entry returned by `waitForTasks`. */
export interface WaitedTask {
  taskId: string;
  status: TaskStatus;
  summary?: ChildSummary;
  error?: { code: string; message: string };
}

/** Interface exposed to the runtime/tools for a child spawn request. */
export interface AgentSpawnBridge {
  parent: ParentContextRef;
  spawnAgent(input: { agent: string; task: string; cwd?: string; model?: string; timeoutMs?: number }): Promise<ToolResult<ChildSummary>>;
  listAgents(): AgentDefinition[];
  getAgent(id: string): AgentDefinition | undefined;
  listTasks(filter?: { parentTaskId?: string; status?: TaskStatus }): TaskSummary[];
  getTask(id: string): TaskSummary & { error?: { code: string; message: string } } | undefined;
  /**
   * Return completed-then-undrained child summaries. Each completed task is
   * drained exactly once — subsequent calls omit it. Optional so older
   * (sibling A) bridge fakes still satisfy the type.
   */
  drainCompletions?(): ChildSummary[];
  /**
   * Await each task's `record.done` up to `timeoutMs` (per task). Entries
   * that do not settle in time are returned with status `'running'` — the
   * underlying task is NOT cancelled. Never throws for unknown ids: they
   * come back as `{ status: 'failed', error: NOT_FOUND }`.
   */
  waitForTasks?(taskIds: string[], timeoutMs?: number): Promise<{ tasks: WaitedTask[] }>;
  /** Signal abort for a live task (in-process workers; no subprocesses yet — no process tree to kill). Idempotent on terminal tasks. */
  cancelTask?(taskId: string): ToolResult<{ taskId: string; status: TaskStatus }>;
  /**
   * Merge a succeeded task's worktree branch into the parent tree (or
   * acknowledge a shared-cwd task) and emit `subtask.merged`. Errors with
   * NOT_FOUND / NOT_READY / MERGE_CONFLICT.
   */
  applyTask?(taskId: string): Promise<ToolResult<ChildSummary>>;
}

/** Constructor options for the orchestrator — the parent runtime's deps. */
export interface OrchestratorOpts {
  sessionId: string;
  deps: RuntimeDeps;
  taskManager?: TaskManager;
  workerSpawner?: WorkerSpawner;
  /**
   * True when the parent is the interactive TUI. TUI children run
   * process-isolated *unless* they may need to surface an approval prompt to
   * the operator (see childCanIsolate) — the Ink bridge is tied to the parent
   * terminal, so a prompting child must stay in-process. Headless/CLI children
   * always isolate. Defaults to false.
   */
  isTui?: boolean;
  /**
   * Working directory used to discover custom agents
   * (`.klyro/agents/*.md`). Defaults to `process.cwd()`.
   */
  cwd?: string;
}

/**
 * All agents: builtins plus custom `.klyro/agents/*.md` definitions.
 * Custom ids win on clash (including overriding a builtin) — the override
 * is surfaced via `source`. No instance needed; used by CLI + spawn paths.
 */
export function listAllAgents(cwd?: string): AgentDefinition[] {
  const byId = new Map<string, AgentDefinition>();
  for (const d of BUILTIN_AGENTS) byId.set(d.id, { ...d, source: 'builtin' });
  try {
    for (const d of loadCustomAgents(cwd ?? process.cwd())) byId.set(d.id, d);
  } catch { /* custom agents are best-effort */ }
  return [...byId.values()];
}

/** Find one agent by id across builtins + custom files. */
export function findAgent(id: string, cwd?: string): AgentDefinition | undefined {
  return listAllAgents(cwd).find((a) => a.id === id);
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

/**
 * Build a `subtask.progress` note for one finished tool call.
 * Pure — unit-tested directly (see agent-tools.test.ts).
 */
export function progressNote(step: number, tool: string, isError: boolean): string {
  return `step ${step}: ${tool} ${isError ? 'ERR' : 'ok'}`;
}

/**
 * Build the `RunOptions.onEvent` handler the orchestrator passes into each
 * child's run options. Emits at most one `subtask.progress` per tool call:
 * a `tool_result` is only mirrored when its `tool_call_end` was observed
 * first, so duplicate/late results can never double-emit. (The note needs
 * the ok/ERR outcome, which only `tool_result` carries — `tool_call_end`
 * alone cannot build it — hence the end-gated result throttle.)
 */
export function createSubtaskProgressEmitter(opts: {
  taskId: string;
  sessionId: string;
}): (ev: RuntimeEvent) => void {
  let step = 0;
  const ended = new Set<string>();
  return (ev: RuntimeEvent): void => {
    if (ev.kind === 'step_start') {
      step = ev.step;
    } else if (ev.kind === 'tool_call_end') {
      ended.add(ev.id);
    } else if (ev.kind === 'tool_result') {
      if (!ended.has(ev.id)) return;
      ended.delete(ev.id);
      globalBus.emit({
        type: 'subtask.progress',
        ts: Date.now(),
        sessionId: opts.sessionId,
        taskId: opts.taskId,
        note: progressNote(step, ev.name, ev.isError),
      });
    }
  };
}

export class AgentOrchestrator {
  readonly sessionId: string;
  readonly deps: RuntimeDeps;
  readonly taskManager: TaskManager;
  readonly workerSpawner: WorkerSpawner;
  readonly isTui: boolean;
  private readonly customCwd: string | undefined;
  /** Per-task spawn metadata: capability drops + worktree placement. */
  private readonly taskMeta = new Map<
    string,
    { def: AgentDefinition; dropped: { tool: string; reason: DropReason }[]; worktree?: WorktreeInfo; repoCwd?: string }
  >();
  /** Finished summaries not yet drained via `drainCompletions`. */
  private readonly undrained = new Map<string, ChildSummary>();

  constructor(opts: OrchestratorOpts) {
    this.sessionId = opts.sessionId;
    this.deps = opts.deps;
    this.taskManager = opts.taskManager ?? new TaskManager({ sessionId: opts.sessionId });
    this.workerSpawner = opts.workerSpawner ?? new WorkerSpawner();
    this.isTui = opts.isTui ?? false;
    this.customCwd = opts.cwd;
  }

  listAgents(): AgentDefinition[] {
    return listAllAgents(this.customCwd);
  }

  getAgent(id: string): AgentDefinition | undefined {
    return listAllAgents(this.customCwd).find((a) => a.id === id);
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
      drainCompletions: () => this.drainCompletions(),
      waitForTasks: (taskIds, timeoutMs) => this.waitForTasks(taskIds, timeoutMs),
      cancelTask: (taskId) => this.cancelTask(taskId),
      applyTask: (taskId) => this.applyTask(taskId),
    };
  }

  /**
   * R2 — decide whether a child may run process-isolated.
   *
   * The only thing that forces a child to stay in-process is the possibility
   * of an interactive approval prompt: the Ink bridge lives in the parent
   * terminal, so a subprocess could never ask. A child that cannot prompt is
   * therefore free to isolate.
   *
   * A child cannot prompt when any of these hold:
   *   - it is readonly (no write/execute tools → no `ask` on those),
   *   - the parent is not a TUI (no bridge to reach in the first place), or
   *   - the child's toolset contains no tool the policy can put in `ask`.
   *
   * Isolation is deliberately conservative here: when in doubt we keep the
   * child in-process, because a stranded prompt is a hang and a hang is worse
   * than lost isolation. Public for direct unit testing.
   */
  childCanIsolate(
    resolved: { allowed: ReadonlySet<string>; readonly: boolean },
    def: AgentDefinition,
    childOptions: RunOptions,
  ): boolean {
    // Headless parents have no approval bridge — isolation is always safe.
    if (!this.isTui) return true;
    // Readonly agents never write/execute, so never prompt.
    if (resolved.readonly) return true;
    // A child with an inherited bridge (grandchildren possible) must stay
    // in-process: its own children need the bridge chain.
    if (childOptions.agentBridge) return false;
    // Any tool in the child's set that the policy can escalate to `ask`
    // pins it in-process. `execute` is the class that most commonly prompts
    // (shell_exec), so its presence is the deciding signal alongside writes.
    const prompting = new Set(['shell_exec', 'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'run_verify']);
    for (const t of resolved.allowed) {
      if (prompting.has(t)) return false;
    }
    void def;
    return true;
  }

  /** Compute a child's effective capabilities from the parent's own. */
  private resolveChild(
    def: AgentDefinition,
    parent: ParentContextRef,
    registryTools: ReadonlySet<string>,
  ): { allowed: ReadonlySet<string>; dropped: { tool: string; reason: DropReason }[]; model?: string; maxDepth: number; readonly: boolean; canSpawn: boolean; allowedPaths?: string[] } {
    const input: ResolveToolsInput = {
      parentTools: parent.allowedTools,
      agent: def,
      policyAllowed: registryTools,
      registryTools,
      writeTools: DEFAULT_WRITE_TOOLS,
      spawnTools: DEFAULT_SPAWN_TOOLS,
      denied: DEFAULT_DENIED_TOOLS,
    };
    const resolved = resolveCapabilities({ ...input, maxDepth: parent.maxDepth, parentAllowedPaths: parent.allowedPaths });
    return resolved;
  }

  /**
   * Spawn a child agent asynchronously: start the child worker and return
   * IMMEDIATELY with `{ status: 'running' }`. Completion/failure bus emits
   * and `taskManager.finish` happen in the worker closure; the parent
   * observes them via `task_wait` / `task_get` / `drainCompletions`.
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

    // Concurrency budgets — enforced before creating the task.
    const all = this.taskManager.list();
    const runningCount = all.filter((t) => t.status === 'running').length;
    if (runningCount >= MAX_CONCURRENT_TASKS) {
      return {
        ok: false,
        error: { code: 'CONCURRENCY_LIMIT', message: `maxConcurrentTasks (${MAX_CONCURRENT_TASKS}) reached` },
      };
    }
    const perParentCount = all.filter((t) => t.parentTaskId === parent.taskId).length;
    if (perParentCount >= MAX_TASKS_PER_PARENT) {
      return {
        ok: false,
        error: { code: 'CONCURRENCY_LIMIT', message: `maxTasksPerParent (${MAX_TASKS_PER_PARENT}) reached` },
      };
    }
    if (all.length >= MAX_TOTAL_TASKS_PER_SESSION) {
      return {
        ok: false,
        error: { code: 'CONCURRENCY_LIMIT', message: `maxTotalTasksPerSession (${MAX_TOTAL_TASKS_PER_SESSION}) reached` },
      };
    }

    // Spawn cwd containment (S6): an explicit cwd must stay inside the parent.
    let baseCwd = parent.cwd;
    if (input.cwd) {
      try {
        baseCwd = (await resolveAndFollowSymlinks(parent.cwd, input.cwd)).resolved;
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'PATH_ESCAPE',
            message: err instanceof Error ? err.message : `cwd escapes parent: ${input.cwd}`,
          },
        };
      }
    }

    const registryTools = new Set(this.deps.registry.list().map((t) => t.name));
    const resolved = this.resolveChild(def, parent, registryTools);
    const childModel = input.model ?? resolved.model ?? parent.model;

    // Worktree isolation: write-capable children get their own worktree —
    // including when the spawn carries an explicit cwd (the worktree is
    // then rooted at the resolved explicit cwd, which containment above
    // already pinned inside the parent). Readonly agents keep the resolved
    // cwd with no worktree. A write-capable spawn outside a git repo is
    // rejected outright.
    const writeCapable = [...resolved.allowed].some((t) => DEFAULT_WRITE_TOOLS.has(t));
    let childCwd = baseCwd;
    let worktree: WorktreeInfo | undefined;
    let repoCwd: string | undefined;
    if (!resolved.readonly && writeCapable) {
      const isRepo = await ensureGitRepo(baseCwd).catch(() => false);
      if (!isRepo) {
        return {
          ok: false,
          error: { code: 'WRITES_REQUIRE_GIT', message: 'parallel write agents require a git repository for worktree isolation' },
        };
      }
      repoCwd = baseCwd;
    }

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

    // Worktree creation needs the task id (branch `klyro/<taskId>`), so it
    // happens after `create`. On failure the task is marked failed and the
    // spawn returns the error.
    if (repoCwd !== undefined) {
      try {
        worktree = await createWorktree({ repoCwd, taskId: record.id });
        childCwd = worktree.worktreePath;
        record.cwd = childCwd;
      } catch (err) {
        this.taskManager.finish(record.id, 'failed', {
          error: { code: 'WORKTREE_FAILED', message: err instanceof Error ? err.message : String(err) },
        });
        const failed = this.taskManager.get(record.id)!;
        this.stashSummary(failed, def, resolved.dropped);
        this.taskMeta.set(record.id, { def, dropped: resolved.dropped });
        return {
          ok: false,
          error: { code: 'WORKTREE_FAILED', message: err instanceof Error ? err.message : String(err) },
        };
      }
    }
    this.taskMeta.set(
      record.id,
      worktree ? { def, dropped: resolved.dropped, worktree, repoCwd } : { def, dropped: resolved.dropped },
    );

    const childRegistry = new ScopedRegistry(this.deps.registry, resolved.allowed);
    const childPromptFn = layerSpecialistPrompt(this.deps.systemPrompt, def);
    const childDeps: RuntimeDeps = { ...this.deps, registry: childRegistry, systemPrompt: childPromptFn };

    const childRef: ParentContextRef = {
      taskId: record.id,
      ...(parent.taskId !== undefined ? { parentTaskId: parent.taskId } : {}),
      sessionId: this.sessionId,
      cwd: childCwd,
      depth: childDepth,
      maxDepth,
      allowedTools: resolved.allowed,
      ...(childModel !== undefined ? { model: childModel } : {}),
      ...(resolved.allowedPaths !== undefined ? { allowedPaths: resolved.allowedPaths } : {}),
    };

    const childOptions: RunOptions = {
      task: input.task,
      cwd: childCwd,
      model: childModel ?? 'inherit', // model override must reach the adapter (see runtime)
      maxSteps: def.maxSteps,
      maxCost: def.maxCost,
      maxTimeMs: def.maxTimeMs ?? input.timeoutMs,
      signal: record.abortController.signal,
      nonInteractive: true,
      // Mid-life progress: mirror each finished tool call as one
      // `subtask.progress` bus event (see createSubtaskProgressEmitter).
      // Process-isolated children don't run this closure — only the
      // in-process path reports mid-life progress.
      onEvent: createSubtaskProgressEmitter({ taskId: record.id, sessionId: this.sessionId }),
      // Grandchildren: only children that canSpawn receive the bridge —
      // otherwise tools see NO_ORCHESTRATOR as before.
      ...(resolved.canSpawn ? { agentBridge: this.bridgeFor(childRef) } : {}),
      ...(def.maxTokens !== undefined ? { maxTokens: def.maxTokens } : {}),
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

    // G2/R2 — process isolation for sub-agents. A child can be spawned as a
    // real OS process whenever it will never need to surface an interactive
    // approval prompt to the operator. Every child that might prompt must stay
    // in-process so the TUI approval bridge (tied to the parent terminal) can
    // reach the operator. Headless/readonly/DenyAll children — which is the
    // ordinary case — isolate into a subprocess. The blanket exclusion of ALL
    // TUI children (V1) is replaced by this capability-aware rule, so a TUI
    // session with readonly or non-interactive children gets real isolation
    // too. Explicitly opt out with KLYRO_WORKER=0.
    // See orchestratorOpts.isTui, capabilities.resolveCapabilities, and
    // child-worker.buildChildDeps (DenyAll approval).
    const useProcessIsolation = process.env.KLYRO_WORKER !== '0' && this.childCanIsolate(resolved, def, childOptions);

    this.workerSpawner.spawn(async (signal) => {
      // Both the in-process path and the forked child resolve to the same
      // minimal outcome shape the settle tail needs.
      let childOutcome: {
        status: RunResult['status'];
        steps: number;
        toolCalls: number;
        finalText: string;
      };
      try {
        if (useProcessIsolation) {
          const sysPrompt = resolveSystemPrompt(childPromptFn, { cwd: childCwd });
          // Splice the volatile telemetry suffix into the stable prefix so the
          // child's provider sees one system string. Telemetry is best-effort
          // inside the child (it re-emits); the goal here is parity, not
          // perfect replay.
          const systemPrompt = sysPrompt.suffix ? `${sysPrompt.system}\n${sysPrompt.suffix}` : sysPrompt.system;
          const payload: ChildWorkerPayload = {
            cwd: childCwd,
            task: input.task,
            // A concrete provider model must reach the child — 'inherit' only
            // exists to defer resolution inside the parent's run().
            model: (childModel ?? parent.model) as string,
            systemPrompt,
            agentId: def.id,
            maxSteps: def.maxSteps,
            maxCost: def.maxCost,
            maxTimeMs: def.maxTimeMs ?? input.timeoutMs,
            ...(def.maxTokens !== undefined ? { maxTokens: def.maxTokens } : {}),
          };
          const cr = await forkChild(workerEntryPath(), payload, { signal });
          childOutcome = cr; // ChildResult is the minimal settle shape
        } else {
          const r = await run(childOptions, childDeps);
          childOutcome = { status: r.status, steps: r.steps, toolCalls: r.toolCalls, finalText: r.finalText };
        }
      } catch (err) {
        const isCrash = err instanceof Error && (err as ChildCrashError).name === 'ChildCrashError';
        const crashErr = isCrash ? (err as ChildCrashError) : undefined;
        this.settleChild(record.id, 'failed', {
          error: {
            code: 'CHILD_CRASH',
            message: isCrash
              ? `child process isolated failure (${crashErr?.likelyCause ?? 'exit'}): ${crashErr?.message ?? ''}`.trim()
              : err instanceof Error ? err.message : String(err),
          },
        }, { steps: 0, toolCalls: 0 });
        return;
      }
      const status = mapResultStatus(childOutcome.status);
      this.settleChild(record.id, status, {
        summary: [`status: ${status}`, `steps: ${childOutcome.steps}`, `toolCalls: ${childOutcome.toolCalls}`],
        error:
          status === 'failed'
            ? { code: mapFailureCode(childOutcome.status), message: childOutcome.finalText?.slice(0, 300) ?? 'child failed' }
            : undefined,
      }, { steps: childOutcome.steps, toolCalls: childOutcome.toolCalls });
    }, { label: `agent:${def.id}` });

    // Async contract: return immediately with the running summary. The final
    // text is omitted while running; observe via task_wait / drainCompletions.
    return {
      ok: true,
      value: { taskId: record.id, agentName: def.id, status: 'running', durationMs: 0, changedFiles: [] },
    };
  }

  /**
   * Settle a child in the worker closure: finish the task (idempotent —
   * a TaskManager timeout/cancel that fired first wins), emit the terminal
   * bus event, stash the summary for `drainCompletions`, and best-effort
   * remove the worktree unless the child succeeded (merge happens later in
   * `task_apply`).
   */
  private settleChild(
    taskId: string,
    status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'blocked',
    patch?: { summary?: string[]; error?: { code: string; message: string } },
    counts?: { steps: number; toolCalls: number },
  ): void {
    const existing = this.taskManager.get(taskId);
    if (!existing) return;
    let finalStatus = status;
    if (existing.status === 'queued' || existing.status === 'running') {
      this.taskManager.finish(taskId, status, patch);
    } else {
      // Already terminal (timeout/cancel raced the run) — preserve it.
      finalStatus = existing.status as typeof finalStatus;
    }
    const final = this.taskManager.get(taskId)!;
    this.stashSummary(final);

    const durationMs = final.finishedAt ? final.finishedAt - final.startedAt : 0;
    const error = final.error ? { code: final.error.code, message: final.error.message } : undefined;
    const steps = counts?.steps ?? 0;
    const toolCalls = counts?.toolCalls ?? 0;
    if (finalStatus === 'succeeded') {
      globalBus.emit({
        type: 'subtask.completed',
        ts: Date.now(),
        sessionId: this.sessionId,
        taskId,
        status: 'succeeded',
        durationMs,
        steps,
        toolCalls,
      });
    } else if (finalStatus === 'cancelled') {
      globalBus.emit({
        type: 'subtask.cancelled',
        ts: Date.now(),
        sessionId: this.sessionId,
        taskId,
        status: 'cancelled',
        durationMs,
        ...(error ? { error } : {}),
      });
    } else if (finalStatus === 'timed_out') {
      globalBus.emit({
        type: 'subtask.timed_out',
        ts: Date.now(),
        sessionId: this.sessionId,
        taskId,
        status: 'timed_out',
        durationMs,
        ...(error ? { error } : {}),
      });
    } else {
      globalBus.emit({
        type: 'subtask.failed',
        ts: Date.now(),
        sessionId: this.sessionId,
        taskId,
        status: finalStatus as 'failed' | 'blocked',
        durationMs,
        ...(error ? { error } : {}),
      });
    }

    // Non-success terminal states never merge — drop the worktree.
    const meta = this.taskMeta.get(taskId);
    if (meta?.worktree && meta.repoCwd && finalStatus !== 'succeeded') {
      const { worktree, repoCwd } = meta;
      void removeWorktree({ repoCwd, worktreePath: worktree.worktreePath, force: true }).catch(() => undefined);
    }
  }

  /** Build and stash the finished summary for `drainCompletions`. */
  private stashSummary(
    r: TaskRecord,
    def?: AgentDefinition,
    dropped?: { tool: string; reason: DropReason }[],
  ): void {
    const meta = this.taskMeta.get(r.id);
    const d = def ?? meta?.def;
    if (!d) return;
    this.undrained.set(r.id, this.toChildSummary(r, d, dropped ?? meta?.dropped ?? []));
  }

  /** Completed-then-undrained child summaries; each drained exactly once. */
  drainCompletions(): ChildSummary[] {
    const out = [...this.undrained.values()];
    this.undrained.clear();
    return out;
  }

  /**
   * Await each task's `done` up to `timeoutMs` per task. Unsettled entries
   * come back with status `'running'` and a running summary — the underlying
   * task is NOT cancelled.
   */
  async waitForTasks(taskIds: string[], timeoutMs?: number): Promise<{ tasks: WaitedTask[] }> {
    const tasks = await Promise.all(
      taskIds.map(async (taskId): Promise<WaitedTask> => {
        const rec = this.taskManager.get(taskId);
        if (!rec) {
          return { taskId, status: 'failed', error: { code: 'NOT_FOUND', message: `Unknown task: ${taskId}` } };
        }
        const meta = this.taskMeta.get(taskId);
        const settled = await this.awaitDone(rec, timeoutMs);
        const summary = meta ? this.toChildSummary(settled, meta.def, meta.dropped) : undefined;
        const entry: WaitedTask = { taskId, status: settled.status };
        if (summary) entry.summary = summary;
        if (settled.error) entry.error = { code: settled.error.code, message: settled.error.message };
        return entry;
      }),
    );
    return { tasks };
  }

  private async awaitDone(rec: TaskRecord, timeoutMs?: number): Promise<TaskRecord> {
    if (timeoutMs === undefined) return rec.done;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        rec.done,
        new Promise<TaskRecord>((resolve) => {
          timer = setTimeout(() => resolve(this.taskManager.get(rec.id)!), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Signal abort for a live task via `taskManager.cancel` (in-process workers; no subprocesses yet). Idempotent on terminal tasks. */
  cancelTask(taskId: string): ToolResult<{ taskId: string; status: TaskStatus }> {
    const rec = this.taskManager.get(taskId);
    if (!rec) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown task: ${taskId}` } };
    }
    this.taskManager.cancel(taskId, 'stopped via task_stop');
    const final = this.taskManager.get(taskId)!;
    return { ok: true, value: { taskId, status: final.status } };
  }

  /**
   * Apply a succeeded task: merge its worktree branch into the parent tree
   * (or acknowledge a shared-cwd task whose edits already landed) and emit
   * `subtask.merged`. Non-succeeded tasks error with NOT_READY; merge
   * conflicts error with MERGE_CONFLICT (merge already aborted, branch kept).
   */
  async applyTask(taskId: string): Promise<ToolResult<ChildSummary>> {
    const rec = this.taskManager.get(taskId);
    if (!rec) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown task: ${taskId}` } };
    }
    if (rec.status !== 'succeeded') {
      return {
        ok: false,
        error: { code: 'NOT_READY', message: `task ${taskId} is ${rec.status}, not succeeded` },
      };
    }
    const meta = this.taskMeta.get(taskId);
    const summary = meta ? this.toChildSummary(rec, meta.def, meta.dropped) : this.toChildSummary(rec, this.getAgent(rec.agentName) ?? { id: rec.agentName, description: '' }, []);
    // merged=true only when a real worktree branch merge ran; shared-cwd
    // tasks (edits already in the parent tree) are an acknowledgement.
    let didMerge = false;
    if (meta?.worktree && meta.repoCwd) {
      const merged = await mergeWorktree({ repoCwd: meta.repoCwd, branch: meta.worktree.branch });
      if (!merged.merged) {
        return {
          ok: false,
          error: {
            code: 'MERGE_CONFLICT',
            message: `merge of ${meta.worktree.branch} conflicted`,
            details: { conflictFiles: merged.conflictFiles },
          },
        };
      }
      await removeWorktree({ repoCwd: meta.repoCwd, worktreePath: meta.worktree.worktreePath }).catch(() => undefined);
      await deleteBranch({ repoCwd: meta.repoCwd, branch: meta.worktree.branch });
      didMerge = true;
    }
    globalBus.emit({
      type: 'subtask.merged',
      ts: Date.now(),
      sessionId: this.sessionId,
      taskId,
      changedFiles: summary.changedFiles,
      merged: didMerge,
    });
    return { ok: true, value: summary };
  }

  /** Compact summary for a task record (also used by task_wait). */
  toChildSummary(
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