/**
 * 8.4 — Working memory & reminders: memory_write → .klyro/memory/session-notes.md (≤1k tokens) + todos re-inject
 *
 * Durability: writes are atomic (tmp + rename in the same dir) so a crash
 * never leaves a half-written note file. Oversized single writes are
 * rejected with an Error (the memory_write tool's safe() wrapper converts
 * that into a ToolResult error) instead of being silently truncated.
 */
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { PlanStep } from '../agent/runtime.js';
import { redact } from '../policy/secret-redactor.js';

/** Single-write ceiling — anything larger is rejected, not sliced. */
export const MEMORY_WRITE_LIMIT_CHARS = 8000;
/** Steady-state cap (~1k tokens ≈ 4k chars) kept via tail slice. */
export const MEMORY_STEADY_STATE_CHARS = 4000;

export async function memoryWrite(cwd: string, content: string): Promise<string> {
  if (content.length > MEMORY_WRITE_LIMIT_CHARS) {
    throw new Error(
      `memory budget exceeded: single write is ${content.length} chars (max ${MEMORY_WRITE_LIMIT_CHARS}) — split it into smaller notes`,
    );
  }
  const dir = path.join(cwd, '.klyro', 'memory');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, 'session-notes.md');
  const prev = await fs.readFile(p, 'utf-8').catch(() => '');
  // S4-at-rest: redact before appending — redact() only fires on secret
  // shapes (key/token/password with [:=-]), so normal prose survives.
  const full = prev + '\n' + redact(content);
  let next = full;
  if (full.length > MEMORY_STEADY_STATE_CHARS) {
    // Rotation, not silent loss: the dropped head is archived to a dated
    // file (pruned to the latest 20) instead of vanishing. Summarization
    // of archives is left to an explicit future pass.
    const head = full.slice(0, full.length - MEMORY_STEADY_STATE_CHARS);
    next = full.slice(-MEMORY_STEADY_STATE_CHARS);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.writeFile(path.join(dir, `archive-${stamp}.md`), head, 'utf-8');
      const entries = (await fs.readdir(dir)).filter((e) => e.startsWith('archive-')).sort();
      for (const old of entries.slice(0, Math.max(0, entries.length - 20))) {
        await fs.unlink(path.join(dir, old)).catch(() => undefined);
      }
    } catch { /* archive is best-effort; the live notes still persist */ }
  }
  const tmp = path.join(dir, `.session-notes.md.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.writeFile(tmp, next, 'utf-8');
  try {
    const fh = await fs.open(tmp, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
  } catch { /* ignore on Windows */ }
  try {
    await fs.rename(tmp, p);
  } catch {
    await fs.unlink(tmp).catch(() => undefined);
    throw new Error('Failed to write memory file');
  }
  return p;
}
export async function loadMemory(cwd: string): Promise<string> {
  try { return await fs.readFile(path.join(cwd, '.klyro', 'memory', 'session-notes.md'), 'utf-8'); } catch { return ''; }
}

/** Synchronous read for the system-prompt build path (run on every turn). */
export function loadMemorySync(cwd: string): string {
  try {
    return readFileSync(path.join(cwd, '.klyro', 'memory', 'session-notes.md'), 'utf-8');
  } catch { return ''; }
}

/** Wrap persisted notes into the injected prompt block; '' when empty. */
export function memoryBlock(cwd: string): string {
  const notes = loadMemorySync(cwd).trim();
  return notes ? `\n\n<memory>\n${notes.slice(0, 4000)}\n</memory>` : '';
}
export function shouldRemind(turn: number, lastRemindTurn: number): boolean {
  return turn - lastRemindTurn >= 20;
}
export function reminderForTodos(todos: PlanStep[]): string | undefined {
  if (todos.length === 0) return undefined;
  const active = todos.filter((t) => t.status === 'in_progress' || t.status === 'pending');
  if (active.length === 0) return undefined;
  return `Reminder: todos pending — ${active.map((t) => t.title).join(', ')}`;
}
