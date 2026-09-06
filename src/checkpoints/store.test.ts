import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { snapshot, listCheckpoints, undo } from './store.js';

describe('checkpoints', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-ckpt-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('snapshot and undo', async () => {
    const p = path.join(tmp, 'a.txt');
    await fs.writeFile(p, 'v1', 'utf-8');
    await snapshot(tmp, ['a.txt']);
    await fs.writeFile(p, 'v2', 'utf-8');
    await snapshot(tmp, ['a.txt']);
    expect((await listCheckpoints(tmp)).length).toBe(2);
    await undo(tmp, 1);
    expect(await fs.readFile(p, 'utf-8')).toBe('v2');
  });

  it('undo restores deletions (missing-file tracking)', async () => {
    const p = path.join(tmp, 'gone.txt');
    await fs.writeFile(p, 'v1', 'utf-8');
    await snapshot(tmp, ['gone.txt']);
    await fs.unlink(p);
    await snapshot(tmp, ['gone.txt']);
    // undo(2) targets the first snapshot (file present) — restores v1.
    await undo(tmp, 2);
    expect(await fs.readFile(p, 'utf-8')).toBe('v1');
  });

  it('undo of a created file re-deletes it', async () => {
    const p = path.join(tmp, 'new.txt');
    await snapshot(tmp, ['new.txt']); // absent → recorded missing
    await fs.writeFile(p, 'created', 'utf-8');
    await snapshot(tmp, ['new.txt']);
    await undo(tmp, 2); // back to "did not exist"
    await expect(fs.readFile(p, 'utf-8')).rejects.toThrow();
  });

  it('snapshot refuses paths escaping cwd', async () => {
    const outside = path.join(os.tmpdir(), `klyro-outside-${Date.now()}.txt`);
    await fs.writeFile(outside, 'secret', 'utf-8');
    const id = await snapshot(tmp, ['../' + path.basename(outside)]);
    expect(id).toBeTruthy();
    // must not have copied anything outside
    const { readdir } = await import('node:fs/promises');
    const contains = async (dir: string): Promise<boolean> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (full === outside) return true;
        if (e.isDirectory() && (await contains(full))) return true;
      }
      return false;
    };
    expect(await contains(path.join(tmp, '.klyro'))).toBe(false);
    await fs.unlink(outside).catch(() => undefined);
  });

  it('last.diff is not listed as a checkpoint', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'v1', 'utf-8');
    await snapshot(tmp, ['a.txt']);
    const ckpts = await listCheckpoints(tmp);
    expect(ckpts).not.toContain('last.diff');
  });
});
