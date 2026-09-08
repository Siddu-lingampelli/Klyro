/**
 * In-process worker spawner.
 *
 * A "worker" here is just an async task tied to an AbortController. The
 * spawner keeps the controllers so workers can actually be cancelled
 * (user Ctrl+C, /abort, session shutdown, or a parent signalling a child).
 *
 * Real subprocess / child-process spawning belongs to a later level;
 * this module is the single-process cancellation primitive the agent
 * orchestration layer builds on.
 */

export interface WorkerHandle {
  /** Stable id, monotonically increasing per spawner instance. */
  readonly id: number;
  /** Human-readable label, used in logs. */
  readonly label: string;
  /** AbortSignal delivered to the factory so it can observe cancellation. */
  readonly signal: AbortSignal;
  /** The controller backing `signal` — retained so we can actually abort. */
  readonly controller: AbortController;
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
   * Spawn a worker. The factory receives an AbortSignal; when the worker is
   * cancelled (via `cancel`, `cancelAll`, or the parent signal wiring) that
   * signal fires and `done` settles.
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
      controller: ac,
      done,
    };
    this.handles.add(handle);

    if (!autoStart) {
      // Caller will invoke the factory manually and pass the signal.
      resolveDone();
      return handle;
    }

    // Fire-and-forget; the caller awaits handle.done.
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

  /** Cancel a single worker: fires its AbortSignal. */
  cancel(handle: WorkerHandle, reason?: unknown): void {
    try {
      handle.controller.abort(reason);
    } catch {
      /* already aborted */
    }
  }

  /** Cancel every active worker by firing their AbortSignals. */
  cancelAll(reason?: unknown): void {
    for (const h of [...this.handles]) {
      try {
        h.controller.abort(reason);
      } catch {
        /* already aborted */
      }
    }
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