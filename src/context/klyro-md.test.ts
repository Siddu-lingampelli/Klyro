import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadKlyroMd, loadKlyroMdFiles, loadKlyroMdForPath } from './klyro-md.js';

describe('klyro-md', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-md-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('loads KLYRO.md from cwd', async () => {
    await fs.writeFile(path.join(tmp, 'KLYRO.md'), '# hello', 'utf-8');
    const md = await loadKlyroMd(tmp);
    expect(md).toContain('hello');
  });

  it('loads CLAUDE.md as an alias', async () => {
    await fs.writeFile(path.join(tmp, 'CLAUDE.md'), '# migrated', 'utf-8');
    const md = await loadKlyroMd(tmp);
    expect(md).toContain('migrated');
  });

  it('prefers KLYRO.md over CLAUDE.md when both exist', async () => {
    await fs.writeFile(path.join(tmp, 'KLYRO.md'), '# klyro wins', 'utf-8');
    await fs.writeFile(path.join(tmp, 'CLAUDE.md'), '# lose', 'utf-8');
    const md = await loadKlyroMd(tmp);
    expect(md).toContain('klyro wins');
    expect(md).toContain('lose'); // both loaded (no single-file rejection)
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

  it('A<->B import cycle terminates with a cycle-skipped marker', async () => {
    await fs.writeFile(path.join(tmp, 'KLYRO.md'), '@import b.md', 'utf-8');
    await fs.writeFile(path.join(tmp, 'b.md'), '@import KLYRO.md', 'utf-8');
    const md = await loadKlyroMd(tmp);
    expect(md).toContain('import cycle skipped');
  });

  it('self-import terminates with a cycle-skipped marker', async () => {
    await fs.writeFile(path.join(tmp, 'KLYRO.md'), '@import KLYRO.md', 'utf-8');
    const md = await loadKlyroMd(tmp);
    expect(md).toContain('import cycle skipped');
  });

  it('loadKlyroMdForPath loads subdir instructions for the relevant path', async () => {
    await fs.writeFile(path.join(tmp, 'KLYRO.md'), '# root', 'utf-8');
    await fs.mkdir(path.join(tmp, 'sub', 'leaf'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'sub', 'KLYRO.md'), '# sub-level', 'utf-8');
    await fs.writeFile(path.join(tmp, 'sub', 'leaf', 'AGENTS.md'), '# leaf-level', 'utf-8');
    const files = await loadKlyroMdForPath(tmp, path.join(tmp, 'sub', 'leaf', 'file.ts'));
    const texts = files.map((f) => f.content).join('\n');
    expect(texts).toContain('root');
    expect(texts).toContain('sub-level');
    expect(texts).toContain('leaf-level');
  });

  it('plain loadKlyroMdFiles does NOT load subdir files (laziness)', async () => {
    await fs.mkdir(path.join(tmp, 'sub'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'sub', 'KLYRO.md'), '# sub-only', 'utf-8');
    const files = await loadKlyroMdFiles(tmp);
    expect(files.map((f) => f.content).join('\n')).not.toContain('sub-only');
  });

  it('loadKlyroMdForPath rejects a targetPath escaping cwd', async () => {
    await fs.mkdir(path.join(tmp, 'sub'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'sub', 'KLYRO.md'), '# sub-only', 'utf-8');
    const files = await loadKlyroMdForPath(tmp, path.join(os.tmpdir(), 'escape-target.txt'));
    expect(files.map((f) => f.content).join('\n')).not.toContain('sub-only');
  });
});
