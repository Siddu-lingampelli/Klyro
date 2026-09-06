import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildLevel6Context, writeLevel6Cache, readLevel6Cache } from './level6.js';

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-l6-'));
});
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

describe('buildLevel6Context', () => {
  it('returns an empty context when the repo is empty', async () => {
    const ctx = await buildLevel6Context({ cwd });
    // Project map still emits a "not a git working tree" note; the rest is empty.
    expect(ctx.hasRepoMap).toBe(false);
    expect(ctx.hasRecentFiles).toBe(false);
    expect(ctx.hasDeps).toBe(false);
  });

  it('includes a project map when package.json is present', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'demo', packageManager: 'npm@10.0.0', scripts: { build: 'tsc' }, devDependencies: { vitest: '^4' },
    }));
    const ctx = await buildLevel6Context({ cwd });
    expect(ctx.hasProjectMap).toBe(true);
    expect(ctx.formatted).toMatch(/# Project map/);
    expect(ctx.formatted).toMatch(/Test framework: Vitest/);
  });

  it('includes a dependencies block when package.json has deps', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { react: '^19.0.0', lodash: '^4.17.0' },
      devDependencies: { vitest: '^4.0.0' },
    }));
    const ctx = await buildLevel6Context({ cwd });
    expect(ctx.hasDeps).toBe(true);
    expect(ctx.formatted).toMatch(/# Direct dependencies \(npm\)/);
    expect(ctx.formatted).toMatch(/react \^19\.0\.0/);
  });

  it('skips blocks when opted out', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'd' }));
    await fs.mkdir(path.join(cwd, 'src'));
    await fs.writeFile(path.join(cwd, 'src/a.ts'), 'export const a = 1;\n');
    const ctx = await buildLevel6Context({ cwd, skipProjectMap: true, skipDeps: true, skipRepoMap: true, skipRecentFiles: true });
    expect(ctx.formatted).toBe('');
  });

  it('truncates at maxTotalChars', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { a: '1', b: '2', c: '3', d: '4', e: '5' },
    }));
    const ctx = await buildLevel6Context({ cwd, maxTotalChars: 200 });
    expect(ctx.formatted.length).toBeLessThanOrEqual(220); // allow for [truncated] suffix
    expect(ctx.formatted).toContain('[truncated]');
  });

  it('omits the deps block on malformed JSON', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), '{not json');
    const ctx = await buildLevel6Context({ cwd });
    expect(ctx.hasDeps).toBe(false);
  });
});

describe('level6 cache', () => {
  it('round-trips through writeLevel6Cache / readLevel6Cache', async () => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'd' }));
    const ctx = await buildLevel6Context({ cwd });
    const written = await writeLevel6Cache(cwd, ctx);
    expect(written).toBeTruthy();
    const read = await readLevel6Cache(cwd);
    expect(read?.formatted).toBe(ctx.formatted);
    expect(read?.hasProjectMap).toBe(true);
  });

  it('readLevel6Cache returns null when no cache exists', async () => {
    const r = await readLevel6Cache(cwd);
    expect(r).toBeNull();
  });
});
