/**
 * Level 9 — Session helpers (default store location, lifecycle).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore, type SessionRecord } from './store.js';

let _cachedStore: SessionStore | undefined;

export function getDefaultSessionsDir(): string {
  if (process.env.KLYRO_SESSIONS_DIR) return process.env.KLYRO_SESSIONS_DIR;
  const home = os.homedir();
  if (home) return path.join(home, '.klyro', 'sessions');
  return path.join(process.cwd(), '.klyro', 'sessions');
}

export function getDefaultSessionStore(): SessionStore {
  if (_cachedStore) return _cachedStore;
  _cachedStore = new SessionStore(getDefaultSessionsDir());
  return _cachedStore;
}

/** Create a session store at a custom dir (for tests). */
export function createSessionStore(dir: string): SessionStore {
  return new SessionStore(dir);
}

/** Format a session for human output. */
export function formatSession(rec: SessionRecord): string {
  const d = new Date(rec.createdAt).toISOString().slice(0, 19).replace('T', ' ');
  return `${rec.id.slice(0, 8)}  ${rec.status.padEnd(12)} ${d}  ${rec.cwd}  "${rec.task.slice(0, 60)}"`;
}

/** Resolve a short id prefix to full id (like git). */
export async function resolveSessionId(store: SessionStore, prefix: string): Promise<string | null> {
  if (prefix.length >= 32) {
    const rec = await store.get(prefix);
    return rec ? rec.id : null;
  }
  const matches = await matchSessionIds(store, prefix);
  if (matches.length === 1) return matches[0]!.id;
  // zero or ambiguous — null; callers use matchSessionIds for a good message
  return null;
}

/** All sessions matching an id prefix (lets callers distinguish missing vs ambiguous). */
export async function matchSessionIds(store: SessionStore, prefix: string): Promise<SessionRecord[]> {
  if (prefix.length >= 32) {
    const rec = await store.get(prefix);
    return rec ? [rec] : [];
  }
  const all = await store.list();
  return all.filter((r) => r.id.startsWith(prefix));
}
