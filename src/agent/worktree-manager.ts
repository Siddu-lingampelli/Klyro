/**
 * Git worktree isolation for parallel write-capable child agents.
 *
 * Each write-capable child gets its own worktree on a branch
 * `klyro/<taskId>` so concurrent children never clobber each other's files.
 * `task_apply` merges the branch back into the parent tree; failures,
 * cancellations, and timeouts remove the worktree best-effort.
 *
 * Semantics worth knowing:
 *   - Dirty parent: the merge runs in the parent checkout, so uncommitted
 *     parent edits can conflict. On conflict the merge is ABORTED (no
 *     commit), the branch is kept, and the caller gets MERGE_CONFLICT with
 *     the file list — resolve and re-apply.
 *   - Stale branch: a leftover `klyro/<taskId>` branch (e.g. from a crashed
 *     session) makes `createWorktree` fail. Delete the stale branch
 *     (`deleteBranch`) or sweep orphaned worktrees (`pruneStaleWorktrees`)
 *     before retrying.
 *   - No-apply: tasks that never reach `succeeded` are NEVER merged — their
 *     worktrees are removed best-effort and `task_apply` reports NOT_READY.
 *
 * All git invocations go through `execFile` argv (no shell) with a ~30s
 * timeout, so this is safe on Windows.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { filteredEnv } from '../tools/shell/shell-exec.js';

const execFileAsync = promisify(execFile);

/** Per-command timeout for every git invocation. */
export const GIT_TIMEOUT_MS = 30_000;

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
}

export interface MergeResult {
  merged: boolean;
  conflictFiles: string[];
}

async function git(repoCwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  // Filtered env (same call shape as shell-exec) so secrets never reach
  // child processes. Then strip repo-pinning vars so discovery is always
  // relative to `repoCwd` (a sandbox may export GIT_DIR for its own
  // harness — that must not make every directory look like a repo).
  const env: NodeJS.ProcessEnv = { ...filteredEnv() };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_NAMESPACE;
  const r = await execFileAsync('git', [...args], {
    cwd: repoCwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env,
  });
  return { stdout: r.stdout, stderr: r.stderr };
}

/** True when `cwd` is inside a git working tree. Never throws — false on any failure. */
export async function ensureGitRepo(cwd: string): Promise<boolean> {
  try {
    const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Resolve the repo top-level for any path inside it. Throws when not in a repo. */
export async function repoTopLevel(cwd: string): Promise<string> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.stdout.trim();
}

function branchForTask(taskId: string): string {
  return `klyro/${taskId}`;
}

/**
 * Create an isolated worktree for a task on branch `klyro/<taskId>`,
 * rooted at `<repo>/.klyro/worktrees/<taskId>` from HEAD.
 */
export async function createWorktree(opts: { repoCwd: string; taskId: string }): Promise<WorktreeInfo> {
  const branch = branchForTask(opts.taskId);
  const top = await repoTopLevel(opts.repoCwd);
  const worktreePath = path.join(top, '.klyro', 'worktrees', opts.taskId);
  await git(opts.repoCwd, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  return { worktreePath, branch };
}

/**
 * Merge a task branch into the current checkout (`repoCwd`) with
 * `git merge --no-ff --no-edit`. On conflict, parses `git status
 * --porcelain` for unmerged paths (UU/AA/DD), aborts the merge WITHOUT
 * committing, and returns `{ merged: false, conflictFiles }`.
 */
export async function mergeWorktree(opts: { repoCwd: string; branch: string }): Promise<MergeResult> {
  try {
    await git(opts.repoCwd, ['merge', '--no-ff', '--no-edit', opts.branch]);
    return { merged: true, conflictFiles: [] };
  } catch {
    const conflictFiles = await unmergedFiles(opts.repoCwd);
    try {
      await git(opts.repoCwd, ['merge', '--abort']);
    } catch {
      /* best-effort: leave the repo as-is if abort itself fails */
    }
    return { merged: false, conflictFiles };
  }
}

async function unmergedFiles(repoCwd: string): Promise<string[]> {
  try {
    const r = await git(repoCwd, ['status', '--porcelain']);
    const out: string[] = [];
    for (const line of r.stdout.split('\n')) {
      if (line.length < 4) continue;
      const x = line[0];
      const y = line[1];
      const unmerged = (x === 'U' || y === 'U' || x === 'A' || y === 'A') && (x === 'U' || y === 'U' || (x === 'A' && y === 'A'));
      // Unmerged statuses: UU, AA, DD, AU, UA, UD, DU.
      const code = `${x}${y}`;
      if (['UU', 'AA', 'DD', 'AU', 'UA', 'UD', 'DU'].includes(code) || unmerged) {
        out.push(line.slice(3).trim());
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Remove a worktree and prune its metadata. Throws with context on failure. */
export async function removeWorktree(opts: {
  repoCwd: string;
  worktreePath: string;
  force?: boolean;
}): Promise<void> {
  const args = ['worktree', 'remove', ...(opts.force ? ['--force'] : []), opts.worktreePath];
  try {
    await git(opts.repoCwd, args);
  } catch (err) {
    throw new Error(
      `git worktree remove failed for ${opts.worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      await git(opts.repoCwd, ['worktree', 'prune']);
    } catch {
      /* best-effort */
    }
  }
}

/** Delete a task branch (best-effort cleanup after a successful merge). Never throws. */
export async function deleteBranch(opts: { repoCwd: string; branch: string }): Promise<void> {
  try {
    await git(opts.repoCwd, ['branch', '-D', opts.branch]);
  } catch {
    /* best-effort */
  }
}

/**
 * Remove worktrees under `.klyro/worktrees` whose task id is NOT in
 * `activeTaskIds` (orphans from crashed/timed-out sessions). Lists
 * `git worktree list --porcelain`, force-removes each stale entry, and
 * returns the removed paths. Never throws — per-worktree failures are
 * skipped and a failing `git` itself yields `[]`.
 */
export async function pruneStaleWorktrees(repoCwd: string, activeTaskIds: readonly string[]): Promise<string[]> {
  const removed: string[] = [];
  try {
    const r = await git(repoCwd, ['worktree', 'list', '--porcelain']);
    const active = new Set(activeTaskIds);
    for (const line of r.stdout.split('\n')) {
      const wp = /^worktree (.+)$/.exec(line.trim())?.[1];
      if (!wp) continue;
      // Only manage our own namespace: <repo>/.klyro/worktrees/<taskId>.
      const parts = wp.split(/[\\/]/);
      const idx = parts.lastIndexOf('worktrees');
      if (idx < 1 || parts[idx - 1] !== '.klyro' || idx + 1 >= parts.length) continue;
      const taskId = parts[idx + 1];
      if (!taskId || active.has(taskId)) continue;
      try {
        await removeWorktree({ repoCwd, worktreePath: wp, force: true });
        removed.push(wp);
      } catch {
        /* skip — never throws */
      }
    }
  } catch {
    /* git itself failed (not a repo, binary missing) — return what we have */
  }
  return removed;
}
