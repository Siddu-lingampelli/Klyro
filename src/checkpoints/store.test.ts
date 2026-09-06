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
});
