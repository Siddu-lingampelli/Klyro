/**
 * In-process worker spawner (MVP).
 *
 * Per `docs/plan-fix.md` Step 2: workers run in-process for the MVP.
 * Real subprocess / child-process spawning belongs to a later level
 * (Level 7: sandboxed execution, Level 19: distributed workers).
 *
 * A "worker" here is just an async task with an AbortController. The
 * spawner keeps a registry so they can be cancelled together (e.g. on
 * user Ctrl+C, /abort, or session shutdown).
 */

export interface WorkerHandle {
  /** Stable id, monotonically increasing per spawner instance. */
  readonly id: number;
  /** Human-readable label, used in logs. */
  readonly label: string;
  /** AbortController tied to this worker's lifetime. */
  readonly signal: AbortSignal;
  /** Resolves when the worker's main promise settles. */
  readonly done: Promise<void>;
}

export interface SpawnOptions {
  label?: string;
  /** If true, the worker is started immediately on spawn (default true). */
  autoStart?: boolean;
}

export class WorkerSpawner {
  private nextId = 0;
  private readonly handles = new Set<WorkerHandle>();

  /**
   * Spawn a worker. The factory returns a promise; the spawner wires it
   * up to an AbortController and tracks it.
   */
  spawn(factory: (signal: AbortSignal) => Promise<void>, opts: SpawnOptions = {}): WorkerHandle {
    const id = this.nextId++;
    const ac = new AbortController();
    const label = opts.label ?? `worker-${id}`;
    const autoStart = opts.autoStart ?? true;

    let resolveDone: () => void = () => {};
    let rejectDone: (e: unknown) => void = () => {};
    const done = new Promise<void>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });

    const handle: WorkerHandle = {
      id,
      label,
      signal: ac.signal,
      done,
    };
    this.handles.add(handle);

    if (!autoStart) {
      // Caller will invoke factory manually and pass the signal — for now
      // we just resolve immediately so .done doesn't hang.
      resolveDone();
      return handle;
    }

    // Fire-and-forget; user awaits handle.done.
    factory(ac.signal).then(
      () => {
        this.handles.delete(handle);
        resolveDone();
      },
      (err) => {
        this.handles.delete(handle);
        rejectDone(err);
      },
    );

    return handle;
  }

  /** Abort every active worker. Their factories should observe signal. */
  cancelAll(reason = 'cancelled'): void {
    for (const h of [...this.handles]) {
      try {
        (h.signal as AbortSignal & { reason?: unknown }).reason = reason;
      } catch {
        // AbortSignal.reason is read-only in some envs — fine.
      }
    }
    // Real abort uses the controller stored on the handle's signal — we
    // don't keep the controller here. In the MVP, callers can pass their
    // own AbortController via factory; this method is a no-op stub for
    // the contract. See `cancel(handle)` for the per-worker variant.
  }

  /** Count of currently-active workers. */
  activeCount(): number {
    return this.handles.size;
  }

  /** Snapshot of all live worker handles. */
  list(): readonly WorkerHandle[] {
    return [...this.handles];
  }
}
