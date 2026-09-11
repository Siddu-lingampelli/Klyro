import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyPatchTool } from './apply-patch.js';

describe('apply_patch', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-patch-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('applies Codex-style patch', async () => {
    const patch = `*** Begin Patch\n*** Update File: a.txt\n+hello world\n*** End Patch`;
    const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).toContain('hello world');
  });

  it('rejects invalid patch', async () => {
    const r = await applyPatchTool.execute({ patch: 'not a patch' }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(false);
  });

  it('applies real hunks with context and removals', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'line1\nline2\nline3\n', 'utf-8');
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+LINE2',
      ' line3',
      '*** End Patch',
    ].join('\n');
    const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).toBe('line1\nLINE2\nline3\n');
  });

  it('applies multi-hunk patches and tolerates line drift', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'a\nb\nc\nd\ne\nf\n', 'utf-8');
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
      '@@ -5,2 +5,2 @@',
      ' e',
      '-f',
      '+F',
      '*** End Patch',
    ].join('\n');
    const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).toBe('a\nB\nc\nd\ne\nF\n');
  });

  it('rejects mismatched hunks instead of corrupting', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'totally\ndifferent\n', 'utf-8');
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@ -1,2 +1,2 @@',
      '-nope',
      '+YES',
      ' different',
      '*** End Patch',
    ].join('\n');
    const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(false);
    // file untouched
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).toBe('totally\ndifferent\n');
  });

  it('rejects hunk-less edits to existing files', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'real content here, more than enough bytes to matter........', 'utf-8');
    const patch = `*** Begin Patch\n*** Update File: a.txt\n+junk at eof\n*** End Patch`;
    const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(false);
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).not.toContain('junk');
  });

  it('creates files via Add File', async () => {
    const patch = `*** Begin Patch\n*** Add File: sub/b.txt\n+line one\n+line two\n*** End Patch`;
    const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'sub', 'b.txt'), 'utf-8')).toBe('line one\nline two\n');
  });

  it('repairGuard denies test-file patches', async () => {
    const patch = `*** Begin Patch\n*** Add File: foo.test.ts\n+hello\n*** End Patch`;
    const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {}, repairGuard: { denyTestEdits: true } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('POLICY_DENIED');
      expect(r.error.message).toMatch(/repair-guard/);
    }
  });

  it('repairGuard ignores assertion-like content in non-test files', async () => {
    const patch = `*** Begin Patch\n*** Add File: src/util.ts\n+it.skip("x", () => {})\n*** End Patch`;
    const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {}, repairGuard: { denyTestEdits: true } });
    expect(r.ok).toBe(true);
  });

  it('repairGuard allows latest.ts / attest.ts (not test-like)', async () => {
    for (const name of ['latest.ts', 'attest.ts']) {
      const patch = `*** Begin Patch\n*** Add File: ${name}\n+hello\n*** End Patch`;
      const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {}, repairGuard: { denyTestEdits: true } });
      expect(r.ok).toBe(true);
    }
  });

  it('rejects Delete sections with INVALID_PATCH', async () => {
    const patch = `*** Begin Patch\n*** Delete File: a.txt\n*** End Patch`;
    const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_PATCH');
  });
  it('pre-write re-resolve accepts equivalent spellings (no false positive)', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'line1\nline2\n', 'utf-8');
    await fs.mkdir(path.join(tmp, 'sub'), { recursive: true });
    const patch = [
      '*** Begin Patch',
      '*** Update File: sub/../a.txt',
      '@@ -1,2 +1,2 @@',
      ' line1',
      '-line2',
      '+LINE2',
      '*** End Patch',
    ].join('\n');
    const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {} });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf-8')).toBe('line1\nLINE2\n');
  });

  it('agentAllowedPaths denies patch targets outside the set', async () => {
    const patch = `*** Begin Patch\n*** Add File: outside/x.txt\n+hi\n*** End Patch`;
    const r = await applyPatchTool.execute({ patch }, { cwd: tmp, env: {}, agentAllowedPaths: [path.join(tmp, 'inside')] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('POLICY_DENIED');
  });
});
