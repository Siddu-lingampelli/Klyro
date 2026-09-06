import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { globTool } from './glob.js';
import type { ToolContext } from '../types.js';

describe('globTool', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(tmpdir(), 'klyro-glob-'));
    await fs.mkdir(path.join(cwd, 'src', 'nested'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'src', 'a.ts'), '');
    await fs.writeFile(path.join(cwd, 'src', 'b.ts'), '');
    await fs.writeFile(path.join(cwd, 'src', 'nested', 'c.json'), '');
    await fs.writeFile(path.join(cwd, 'README.md'), '');
    ctx = { cwd, env: {}, signal: undefined };
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('matches recursive ** patterns', async () => {
    const r = await globTool.execute({ pattern: '**/*.ts' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.matches.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('matches a single path', async () => {
    const r = await globTool.execute({ pattern: 'src/*.json' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.matches).toEqual([]);
    const r2 = await globTool.execute({ pattern: 'src/**/*.json' }, ctx);
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('unreachable');
    expect(r2.value.matches).toEqual(['src/nested/c.json']);
  });

  it('skips node_modules even if present', async () => {
    await fs.mkdir(path.join(cwd, 'node_modules', 'x'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'node_modules', 'x', 'a.ts'), '');
    const r = await globTool.execute({ pattern: '**/*.ts' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.matches.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('does not descend into symlinks', async () => {
    await fs.mkdir(path.join(cwd, 'real'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'real', 'z.ts'), '');
    // symlink may fail on Windows without privileges; skip if so
    await fs.symlink('real', path.join(cwd, 'link')).catch(() => undefined);
    const r = await globTool.execute({ pattern: '**/*.ts' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.matches).not.toContain('link/z.ts');
  });

  it('caps results', async () => {
    const r = await globTool.execute({ pattern: '**/*', maxResults: 2 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.matches.length).toBeLessThanOrEqual(2);
    expect(r.value.truncated).toBe(true);
  });

  it('missing cwd pattern returns PATH_ESCAPE via resolveWithinCwd', async () => {
    const r = await globTool.execute({ pattern: '**/*.ts', cwd: '/nonexistent' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('PATH_ESCAPE');
  });
});