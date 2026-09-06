import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { editFileTool } from './edit-file.js';

describe('edit_file core (4.1)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-edit-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function write(file: string, content: string): Promise<string> {
    const p = path.join(tmp, file);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
    return p;
  }

  it('exact replace single', async () => {
    await write('a.txt', 'hello world');
    const r = await editFileTool.execute({ path: 'a.txt', find: 'world', replace: 'there' }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).toBe('hello there');
  });

  it('preserves CRLF', async () => {
    await write('a.txt', 'a\r\nb\r\nc\r\n');
    const r = await editFileTool.execute({ path: 'a.txt', find: 'b', replace: 'B' }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
    const out = await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8');
    expect(out).toContain('\r\n');
    expect(out).toBe('a\r\nB\r\nc\r\n');
  });

  it('preserves BOM', async () => {
    await write('a.txt', '\uFEFFhello');
    const r = await editFileTool.execute({ path: 'a.txt', find: 'hello', replace: 'hi' }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
    const out = await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8');
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe('hi');
  });

  it('preserves trailing newline', async () => {
    await write('a.txt', 'hello\n');
    await editFileTool.execute({ path: 'a.txt', find: 'hello', replace: 'hi' }, { cwd: tmp, env: {} });
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).toBe('hi\n');
    await write('b.txt', 'hello');
    await editFileTool.execute({ path: 'b.txt', find: 'hello', replace: 'hi' }, { cwd: tmp, env: {} });
    expect(await fs.readFile(path.join(tmp, 'b.txt'), 'utf-8')).toBe('hi');
  });

  it('ambiguous without replaceAll fails', async () => {
    await write('a.txt', 'foo foo foo');
    const r = await editFileTool.execute({ path: 'a.txt', find: 'foo', replace: 'bar' }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MATCH_AMBIGUOUS');
  });

  it('replaceAll works', async () => {
    await write('a.txt', 'foo foo');
    const r = await editFileTool.execute({ path: 'a.txt', find: 'foo', replace: 'bar', replaceAll: true }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).toBe('bar bar');
  });

  it('not found gives actionable', async () => {
    await write('a.txt', 'hello world');
    const r = await editFileTool.execute({ path: 'a.txt', find: 'nope', replace: 'x' }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/Closest match/);
  });

  it('fuzzy trailing whitespace tier', async () => {
    await write('a.txt', 'hello   \nworld');
    const r = await editFileTool.execute({ path: 'a.txt', find: 'hello', replace: 'hi' }, { cwd: tmp, env: {} });
    // exact should still work even if file has trailing spaces, fuzzy not needed
    expect(r.ok).toBe(true);
  });

  it('unicode quotes tier', async () => {
    await write('a.txt', '“hello”');
    const r = await editFileTool.execute({ path: 'a.txt', find: '"hello"', replace: '"hi"' }, { cwd: tmp, env: {} });
    // Should succeed via unicode tier
    expect(r.ok).toBe(true);
  });

  it('empty old_string fails', async () => {
    await write('a.txt', 'hello');
    const r = await editFileTool.execute({ path: 'a.txt', find: '', replace: 'x' } as unknown as { path: string; find: string; replace: string }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(false);
  });
});
