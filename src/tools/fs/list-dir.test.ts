import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { listDirTool } from './list-dir.js';

describe('list_directory', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-ls-'));
    await fs.writeFile(path.join(tmp, 'a.txt'), 'x', 'utf-8');
    await fs.writeFile(path.join(tmp, '.hidden'), 'y', 'utf-8');
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  const ctx = (cwd: string) => ({ cwd, env: {} as NodeJS.ProcessEnv });

  it('hides dotfiles by default', async () => {
    const r = await listDirTool.execute({ path: '.' }, ctx(tmp));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const names = r.value.entries.map((e) => e.name);
      expect(names).toContain('a.txt');
      expect(names).not.toContain('.hidden');
    }
  });

  it('showHidden reveals dotfiles', async () => {
    const r = await listDirTool.execute({ path: '.', showHidden: true }, ctx(tmp));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const names = r.value.entries.map((e) => e.name);
      expect(names).toContain('.hidden');
    }
  });
});
