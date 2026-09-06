import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { recentFilesTool } from './recent-files.js';
import type { ToolContext } from '../types.js';

let cwd: string;
let ctx: ToolContext;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-rf-'));
  ctx = { cwd, env: {} };
});
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

describe('recentFilesTool', () => {
  it('returns files modified within the window, newest first', async () => {
    await fs.writeFile(path.join(cwd, 'a.ts'), '');
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(path.join(cwd, 'b.ts'), '');
    const r = await recentFilesTool.execute({ sinceHours: 24 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.files.length).toBeGreaterThanOrEqual(2);
    expect(r.value.files[0]!.path).toBe('b.ts');
    expect(r.value.files[1]!.path).toBe('a.ts');
  });

  it('excludes files older than the window', async () => {
    const old = path.join(cwd, 'old.ts');
    await fs.writeFile(old, '');
    // Backdate the file 100 hours.
    const past = new Date(Date.now() - 100 * 60 * 60 * 1000);
    await fs.utimes(old, past, past);

    await fs.writeFile(path.join(cwd, 'fresh.ts'), '');

    const r = await recentFilesTool.execute({ sinceHours: 24 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.value.files.map((f) => f.path);
    expect(names).toContain('fresh.ts');
    expect(names).not.toContain('old.ts');
  });

  it('skips node_modules / dist / .klyro / binary extensions', async () => {
    await fs.mkdir(path.join(cwd, 'node_modules'));
    await fs.writeFile(path.join(cwd, 'node_modules/x.ts'), '');
    await fs.mkdir(path.join(cwd, 'dist'));
    await fs.writeFile(path.join(cwd, 'dist/bundle.js'), '');
    await fs.mkdir(path.join(cwd, '.klyro'));
    await fs.writeFile(path.join(cwd, '.klyro/notes.md'), '');
    await fs.writeFile(path.join(cwd, 'logo.png'), '');

    const r = await recentFilesTool.execute({ sinceHours: 24 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.value.files.map((f) => f.path);
    expect(names.every((n) => !n.startsWith('node_modules/'))).toBe(true);
    expect(names.every((n) => !n.startsWith('dist/'))).toBe(true);
    expect(names.every((n) => !n.startsWith('.klyro/'))).toBe(true);
    expect(names).not.toContain('logo.png');
  });

  it('applies glob constraint', async () => {
    await fs.writeFile(path.join(cwd, 'src.ts'), '');
    await fs.mkdir(path.join(cwd, 'src'));
    await fs.writeFile(path.join(cwd, 'src/inner.ts'), '');
    const r = await recentFilesTool.execute({ sinceHours: 24, glob: 'src/**' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.value.files.map((f) => f.path);
    expect(names).toContain('src/inner.ts');
    expect(names).not.toContain('src.ts');
  });
});
