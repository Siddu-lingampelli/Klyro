import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { memoryWrite, loadMemory, MEMORY_WRITE_LIMIT_CHARS, MEMORY_STEADY_STATE_CHARS } from './memory.js';

/** Helper: can this environment create symlinks? (Windows may need privileges.) */
async function canSymlink(): Promise<boolean> {
  const t = path.join(os.tmpdir(), `klyro-symtest-${Date.now()}`);
  const target = path.join(os.tmpdir(), `klyro-symtest-target-${Date.now()}`);
  try {
    await fs.writeFile(target, 'x', 'utf-8');
    await fs.symlink(target, t);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(t, { force: true }).catch(() => undefined);
    await fs.rm(target, { force: true }).catch(() => undefined);
  }
}

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-mem-'));
});

describe('memoryWrite', () => {
  it('writes and loads notes', async () => {
    const p = await memoryWrite(cwd, 'remember the plan');
    expect(p).toContain(path.join('.klyro', 'memory', 'session-notes.md'));
    expect(await loadMemory(cwd)).toContain('remember the plan');
  });

  it('rejects single writes over the budget instead of silently slicing', async () => {
    const big = 'x'.repeat(MEMORY_WRITE_LIMIT_CHARS + 1);
    await expect(memoryWrite(cwd, big)).rejects.toThrow(/memory budget exceeded/);
    // rejected write leaves no file behind
    expect(await loadMemory(cwd)).toBe('');
  });

  it('keeps the steady-state cap via tail slice', async () => {
    await memoryWrite(cwd, 'a'.repeat(3000));
    await memoryWrite(cwd, 'b'.repeat(3000));
    const loaded = await loadMemory(cwd);
    expect(loaded.length).toBeLessThanOrEqual(MEMORY_STEADY_STATE_CHARS);
    expect(loaded).toContain('b'.repeat(10));
  });

  it('rotates the dropped head to a dated archive instead of losing it', async () => {
    await memoryWrite(cwd, 'FIRST-' + 'a'.repeat(3000));
    await memoryWrite(cwd, 'b'.repeat(3000));
    const dir = path.join(cwd, '.klyro', 'memory');
    const entries = await fs.readdir(dir);
    const archives = entries.filter((e) => e.startsWith('archive-') && e.endsWith('.md'));
    expect(archives.length).toBeGreaterThanOrEqual(1);
    const archived = await fs.readFile(path.join(dir, archives[0]!), 'utf-8');
    expect(archived).toContain('FIRST-');
    // Live notes still capped.
    expect((await loadMemory(cwd)).length).toBeLessThanOrEqual(MEMORY_STEADY_STATE_CHARS);
  });

  it('writes an archive index and surfaces it in the injected block', async () => {
    const { memoryBlock } = await import('./memory.js');
    expect(memoryBlock(cwd)).toBe('');
    await memoryWrite(cwd, 'FIRST-' + 'a'.repeat(3000));
    await memoryWrite(cwd, 'b'.repeat(3000));
    const block = memoryBlock(cwd);
    expect(block).toContain('<memory>');
    expect(block).toContain('archive-');
    expect(block).toContain('.klyro/memory/');
  });

  it('write is atomic (no tmp files left behind)', async () => {
    await memoryWrite(cwd, 'hello');
    const entries = await fs.readdir(path.join(cwd, '.klyro', 'memory'));
    expect(entries).toEqual(['session-notes.md']);
  });

  it('S4-at-rest: redacts secrets but keeps normal prose', async () => {
    await memoryWrite(cwd, 'deployed with api_key=ABCDEFGH12345678config');
    const loaded = await loadMemory(cwd);
    expect(loaded).not.toContain('ABCDEFGH12345678');
    expect(loaded).toContain('[REDACTED]');
  });

  it('S4-at-rest: bare prose without [:=-] shapes survives', async () => {
    await memoryWrite(cwd, 'my password is hunter2');
    expect(await loadMemory(cwd)).toContain('my password is hunter2');
  });

  it('B4: refuses to write when .klyro/memory is a symlink escaping cwd', async () => {
    if (!(await canSymlink())) return; // platform can't create symlinks
    const escape = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-mem-escape-'));
    const memDir = path.join(cwd, '.klyro', 'memory');
    await fs.mkdir(path.dirname(memDir), { recursive: true });
    await fs.symlink(escape, memDir, 'dir');
    await expect(memoryWrite(cwd, 'note')).rejects.toThrow(/escapes cwd|Refusing to write through symlink/);
    // Nothing landed in the escape dir.
    const files = await fs.readdir(escape);
    expect(files).toEqual([]);
  });

  it('B4: refuses to write when .klyro itself is a symlink escaping cwd', async () => {
    if (!(await canSymlink())) return;
    const escape = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-mem-escape2-'));
    const klyroDir = path.join(cwd, '.klyro');
    await fs.symlink(escape, klyroDir, 'dir');
    await expect(memoryWrite(cwd, 'note')).rejects.toThrow(/escapes cwd/);
  });

  it('B4: writes normally through a nested .klyro/.klyro/memory layout (no symlink)', async () => {
    const p = await memoryWrite(cwd, 'inside a plain dir');
    expect(p.endsWith(path.join('.klyro', 'memory', 'session-notes.md'))).toBe(true);
    expect(await loadMemory(cwd)).toContain('inside a plain dir');
  });
});
