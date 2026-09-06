/**
 * 3.1 — core/events emitter
 * In-memory pub/sub for KlyroEvents. Sync delivery, no buffering.
 */

import type { KlyroEvent } from './catalog.js';

type Listener = (ev: KlyroEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private history: KlyroEvent[] = [];

  emit(ev: KlyroEvent): void {
    this.history.push(ev);
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
