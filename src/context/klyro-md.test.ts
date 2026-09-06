import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadKlyroMd } from './klyro-md.js';

describe('klyro-md', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-md-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('loads KLYRO.md from cwd', async () => {
    await fs.writeFile(path.join(tmp, 'KLYRO.md'), '# hello', 'utf-8');
    const md = await loadKlyroMd(tmp);
    expect(md).toContain('hello');
  });

  it('handles @import', async () => {
    await fs.writeFile(path.join(tmp, 'KLYRO.md'), '@import other.md', 'utf-8');
    await fs.writeFile(path.join(tmp, 'other.md'), 'imported', 'utf-8');
    const md = await loadKlyroMd(tmp);
    expect(md).toContain('imported');
  });
});
