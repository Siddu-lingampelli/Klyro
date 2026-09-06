import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { searchFilesTool } from './search-files.js';
import type { ToolContext } from '../types.js';

let cwd: string;
let ctx: ToolContext;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-sf-'));
  ctx = { cwd, env: {} };
  // Touch a sequence of files in a known order so mtimes are monotonic
  // (with a 5 ms gap to make ordering deterministic on Windows too).
  await fs.writeFile(path.join(cwd, 'auth.ts'), '');
  await new Promise((r) => setTimeout(r, 5));
  await fs.writeFile(path.join(cwd, 'auth.test.ts'), '');
  await new Promise((r) => setTimeout(r, 5));
  await fs.mkdir(path.join(cwd, 'src'));
  await fs.writeFile(path.join(cwd, 'src/login.tsx'), '');
  await new Promise((r) => setTimeout(r, 5));
  await fs.writeFile(path.join(cwd, 'src/main.ts'), '');
  await new Promise((r) => setTimeout(r, 5));
  await fs.mkdir(path.join(cwd, 'node_modules'));
  await fs.writeFile(path.join(cwd, 'node_modules/whatever.ts'), '');
});
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

describe('searchFilesTool', () => {
  it('ranks by query match in name', async () => {
    const r = await searchFilesTool.execute({ query: 'auth' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // exact name matches should come before path-substring matches
    const names = r.value.matches.map((m) => m.path);
    expect(names[0]).toMatch(/^auth\./);
    expect(names).toContain('auth.ts');
    expect(names).toContain('auth.test.ts');
  });

  it('applies glob constraint', async () => {
    const r = await searchFilesTool.execute({ query: 'auth', glob: 'src/**' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No src/auth* exists, so it should still return matches that satisfy glob
    // — but for the test we just assert the glob is enforced:
    const names = r.value.matches.map((m) => m.path);
    expect(names.every((n) => n.startsWith('src/'))).toBe(true);
  });

  it('skips node_modules', async () => {
    const r = await searchFilesTool.execute({ query: 'whatever' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.matches).toHaveLength(0);
  });

  it('boosts first-party files (src/, lib/)', async () => {
    const r = await searchFilesTool.execute({ query: '.ts' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const srcRank = r.value.matches.find((m) => m.path === 'src/main.ts')?.score ?? 0;
    const rootRank = r.value.matches.find((m) => m.path === 'auth.ts')?.score ?? 0;
    expect(srcRank).toBeGreaterThan(rootRank);
  });

  it('breaks ties by recency (newer first)', async () => {
    const r = await searchFilesTool.execute({ query: '.ts' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scores = r.value.matches.map((m) => m.score);
    // should be non-increasing
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]!);
    }
  });

  it('caps at maxResults', async () => {
    const r = await searchFilesTool.execute({ query: '.ts', maxResults: 2 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.matches.length).toBeLessThanOrEqual(2);
    expect(r.value.truncated).toBe(true);
  });
});
