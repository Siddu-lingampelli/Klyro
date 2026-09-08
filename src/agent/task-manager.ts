/**
 * Task manager — tracks the lifecycle of a (possibly nested) agent run.
 *
 * Each `spawn_agent` call creates a `TaskRecord` in a `TaskManager`.
 * The manager owns an `AbortController` per task so that the parent (or
 * the user) can cancel a running child without tearing down the entire
 * process. It enforces a recursion / depth cap and emits `subtask.*`
 * events so the event bus and trace writer can see the task tree.
 *
 * Exactly one task manager exists per session, wired into the orchestrator
 * (src/agent/orchestrator.ts), which the runtime reaches via
 * `parentContext`.
 */

import { globalBus, type EventBus } from '../events/bus.js';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'blocked';

export interface TaskError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * The full runtime record for one task. `summary` is a free-form progress
 * log; `done` resolves to this very record once the task reaches a terminal
 * status, so `await rec.done` yields the record with its final status.
 */
export interface TaskRecord {
  id: string;
  parentTaskId?: string;
  sessionId: string;
  agentName: string;
  status: TaskStatus;
  cwd: string;
  depth: number;
  maxDepth: number;
  model?: string;
  startedAt: number;
  finishedAt?: number;
  summary: string[];
  error?: TaskError;
  abortController: AbortController;
  done: Promise<TaskRecord>;
  /** Internal — resolves `done`. Do not call outside TaskManager. */
  _resolveDone: (r: TaskRecord) => void;
  /** Internal cleanup handles, not part of the stable contract. */
  _cleanupParentAbort?: () => void;
  timeoutHandle?: NodeJS.Timeout;
}

/** Serialisable, stable subset of a task for logs, tools, and the trace. */
export interface TaskSummary {
  id: string;
  parentTaskId?: string;
  agentName: string;
  sessionId: string;
  status: TaskStatus;
  cwd: string;
  depth: number;
  model?: string;
  durationMs?: number;
}

export interface CreateTaskOpts {
  agentName: string;
  cwd: string;
  depth: number;
  maxDepth: number;
  parentTaskId?: string;
  model?: string;
  timeoutMs?: number;
  /** Abort this task when the given signal fires. */
  abortOnParent?: AbortSignal;
  /** Defaults to true. When false, the task starts in 'queued'. */
  autoStart?: boolean;
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly watchers = new Map<string, Set<(r: TaskRecord) => void>>();
  private counter = 0;
  private readonly sessionId: string;
  private readonly bus: EventBus;

  constructor(opts: { sessionId: string; bus?: EventBus }) {
    this.sessionId = opts.sessionId;
    this.bus = opts.bus ?? globalBus;
  }

  /** Create a task. Blocks instead of running when the recursion cap is exceeded. */
  create(opts: CreateTaskOpts): TaskRecord {
    const id = `task_${++this.counter}`;
    const running = opts.autoStart !== false;

    let resolveDone!: (r: TaskRecord) => void;
    const record: TaskRecord = {
      id,
      parentTaskId: opts.parentTaskId,
      sessionId: this.sessionId,
      agentName: opts.agentName,
      status: running ? 'running' : 'queued',
      cwd: opts.cwd,
      depth: opts.depth,
      maxDepth: opts.maxDepth,
      model: opts.model,
      startedAt: Date.now(),
      summary: [],
      abortController: new AbortController(),
      done: new Promise((res) => {
        resolveDone = res;
      }),
      _resolveDone: (r) => resolveDone(r),
    };
    this.tasks.set(id, record);

    // Recursion / depth guard — enforced at the boundary so a deep-deep
    // call chain can never be constructed in the first place.
    if (opts.depth > opts.maxDepth) {
      record.status = 'blocked';
      record.timeoutHandle = undefined;
      record.error = {
        code: 'BLOCKED',
        message: `recursion limit: depth ${opts.depth} exceeds maxDepth ${opts.maxDepth}`,
      };
      this.resolve(record);
      this.emit(record);
      return record;
    }

    // Parent abort → child abort chain.
    if (opts.abortOnParent) {
      const onAbort = () => this.cancel(id, 'parent aborted');
      if (opts.abortOnParent.aborted) {
        onAbort();
      } else {
        opts.abortOnParent.addEventListener('abort', onAbort, { once: true });
        record._cleanupParentAbort = () => opts.abortOnParent!.removeEventListener('abort', onAbort);
      }
    }

    // Timeout: transition to 'timed_out' and abort if still live.
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      record.timeoutHandle = setTimeout(() => {
        const r = this.tasks.get(id);
        if (r && (r.status === 'running' || r.status === 'queued')) {
          this.cancel(id, 'timeout', 'timed_out');
        }
      }, opts.timeoutMs);
    }

