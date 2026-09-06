import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import type { ToolContext } from '../types.js';

describe('globTool', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-glob-'));
    await fs.writeFile(path.join(cwd, 'a.ts'), '');
    await fs.writeFile(path.join(cwd, 'b.js'), '');
    await fs.mkdir(path.join(cwd, 'sub'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'sub', 'c.ts'), '');
    ctx = { cwd, env: {} };
  });
  afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

  it('matches a single-segment pattern', async () => {
    const r = await globTool.execute({ pattern: '*.ts' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.matches).toContain('a.ts');
      expect(r.value.matches).not.toContain('b.js');
    }
  });

  it('matches recursive patterns', async () => {
    const r = await globTool.execute({ pattern: '**/*.ts' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const names = r.value.matches.map((m) => m.replace(/\\/g, '/'));
      expect(names).toContain('a.ts');
      expect(names).toContain('sub/c.ts');
    }
  });

  it('truncates at maxResults', async () => {
    const r = await globTool.execute({ pattern: '**/*', maxResults: 2 }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.matches.length).toBeLessThanOrEqual(2);
    }
  });
});

describe('grepTool', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-grep-'));
    await fs.writeFile(path.join(cwd, 'f1.ts'), 'hello world\nsecond line\nfoo bar\n');
    await fs.writeFile(path.join(cwd, 'f2.ts'), 'foo again\n');
    ctx = { cwd, env: {} };
  });
  afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

  it('finds a single match', async () => {
    const r = await grepTool.execute({ pattern: 'hello' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.hits.length).toBe(1);
      expect(r.value.hits[0].line).toBe(1);
      expect(r.value.hits[0].file.replace(/\\/g, '/')).toBe('f1.ts');
    }
  });

  it('finds multiple matches across files', async () => {
    const r = await grepTool.execute({ pattern: 'foo' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.hits.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('respects include filter', async () => {
    await fs.writeFile(path.join(cwd, 'data.log'), 'secret foo here\n');
    const r = await grepTool.execute({ pattern: 'foo', include: '*.ts' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const files = r.value.hits.map((h) => h.file.replace(/\\/g, '/'));
      expect(files).not.toContain('data.log');
      expect(files).toContain('f1.ts');
    }
  });

  it('returns INVALID_INPUT for bad regex', async () => {
    const r = await grepTool.execute({ pattern: '([' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('caps by maxResults', async () => {
    const r = await grepTool.execute({ pattern: '.', maxResults: 1 }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.hits.length).toBeLessThanOrEqual(1);
  });
});
