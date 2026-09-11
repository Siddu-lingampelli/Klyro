import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { memoryWrite, loadMemory, MEMORY_WRITE_LIMIT_CHARS, MEMORY_STEADY_STATE_CHARS } from './memory.js';

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-mem-'));
});

describe('memoryWrite', () => {
  it('writes and loads notes', async () => {
    const p = await memoryWrite(cwd, 'remember the plan');
    expect(p).toBe(path.join(cwd, '.klyro', 'memory', 'session-notes.md'));
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
});
