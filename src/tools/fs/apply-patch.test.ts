import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyPatchTool } from './apply-patch.js';

describe('apply_patch', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-patch-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('applies Codex-style patch', async () => {
    const patch = `*** Begin Patch\n*** Update File: a.txt\n+hello world\n*** End Patch`;
    const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).toContain('hello world');
  });

  it('rejects invalid patch', async () => {
    const r = await applyPatchTool.execute({ patch: 'not a patch' }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(false);
  });
});
