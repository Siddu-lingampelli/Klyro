/**
 * 8.2 — Tool result lifecycle: store large results by id, expand_result, unchanged detection
 */
import * as crypto from 'node:crypto';

const store = new Map<string, { output: unknown; size: number }>();
const seenFiles = new Map<string, { hash: string; turn: number }>();

function hash(s: string): string { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 8); }

export function storeResult(output: unknown): string {
  const id = `r_${crypto.randomBytes(3).toString('hex')}`;
  const str = typeof output === 'string' ? output : JSON.stringify(output);
  store.set(id, { output, size: str.length });
  // cap store to ~50 entries
  if (store.size > 50) { const first = store.keys().next().value as string; store.delete(first); }
  return id;
}
export function expandResult(id: string): unknown | null {
  return store.get(id)?.output ?? null;
}
export function checkUnchanged(path: string, content: string, turn: number): { unchanged: boolean; sinceTurn?: number } {
  const h = hash(content);
  const prev = seenFiles.get(path);
  if (prev && prev.hash === h) return { unchanged: true, sinceTurn: prev.turn };
  seenFiles.set(path, { hash: h, turn });
  return { unchanged: false };
}
export function storedIds(): string[] { return [...store.keys()]; }
