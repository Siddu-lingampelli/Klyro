import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { listDirTool } from './list-dir.js';
import { editFileTool } from './edit-file.js';
import type { ToolContext } from '../types.js';

let cwd: string;
let ctx: ToolContext;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-fs-'));
  ctx = { cwd, env: {} };
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

describe('writeFileTool', () => {
  it('writes a file and reports bytes', async () => {
    const r = await writeFileTool.execute({ path: 'a.txt', content: 'hello' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.bytesWritten).toBe(5);
    const onDisk = await fs.readFile(path.join(cwd, 'a.txt'), 'utf-8');
    expect(onDisk).toBe('hello');
  });

  it('creates parent directories', async () => {
    const r = await writeFileTool.execute({ path: 'deep/nested/file.txt', content: 'x' }, ctx);
    expect(r.ok).toBe(true);
    const onDisk = await fs.readFile(path.join(cwd, 'deep/nested/file.txt'), 'utf-8');
    expect(onDisk).toBe('x');
  });

  it('refuses to escape cwd', async () => {
    const r = await writeFileTool.execute({ path: '../escape.txt', content: 'x' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PATH_ESCAPE');
  });

  it('refuses absolute paths outside cwd', async () => {
    const r = await writeFileTool.execute(
      { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', content: 'x' },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PATH_ESCAPE');
  });

  it('overwrites existing file atomically (no tmp left behind)', async () => {
    await writeFileTool.execute({ path: 'a.txt', content: 'first' }, ctx);
    const r = await writeFileTool.execute({ path: 'a.txt', content: 'second' }, ctx);
    expect(r.ok).toBe(true);
    const onDisk = await fs.readFile(path.join(cwd, 'a.txt'), 'utf-8');
    expect(onDisk).toBe('second');
    const entries = await fs.readdir(cwd);
    expect(entries.filter((e) => e.includes('.klyro-write-'))).toHaveLength(0);
  });
});

describe('readFileTool', () => {
  it('reads whole file', async () => {
    await writeFileTool.execute({ path: 'a.txt', content: 'line1\nline2\nline3' }, ctx);
    const r = await readFileTool.execute({ path: 'a.txt' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lines).toEqual(['line1', 'line2', 'line3']);
      expect(r.value.totalLines).toBe(3);
      expect(r.value.bytesRead).toBeGreaterThan(0);
    }
  });

  it('reads a line window', async () => {
    await writeFileTool.execute({ path: 'a.txt', content: 'a\nb\nc\nd\ne' }, ctx);
    const r = await readFileTool.execute({ path: 'a.txt', startLine: 2, endLine: 4 }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.lines).toEqual(['b', 'c', 'd']);
  });

  it('refuses outside cwd', async () => {
    const r = await readFileTool.execute({ path: '../etc/passwd' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PATH_ESCAPE');
  });

  it('returns NOT_FOUND for missing file', async () => {
    const r = await readFileTool.execute({ path: 'missing.txt' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('refuses to read via symlink that escapes cwd', async () => {
    // Create a symlink in cwd pointing to /etc/passwd (Unix) or outside
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd';
    await fs.symlink(outside, path.join(cwd, 'escape.lnk')).catch(() => undefined);
    // On Windows symlink creation may require elevated privileges; skip if it failed
    const exists = await fs.lstat(path.join(cwd, 'escape.lnk')).catch(() => null);
    if (!exists || !exists.isSymbolicLink()) {
      // Couldn't create symlink (Windows non-admin) — skip
      return;
    }
    const r = await readFileTool.execute({ path: 'escape.lnk' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PATH_ESCAPE');
  });
});

describe('listDirTool', () => {
  it('lists top-level entries', async () => {
    await writeFileTool.execute({ path: 'a.txt', content: 'x' }, ctx);
    await writeFileTool.execute({ path: 'sub/b.txt', content: 'y' }, ctx);
    const r = await listDirTool.execute({ path: '.' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const names = r.value.entries.map((e) => e.name).sort();
      expect(names).toContain('a.txt');
      expect(names).toContain('sub');
    }
  });

  it('skips node_modules by default', async () => {
    await fs.mkdir(path.join(cwd, 'node_modules/foo'), { recursive: true });
    const r = await listDirTool.execute({ path: '.' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const names = r.value.entries.map((e) => e.name);
      expect(names).not.toContain('node_modules');
    }
  });

  it('refuses outside cwd', async () => {
    const r = await listDirTool.execute({ path: '..' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PATH_ESCAPE');
  });
});

describe('editFileTool', () => {
  it('replaces a single occurrence', async () => {
    await writeFileTool.execute({ path: 'a.txt', content: 'hello world' }, ctx);
    const r = await editFileTool.execute({ path: 'a.txt', find: 'world', replace: 'there' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.replacements).toBe(1);
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf-8')).toBe('hello there');
  });

  it('rejects ambiguous matches without replaceAll', async () => {
    await writeFileTool.execute({ path: 'a.txt', content: 'aaa' }, ctx);
    const r = await editFileTool.execute({ path: 'a.txt', find: 'a', replace: 'b' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MATCH_AMBIGUOUS');
  });

  it('replaceAll replaces every occurrence', async () => {
    await writeFileTool.execute({ path: 'a.txt', content: 'aaa' }, ctx);
    const r = await editFileTool.execute({ path: 'a.txt', find: 'a', replace: 'b', replaceAll: true }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.replacements).toBe(3);
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf-8')).toBe('bbb');
  });

  it('returns MATCH_NOT_FOUND when substring missing', async () => {
    await writeFileTool.execute({ path: 'a.txt', content: 'hello' }, ctx);
    const r = await editFileTool.execute({ path: 'a.txt', find: 'zzz', replace: 'y' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MATCH_NOT_FOUND');
  });
});
