/**
 * 3.1 — core/events emitter
 * In-memory pub/sub for KlyroEvents. Sync delivery, no buffering.
 */

import type { KlyroEvent } from './catalog.js';

type Listener = (ev: KlyroEvent) => void;

/** Cap for the retained event history. Long sessions emit a lot of
 *  stream.delta / tool.result events; keeping them all grows memory
 *  without bound. We retain a fixed recent window plus the structural
 *  events (phase, verify, error) so replays stay coherent. */
export const HISTORY_CAP = 10_000;

export class EventBus {
  private listeners = new Set<Listener>();
  private history: KlyroEvent[] = [];

  emit(ev: KlyroEvent): void {
    this.history.push(ev);
    if (this.history.length > HISTORY_CAP) {
      // Cheap uniform prune: drop every other oldest event so a flood of
      // deltas can't force a reallocation on each emit.
      this.history = this.history.filter((_, i) => i % 2 === 1);
    }
    for (const l of [...this.listeners]) {
      try { l(ev); } catch { /* ignore listener error */ }
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getHistory(): KlyroEvent[] {
    return [...this.history];
  }

  clear(): void {
    this.history = [];
  }
}

export const globalBus = new EventBus();
