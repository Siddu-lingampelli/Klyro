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

  it('refuses @import escapes outside cwd', async () => {
    const outside = path.join(os.tmpdir(), `klyro-escape-${Date.now()}.md`);
    await fs.writeFile(outside, 'SECRET-ESCAPED', 'utf-8');
    try {
      await fs.writeFile(path.join(tmp, 'KLYRO.md'), `@import ../${path.basename(outside)}`, 'utf-8');
      const md = await loadKlyroMd(tmp);
      expect(md).not.toContain('SECRET-ESCAPED');
    } finally {
      await fs.unlink(outside).catch(() => undefined);
    }
  });

  it('caps total output size', async () => {
    await fs.writeFile(path.join(tmp, 'KLYRO.md'), 'x'.repeat(20000), 'utf-8');
    const md = await loadKlyroMd(tmp);
    expect(md.length).toBeLessThanOrEqual(9000);
  });
});
