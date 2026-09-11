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
});
