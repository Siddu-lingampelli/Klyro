import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { multiEditTool } from './multi-edit.js';

describe('multi_edit', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-multi-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('applies sequential edits atomically', async () => {
    const p = path.join(tmp, 'a.txt');
    await fs.writeFile(p, 'a b c', 'utf-8');
    const r = await multiEditTool.execute({ path: 'a.txt', edits: [{ find: 'a', replace: 'A' }, { find: 'b', replace: 'B' }] }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(p, 'utf-8')).toBe('A B c');
  });

  it('rolls back on failure', async () => {
    const p = path.join(tmp, 'a.txt');
    await fs.writeFile(p, 'hello', 'utf-8');
    const r = await multiEditTool.execute({ path: 'a.txt', edits: [{ find: 'hello', replace: 'hi' }, { find: 'nope', replace: 'x' }] }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(false);
    expect(await fs.readFile(p, 'utf-8')).toBe('hello');
  });
});
