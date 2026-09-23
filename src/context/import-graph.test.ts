import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { buildImportGraph, importsOf, clearImportGraphCache } from './import-graph.js';

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-ig-'));
  clearImportGraphCache();
});

describe('buildImportGraph freshness', () => {
  it('rebuilds when a tracked file changes', async () => {
    await fs.writeFile(path.join(cwd, 'a.ts'), `import {} from './b';\n`, 'utf-8');
    await fs.writeFile(path.join(cwd, 'b.ts'), `export const b = 1;\n`, 'utf-8');
    await fs.writeFile(path.join(cwd, 'c.ts'), `export const c = 1;\n`, 'utf-8');
    expect(await importsOf(cwd, 'a.ts')).toContain('b');

    // Edit a.ts to import ./c instead. NOTE: './b' → './c' preserves byte
    // size, and rapid rewrites can share a Windows mtimeMs tick — so force
    // the mtime forward instead of relying on stat granularity (the
    // production cache keys on {mtimeMs, size} by design; see import-graph.ts).
    const aPath = path.join(cwd, 'a.ts');
    await fs.writeFile(aPath, `import {} from './c';\n`, 'utf-8');
    const st = await fs.stat(aPath);
    await fs.utimes(aPath, st.atime, new Date(st.mtimeMs + 2000));
    expect(await importsOf(cwd, 'a.ts')).toContain('c');
    expect(await importsOf(cwd, 'a.ts')).not.toContain('b');
  });

  it('rebuilds when a tracked file is deleted', async () => {
    await fs.writeFile(path.join(cwd, 'a.ts'), `export const a = 1;\n`, 'utf-8');
    const g1 = await buildImportGraph(cwd);
    expect(g1.nodes.has('a.ts')).toBe(true);
    await fs.unlink(path.join(cwd, 'a.ts'));
    const g2 = await buildImportGraph(cwd);
    expect(g2.nodes.has('a.ts')).toBe(false);
  });

  it('serves the cache when nothing changed', async () => {
    await fs.writeFile(path.join(cwd, 'a.ts'), `export const a = 1;\n`, 'utf-8');
    const g1 = await buildImportGraph(cwd);
    const g2 = await buildImportGraph(cwd);
    expect(g2).toBe(g1);
  });
});
