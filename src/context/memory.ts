/**
 * 8.4 — Working memory & reminders: memory_write → .klyro/memory/session-notes.md (≤1k tokens) + todos re-inject
 *
 * Durability: writes are atomic (tmp + rename in the same dir) so a crash
 * never leaves a half-written note file. Oversized single writes are
 * rejected with an Error (the memory_write tool's safe() wrapper converts
 * that into a ToolResult error) instead of being silently truncated.
 */
import * as fs from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import type { PlanStep } from '../agent/runtime.js';
import { redact } from '../policy/secret-redactor.js';
import { resolveAndFollowSymlinks, assertNotSymlink } from '../policy/path-guard.js';

/** Single-write ceiling — anything larger is rejected, not sliced. */
export const MEMORY_WRITE_LIMIT_CHARS = 8000;
/** Steady-state cap (~1k tokens ≈ 4k chars) kept via tail slice. */
export const MEMORY_STEADY_STATE_CHARS = 4000;
/** Archive index filename (recall without an LLM pass). */
export const MEMORY_ARCHIVE_INDEX = 'archive-index.json';
/** Max retained archives. */
export const MEMORY_ARCHIVE_KEEP = 20;

export interface MemoryArchiveEntry {
  file: string;
  ts: number;
  chars: number;
  /** First line of the archived head — lets the model decide what to re-read. */
  preview: string;
}

export async function memoryWrite(cwd: string, content: string): Promise<string> {
  if (content.length > MEMORY_WRITE_LIMIT_CHARS) {
    throw new Error(
      `memory budget exceeded: single write is ${content.length} chars (max ${MEMORY_WRITE_LIMIT_CHARS}) — split it into smaller notes`,
    );
  }
  // B4 — symlink/TOCTOU guard: the memory dir must stay inside cwd even if
  // `.klyro` or `.klyro/memory` is (or becomes) a symlink. Resolve+follow up
  // the existing parent chain first (defeats an escaping parent symlink), then
  // mkdir, then a final realpath + lstat: a swapped-in final symlink is
  // refused before any write lands outside cwd.
  const dir = path.join(cwd, '.klyro', 'memory');
  await resolveAndFollowSymlinks(cwd, '.klyro'); // throws if `.klyro` escapes cwd
  await fs.mkdir(dir, { recursive: true });
  const { resolved } = await resolveAndFollowSymlinks(cwd, '.klyro/memory');
  await assertNotSymlink(resolved);
  const p = path.join(resolved, 'session-notes.md');
  const prev = await fs.readFile(p, 'utf-8').catch(() => '');
  // S4-at-rest: redact before appending — redact() only fires on secret
  // shapes (key/token/password with [:=-]), so normal prose survives.
  const full = prev + '\n' + redact(content);
  let next = full;
  if (full.length > MEMORY_STEADY_STATE_CHARS) {
    // Rotation, not silent loss: the dropped head is archived to a dated
    // file (pruned to the latest 20) instead of vanishing, and the archive
    // index is refreshed so the model knows what exists to re-read.
    const head = full.slice(0, full.length - MEMORY_STEADY_STATE_CHARS);
    next = full.slice(-MEMORY_STEADY_STATE_CHARS);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `archive-${stamp}.md`;
      await fs.writeFile(path.join(resolved, file), head, 'utf-8');
      const entries = (await fs.readdir(resolved)).filter((e) => e.startsWith('archive-') && e.endsWith('.md')).sort();
      for (const old of entries.slice(0, Math.max(0, entries.length - MEMORY_ARCHIVE_KEEP))) {
        await fs.unlink(path.join(resolved, old)).catch(() => undefined);
      }
      const index: MemoryArchiveEntry[] = [];
      for (const e of (await fs.readdir(resolved)).filter((e) => e.startsWith('archive-') && e.endsWith('.md')).sort()) {
        try {
          const content = await fs.readFile(path.join(resolved, e), 'utf-8');
          const stat = await fs.stat(path.join(resolved, e));
          index.push({ file: e, ts: Math.round(stat.mtimeMs), chars: content.length, preview: content.split('\n')[0]?.slice(0, 160) ?? '' });
        } catch { /* skip unreadable entries */ }
      }
      await fs.writeFile(path.join(resolved, MEMORY_ARCHIVE_INDEX), JSON.stringify(index, null, 2), 'utf-8');
    } catch { /* archive is best-effort; the live notes still persist */ }
  }
  const tmp = path.join(resolved, `.session-notes.md.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
  if (!notes) return '';
  // Recall aid: tell the model which archives exist (with previews) so it
  // can re-read them via read_file instead of losing rotated knowledge.
  let archived = '';
  try {
    const raw = readFileSync(path.join(cwd, '.klyro', 'memory', MEMORY_ARCHIVE_INDEX), 'utf-8');
    const entries = JSON.parse(raw) as MemoryArchiveEntry[];
    if (Array.isArray(entries) && entries.length > 0) {
      const lines = entries.slice(-5).map((e) => `  - .klyro/memory/${e.file} (${e.chars} chars): ${e.preview}`);
      archived = `\nEarlier notes archived (read one with read_file for detail):\n${lines.join('\n')}`;
    }
  } catch { /* no index — nothing archived yet */ }
  return `\n\n<memory>\n${notes.slice(0, 4000)}${archived}\n</memory>`;
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
