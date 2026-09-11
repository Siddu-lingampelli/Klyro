import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractSymbols, formatRepoMap, buildRepoMap, clearRepoMapCache } from './repo-map.js';
import type { RepoFile } from './repo-map.js';

describe('extractSymbols', () => {
  it('extracts TypeScript function, class, type, const', () => {
    const src = [
      'export function foo() {}',
      'export class Bar {}',
      'export type Baz = string;',
      'export const x = 1;',
      'export async function quux() {}',
    ].join('\n');
    const syms = extractSymbols(src, '.ts');
    const names = syms.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('function:foo');
    expect(names).toContain('class:Bar');
    expect(names).toContain('type:Baz');
    expect(names).toContain('const:x');
    expect(names).toContain('function:quux');
  });

  it('extracts Python def and class', () => {
    const src = [
      'def hello():',
      '    pass',
      'class Greeter:',
      '    pass',
    ].join('\n');
    const syms = extractSymbols(src, '.py');
    const names = syms.map((s) => s.name);
    expect(names).toContain('hello');
    expect(names).toContain('Greeter');
  });

  it('returns [] for empty', () => {
    expect(extractSymbols('', '.ts')).toEqual([]);
  });
});

describe('formatRepoMap', () => {
  it('omits files with no symbols', () => {
    const files: RepoFile[] = [
      { path: 'empty.ts', symbols: [] },
      { path: 'full.ts', symbols: [{ kind: 'function', name: 'x', line: 1 }] },
    ];
    const out = formatRepoMap(files);
    expect(out).toContain('# full.ts');
    expect(out).not.toContain('empty.ts');
  });
});

describe('buildRepoMap cache', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-rmap-'));
    clearRepoMapCache();
  });

  it('serves the cache when nothing changed', async () => {
    await fs.writeFile(path.join(cwd, 'a.ts'), 'export function foo() {}\n');
    const first = await buildRepoMap({ cwd });
    const second = await buildRepoMap({ cwd });
    expect(second).toBe(first);
  });

  it('rebuilds when a tracked file changes', async () => {
    await fs.writeFile(path.join(cwd, 'a.ts'), 'export function foo() {}\n');
    const first = await buildRepoMap({ cwd });
    expect(first[0]?.symbols.map((s) => s.name)).toContain('foo');
    await fs.writeFile(path.join(cwd, 'a.ts'), 'export function foo() {}\nexport function bar() {}\n');
    const second = await buildRepoMap({ cwd });
    expect(second).not.toBe(first);
    expect(second[0]?.symbols.map((s) => s.name)).toContain('bar');
  });
});