    this.emit(record);
    return record;
  }

  /** Look up a live record. */
  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  /** List tasks, optionally filtered by parent and/or status. Returns summaries. */
  list(filter?: { parentTaskId?: string; status?: TaskStatus }): TaskSummary[] {
    const out: TaskSummary[] = [];
    for (const r of this.tasks.values()) {
      if (filter?.parentTaskId !== undefined && r.parentTaskId !== filter.parentTaskId) continue;
      if (filter?.status !== undefined && r.status !== filter.status) continue;
      out.push(this.toSummary(r));
    }
    return out;
  }

  /** Transition a task to a terminal status and resolve its `done`. */
  finish(
    id: string,
    status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'blocked',
    patch?: { summary?: string[]; error?: TaskError },
  ): TaskRecord {
    const r = this.get(id);
    if (!r) throw new Error(`unknown task: ${id}`);
    if (status !== 'blocked' && r.timeoutHandle) {
      clearTimeout(r.timeoutHandle);
      r.timeoutHandle = undefined;
    }
    if (patch?.summary) r.summary.push(...patch.summary);
    r.status = status;
    r.finishedAt = Date.now();
    if (patch?.error) r.error = patch.error;
    this.resolve(r);
    this.emit(r);
    return r;
  }

  /** Cancel a live task: abort, mark cancelled/timed_out, resolve done. */
  cancel(
    id: string,
    reason = 'cancelled',
    finalStatus: 'cancelled' | 'timed_out' = 'cancelled',
  ): TaskRecord {
    const r = this.get(id);
    if (!r) throw new Error(`unknown task: ${id}`);
    if (r.status !== 'queued' && r.status !== 'running') return r; // idempotent on terminal

    r.abortController.abort(reason);
    r._cleanupParentAbort?.();
    r._cleanupParentAbort = undefined;
    if (r.timeoutHandle) {
      clearTimeout(r.timeoutHandle);
      r.timeoutHandle = undefined;
    }
    r.status = finalStatus;
    r.finishedAt = Date.now();
    r.error = {
      code: finalStatus === 'timed_out' ? 'TIMED_OUT' : 'CANCELLED',
      message: reason,
    };
    this.resolve(r);
    this.emit(r);
    return r;
  }

  /** Confirm a task that policy/depth prevented from running. */
  block(id: string, reason: string): TaskRecord {
    return this.finish(id, 'blocked', {
      error: { code: 'BLOCKED', message: reason },
    });
  }

  /** Cancel `id` and every transitive descendant. */
  async cancelTree(id: string, reason = 'cancelled'): Promise<void> {
    const ids: string[] = [id];
    const walk = (pid: string) => {
      for (const r of this.tasks.values()) {
        if (r.parentTaskId === pid) {
          ids.push(r.id);
          walk(r.id);
        }
      }
    };
    walk(id);
    // Children first so a parent's abort doesn't race a child still being torn down.
    ids.reverse();
    for (const tid of ids) {
      this.cancel(tid, reason);
    }
  }

  /** Subscribe to status transitions for one task. Delivers the current status immediately. */
  subscribe(id: string, listener: (r: TaskRecord) => void): () => void {
    let set = this.watchers.get(id);
    if (!set) {
      set = new Set();
      this.watchers.set(id, set);
    }
    set.add(listener);
    const r = this.get(id);
    if (r) {
      try {
        listener(r);
      } catch {
        /* ignore */
      }
    }
    return () => {
      set.delete(listener);
      if (set.size === 0) this.watchers.delete(id);
    };
  }

  /** Cancel every live task (used on shutdown / ctrl-c). */
  async shutdown(): Promise<void> {
    for (const id of [...this.tasks.keys()]) {
      const r = this.get(id);
      if (r && (r.status === 'queued' || r.status === 'running')) {
        this.cancel(id, 'shutdown');
      }
    }
  }

  /** Compact serialisable summary. */
  toSummary(r: TaskRecord): TaskSummary {
    return {
      id: r.id,
      ...(r.parentTaskId ? { parentTaskId: r.parentTaskId } : {}),
      agentName: r.agentName,
      sessionId: r.sessionId,
      status: r.status,
      cwd: r.cwd,
      depth: r.depth,
      ...(typeof r.model === 'string' ? { model: r.model } : {}),
      ...(r.finishedAt ? { durationMs: r.finishedAt - r.startedAt } : {}),
    };
  }

  /* ---------------------- internals ---------------------- */

  /** Resolve a record's `done` (idempotent). */
  private resolve(r: TaskRecord): void {
    this._resolveOnce(r);
  }

  private _resolveOnce(r: TaskRecord): void {
    try {
      r._resolveDone(r);
    } catch {
      /* already resolved */
    }
  }

  /** Deliver a transition to the task's own watchers, then each ancestor's. */
  private emit(r: TaskRecord): void {
    this.notify(r.id, r);
    let pid = r.parentTaskId;
    while (pid) {
      const p = this.get(pid);
      this.notify(pid, r);
      pid = p?.parentTaskId;
    }
  }

  private notify(id: string, r: TaskRecord): void {
    const set = this.watchers.get(id);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(r);
      } catch {
        /* ignore */
      }
    }
  }
}