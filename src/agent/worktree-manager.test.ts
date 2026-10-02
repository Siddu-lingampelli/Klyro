/**
 * Worktree-manager tests. All git-touching suites are skipped when git is
 * unavailable (version-proof `skip` wrapper — no reliance on `it.runIf`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  ensureGitRepo,
  createWorktree,
  mergeWorktree,
  removeWorktree,
  repoTopLevel,
  pruneStaleWorktrees,
} from './worktree-manager.js';

function gitAvailable(): boolean {
  try {
    const r = spawnSync('git', ['--version'], { timeout: 10_000, windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

const GIT = gitAvailable();
const maybe = GIT ? describe : describe.skip;

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, timeout: 30_000, windowsHide: true, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}

let repoDir = '';
let n = 0;

/** Windows file locking (AV/indexer) can EBUSY a fresh rmdir — retry briefly. */
async function rmRetry(dir: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

/**
 * Create a temp dir OUTSIDE any repo ancestry. os.tmpdir() alone cannot be
 * trusted for "not a repo" cases: an ancestor of the temp dir may itself be
 * a git repo (and 8.3 short-name aliases defeat GIT_CEILING_DIRECTORIES
 * string matching). Prefer the filesystem root of the cwd, verified
 * repo-free; the root is not writable everywhere (Linux `/` for non-root
 * CI users → EACCES), so fall back to os.tmpdir() candidates that are
 * likewise verified repo-free before use.
 */
async function mkHermitDir(prefix: string): Promise<string> {
  const candidates = [path.parse(process.cwd()).root, os.tmpdir()];
  for (const base of candidates) {
    let dir: string;
    try {
      dir = await fs.mkdtemp(path.join(base, prefix));
    } catch {
      continue; // EACCES/EROFS/ENOENT — try the next base
    }
    try {
      if (await hasRepoAncestor(dir)) {
        await rmRetry(dir);
        continue;
      }
      return dir;
    } catch {
      await rmRetry(dir).catch(() => undefined);
    }
  }
  throw new Error('mkHermitDir: no writable repo-free temp base');
}

/** Lexical walk-up for a `.git` dir or worktree gitfile (no git binary needed). */
async function hasRepoAncestor(dir: string): Promise<boolean> {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      await fs.stat(path.join(cur, '.git'));
      return true;
    } catch { /* no .git here — keep climbing */ }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-wt-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@klyro.dev']);
  git(dir, ['config', 'user.name', 'klyro-test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

describe('ensureGitRepo repo detection', () => {
  it('returns false for a plain directory', async () => {
    const dir = await mkHermitDir('klyro-norepo-');
    try {
      await expect(ensureGitRepo(dir)).resolves.toBe(false);
    } finally {
      await rmRetry(dir);
    }
  });

  it('returns false for a missing directory', async () => {
    await expect(ensureGitRepo(path.join(os.tmpdir(), 'klyro-definitely-missing-xyz'))).resolves.toBe(false);
  });
});

maybe('worktree lifecycle', () => {
  beforeEach(async () => {
    repoDir = await initRepo();
    n += 1;
  });

  afterEach(async () => {
    if (repoDir) await rmRetry(repoDir);
    repoDir = '';
  });

  it('ensureGitRepo detects the repo and repoTopLevel resolves', async () => {
    await expect(ensureGitRepo(repoDir)).resolves.toBe(true);
    const top = await repoTopLevel(repoDir);
    // realpath both sides: tmpdir may use 8.3 short names that git resolves.
    expect(await fs.realpath(top)).toBe(await fs.realpath(repoDir));
  });

  it('create → edit → commit → merge → remove round-trips', async () => {
    const taskId = `t${n}_roundtrip`;
    const wt = await createWorktree({ repoCwd: repoDir, taskId });
    expect(wt.branch).toBe(`klyro/${taskId}`);
    try {
      await fs.writeFile(path.join(wt.worktreePath, 'child.txt'), 'from child\n');
      git(wt.worktreePath, ['add', '.']);
      git(wt.worktreePath, ['commit', '-m', 'child work']);
      const m = await mergeWorktree({ repoCwd: repoDir, branch: wt.branch });
      expect(m).toEqual({ merged: true, conflictFiles: [] });
      const content = await fs.readFile(path.join(repoDir, 'child.txt'), 'utf-8');
      expect(content.replace(/\r\n/g, '\n')).toBe('from child\n');
    } finally {
      await removeWorktree({ repoCwd: repoDir, worktreePath: wt.worktreePath, force: true }).catch(() => undefined);
    }
  });

  it('conflicting edits report conflictFiles without committing the merge', async () => {
    const taskId = `t${n}_conflict`;
    const wt = await createWorktree({ repoCwd: repoDir, taskId });
    try {
      await fs.writeFile(path.join(wt.worktreePath, 'base.txt'), 'child side\n');
      git(wt.worktreePath, ['add', '.']);
      git(wt.worktreePath, ['commit', '-m', 'child edit']);
      await fs.writeFile(path.join(repoDir, 'base.txt'), 'parent side\n');
      git(repoDir, ['add', '.']);
      git(repoDir, ['commit', '-m', 'parent edit']);
      const m = await mergeWorktree({ repoCwd: repoDir, branch: wt.branch });
      expect(m.merged).toBe(false);
      expect(m.conflictFiles).toContain('base.txt');
      // Merge was aborted: no MERGE_HEAD, working tree keeps the parent side.
      const mergeHead = await fs.stat(path.join(repoDir, '.git', 'MERGE_HEAD')).then(() => true).catch(() => false);
      expect(mergeHead).toBe(false);
    } finally {
      await removeWorktree({ repoCwd: repoDir, worktreePath: wt.worktreePath, force: true }).catch(() => undefined);
    }
  });

  it('removeWorktree drops the worktree from git metadata', async () => {
    const taskId = `t${n}_remove`;
    const wt = await createWorktree({ repoCwd: repoDir, taskId });
    await removeWorktree({ repoCwd: repoDir, worktreePath: wt.worktreePath });
    await expect(fs.stat(wt.worktreePath)).rejects.toThrow();
  });

  it('a merge failure with no conflicts reports error instead of empty conflictFiles', async () => {
    const m = await mergeWorktree({ repoCwd: repoDir, branch: 'klyro/does-not-exist' });
    expect(m.merged).toBe(false);
    expect(m.error).toBeDefined();
  });

  it('pruneStaleWorktrees removes only inactive task worktrees', async () => {
    const keepId = `t${n}_keep`;
    const staleId = `t${n}_stale`;
    const keep = await createWorktree({ repoCwd: repoDir, taskId: keepId });
    const stale = await createWorktree({ repoCwd: repoDir, taskId: staleId });
    try {
      const removed = await pruneStaleWorktrees(repoDir, [keepId]);
      expect(removed).toContain(stale.worktreePath);
      expect(removed).not.toContain(keep.worktreePath);
      await expect(fs.stat(stale.worktreePath)).rejects.toThrow();
      await expect(fs.stat(keep.worktreePath)).resolves.toBeDefined();
      // Second sweep is a no-op for the already-removed entry.
      const again = await pruneStaleWorktrees(repoDir, [keepId]);
      expect(again).not.toContain(stale.worktreePath);
    } finally {
      await removeWorktree({ repoCwd: repoDir, worktreePath: keep.worktreePath, force: true }).catch(() => undefined);
      await removeWorktree({ repoCwd: repoDir, worktreePath: stale.worktreePath, force: true }).catch(() => undefined);
    }
  });
});

describe('pruneStaleWorktrees never throws', () => {
  it('returns [] outside a repo instead of throwing', async () => {
    const dir = await mkHermitDir('klyro-norepo-prune-');
    try {
      await expect(pruneStaleWorktrees(dir, [])).resolves.toEqual([]);
    } finally {
      await rmRetry(dir);
    }
  });
});
