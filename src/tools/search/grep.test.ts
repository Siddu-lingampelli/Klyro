import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { grepTool } from './grep.js';
import type { ToolContext } from '../types.js';

describe('grepTool', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(tmpdir(), 'klyro-grep-'));
    await fs.writeFile(path.join(cwd, 'a.ts'), 'const foo = 1;\nconst bar = 2;\n');
    await fs.writeFile(path.join(cwd, 'b.ts'), 'const foo = "x";\n');
    ctx = { cwd, env: {}, signal: undefined };
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('finds matches across files', async () => {
    const r = await grepTool.execute({ pattern: 'foo' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.hits.length).toBe(2);
  });

  it('respects include filter', async () => {
    const r = await grepTool.execute({ pattern: 'foo', include: '*.ts' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.hits.length).toBe(2);
  });

  it('returns INVALID_INPUT on bad regex', async () => {
    const r = await grepTool.execute({ pattern: '[unclosed' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('includes context when requested', async () => {
    const r = await grepTool.execute({ pattern: 'bar', contextLines: 1, include: 'a.ts' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.hits[0].context?.before).toEqual(['const foo = 1;']);
    expect(r.value.hits[0].context?.after).toEqual(['']);
  });

  it('caps results and reports truncated', async () => {
    const r = await grepTool.execute({ pattern: 'foo', maxResults: 1 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.hits.length).toBe(1);
    expect(r.value.truncated).toBe(true);
  });
});