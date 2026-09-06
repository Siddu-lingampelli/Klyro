/**
 * 8.4 — Working memory & reminders: memory_write → .klyro/memory/session-notes.md (≤1k tokens) + todos re-inject
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PlanStep } from '../agent/runtime.js';

export async function memoryWrite(cwd: string, content: string): Promise<string> {
  const dir = path.join(cwd, '.klyro', 'memory');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, 'session-notes.md');
  const prev = await fs.readFile(p, 'utf-8').catch(() => '');
  const next = (prev + '\n' + content).slice(-4000); // ≤1k tokens ~4k chars
  await fs.writeFile(p, next, 'utf-8');
  return p;
}
export async function loadMemory(cwd: string): Promise<string> {
  try { return await fs.readFile(path.join(cwd, '.klyro', 'memory', 'session-notes.md'), 'utf-8'); } catch { return ''; }
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
