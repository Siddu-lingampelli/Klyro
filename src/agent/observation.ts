/**
 * In-memory ObservationStore — records every tool call + result during a
 * single agent run so the runtime can recall "what happened so far" when
 * deciding the next step.
 *
 * MVP: in-memory only (no persistence). Persistence is a later level
 * (per `docs/plan.md` Level 14: durable session).
 *
 * Thread-safety: single agent loop = single owner. No locking needed.
 */

import type { ToolResult } from '../tools/types.js';

/** One recorded observation: a tool invocation + its outcome. */
export interface Observation {
  /** Monotonic id assigned at record-time. */
  readonly id: number;
  /** Name of the tool that was called. */
  readonly tool: string;
  /** Validated input that was passed to the tool. */
  readonly input: unknown;
  /** Tool's result — success value or structured error. */
  readonly result: ToolResult<unknown>;
  /** Wall-clock ms when execution started. */
  readonly startedAt: number;
  /** Wall-clock ms when execution finished. */
  readonly finishedAt: number;
  /** Duration in ms. */
  readonly durationMs: number;
}

export class ObservationStore {
  private readonly entries: Observation[] = [];
  private nextId = 0;

  /** Record one completed tool call. Returns the assigned observation. */
  record(entry: Omit<Observation, 'id'>): Observation {
    const full: Observation = { ...entry, id: this.nextId++ };
    this.entries.push(full);
    return full;
  }

  /** All observations in insertion order. */
  all(): readonly Observation[] {
    return this.entries;
  }

  /** Most recent N observations. */
  tail(n: number): readonly Observation[] {
    if (n <= 0) return [];
    return this.entries.slice(-n);
  }

  /** Count of observations recorded so far. */
  size(): number {
    return this.entries.length;
  }

  /** Clear all observations (e.g. after /clear or compact). */
  clear(): void {
    this.entries.length = 0;
  }

  /**
   * Serialize for use as model context. Returns a compact, model-readable
   * summary — not the full input/result blobs (those can be huge).
   */
  toContextSummary(): string {
    if (this.entries.length === 0) return '(no tool calls yet)';
    const lines: string[] = [];
    for (const o of this.entries) {
      const status = o.result.ok ? 'OK' : `ERR(${o.result.error.code})`;
      const dur = `${o.durationMs}ms`;
      lines.push(`#${o.id} ${o.tool} ${status} ${dur}`);
    }
    return lines.join('\n');
  }
}
