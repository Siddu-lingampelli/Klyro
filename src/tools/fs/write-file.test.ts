import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeFileTool } from './write-file.js';

describe('write_file guards', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-write-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('writes normally without guards', async () => {
    const r = await writeFileTool.execute({ path: 'a.txt', content: 'hello' }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).toBe('hello');
  });

  it('repairGuard denies test-file writes', async () => {
    const r = await writeFileTool.execute(
      { path: 'foo.test.ts', content: 'hello' },
      { cwd: tmp, env: {}, repairGuard: { denyTestEdits: true } },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('POLICY_DENIED');
      expect(r.error.message).toMatch(/repair-guard/);
    }
  });

  it('repairGuard ignores assertion-like content in non-test files', async () => {
    const r = await writeFileTool.execute(
      { path: 'src/util.ts', content: 'it.skip("x", () => {})' },
      { cwd: tmp, env: {}, repairGuard: { denyTestEdits: true } },
    );
    expect(r.ok).toBe(true);
  });

  it('repairGuard allows latest.ts / attest.ts (not test-like)', async () => {
    for (const p of ['latest.ts', 'attest.ts', 'contest-data.txt', 'src/latest.ts']) {
      const r = await writeFileTool.execute(
        { path: p, content: 'hello' },
        { cwd: tmp, env: {}, repairGuard: { denyTestEdits: true } },
      );
      expect(r.ok).toBe(true);
    }
  });

  it('repairGuard still denies spec-style test files', async () => {
    const r = await writeFileTool.execute(
      { path: 'foo.spec.ts', content: 'hello' },
      { cwd: tmp, env: {}, repairGuard: { denyTestEdits: true } },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('POLICY_DENIED');
  });

  it('repairGuard allows ordinary source writes', async () => {
    const r = await writeFileTool.execute(
      { path: 'src/util.ts', content: 'export const x = 1;\n' },
      { cwd: tmp, env: {}, repairGuard: { denyTestEdits: true } },
    );
    expect(r.ok).toBe(true);
  });

  it('agentAllowedPaths denies targets outside the set', async () => {
    const allowed = [path.join(tmp, 'allowed')];
    await fs.mkdir(allowed[0]!, { recursive: true });
    const ok = await writeFileTool.execute(
      { path: 'allowed/a.txt', content: 'hi' },
      { cwd: tmp, env: {}, agentAllowedPaths: allowed },
    );
    expect(ok.ok).toBe(true);
    const denied = await writeFileTool.execute(
      { path: 'other/b.txt', content: 'hi' },
      { cwd: tmp, env: {}, agentAllowedPaths: allowed },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('POLICY_DENIED');
  });

  it('assertNotSymlink: symlink throws PATH_ESCAPE, file/missing pass', async () => {
    const { assertNotSymlink } = await import('../../policy/path-guard.js');
    const target = path.join(tmp, 'real.txt');
    await fs.writeFile(target, 'data', 'utf-8');
    await assertNotSymlink(target); // regular file → ok
    await assertNotSymlink(path.join(tmp, 'nope.txt')); // missing → ok
    if (process.platform === 'win32') return; // symlink creation needs privilege (EPERM) on Windows
    const link = path.join(tmp, 'link.txt');
    await fs.symlink(target, link);
    const code = await assertNotSymlink(link).then(
      () => 'ok',
      (e: unknown) => (e as { code?: string }).code,
    );
    expect(code).toBe('PATH_ESCAPE');
  });

  it('openNoFollowForWrite creates and writes content', async () => {
    const { openNoFollowForWrite } = await import('../../policy/path-guard.js');
    const nodeFs = await import('node:fs');
    const fd = openNoFollowForWrite(tmp, 'nf.txt');
    try {
      nodeFs.writeFileSync(fd, 'hello');
    } finally {
      nodeFs.closeSync(fd);
    }
    expect(await fs.readFile(path.join(tmp, 'nf.txt'), 'utf-8')).toBe('hello');
  });

  it('denies writes redirected through a swapped-in symlink', async () => {
    if (process.platform === 'win32') return; // symlink creation needs privilege (EPERM) on Windows
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-write-out-'));
    try {
      const outsideFile = path.join(outside, 'secret.txt');
      await fs.writeFile(outsideFile, 'secret', 'utf-8');
      await fs.symlink(outsideFile, path.join(tmp, 'link.txt'));
      const r = await writeFileTool.execute({ path: 'link.txt', content: 'pwned' }, { cwd: tmp, env: {} });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('PATH_ESCAPE');
      expect(await fs.readFile(outsideFile, 'utf-8')).toBe('secret');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
