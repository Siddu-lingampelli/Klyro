/**
 * Path safety: ensure every file path the agent touches stays inside `cwd`.
 *
 * Refuses:
 *   - absolute paths outside cwd
 *   - parent-directory traversal (`..`)
 *   - symlinks that resolve outside cwd
 *
 * Uses `path.resolve` then `path.relative` to check. On Windows, the
 * comparison is case-insensitive.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { TOOL_ERROR_CODES, type ToolErrorCode } from '../tools/normalize.js';

export interface PathGuardResult {
  /** Absolute, normalized path that IS inside cwd. */
  resolved: string;
}

export class PathGuardError extends Error {
  public readonly code: ToolErrorCode;
  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'PathGuardError';
  }
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

function normalizeForCompare(p: string): string {
  // Realpath resolves symlinks and gives a canonical absolute path.
  // We don't realpath here (caller does that explicitly when needed).
  // For the within-cwd check we normalize case on Windows.
  return isWindows() ? p.toLowerCase() : p;
}

/**
 * Resolve a (possibly relative) path against cwd and assert it stays inside.
 * Does NOT follow symlinks — call `resolveAndFollowSymlinks` for that.
 */
export function resolveWithinCwd(cwd: string, requested: string): PathGuardResult {
  if (!requested || requested.length === 0) {
    throw new PathGuardError(TOOL_ERROR_CODES.INVALID_INPUT, 'Path is empty');
  }
  const absCwd = path.resolve(cwd);
  const resolved = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(absCwd, requested);

  // Use relative to test containment. path.relative throws on different
  // drives on Windows; normalize to handle that.
  const rel = path.relative(absCwd, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return { resolved };
  }
  // Different drive on Windows: relative starts with a drive letter
  if (isWindows() && /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new PathGuardError(TOOL_ERROR_CODES.PATH_ESCAPE, `Path escapes cwd (different drive): ${requested}`);
  }
  throw new PathGuardError(TOOL_ERROR_CODES.PATH_ESCAPE, `Path escapes cwd: ${requested}`);
}

/**
 * Resolve, follow symlinks, and assert the target stays inside cwd.
 * Use this for read_file / write_file to defeat symlink-based escapes.
 */
export async function resolveAndFollowSymlinks(cwd: string, requested: string): Promise<PathGuardResult> {
  const { resolved } = resolveWithinCwd(cwd, requested);
  let real: string;
  let realParent: string;
  try {
    real = await fs.realpath(resolved);
    realParent = path.dirname(real);
  } catch {
    // File doesn't exist yet (e.g. write_file). realpath would fail; fall
    // back to realpath-ing the parent.
    const parent = path.dirname(resolved);
    try {
      realParent = await fs.realpath(parent);
    } catch {
      // Parent doesn't exist either. Don't trust the unresolved parent —
      // re-validate it against cwd and bail if it's not inside.
      const { resolved: parentResolved } = resolveWithinCwd(cwd, parent);
      realParent = parentResolved;
    }
    real = path.join(realParent, path.basename(resolved));
  }
  const absCwd = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const cmpReal = normalizeForCompare(real);
  const cmpCwd = normalizeForCompare(absCwd);
  if (cmpReal !== cmpCwd && !cmpReal.startsWith(cmpCwd + path.sep)) {
    throw new PathGuardError(
      TOOL_ERROR_CODES.PATH_ESCAPE,
      `Symlink target escapes cwd: ${requested} -> ${real}`,
    );
  }
  // Defense-in-depth: ensure the parent directory of the resolved target
  // is also inside cwd. This catches the case where the requested path
  // walks through a symlinked parent (e.g. `<cwd>/evil-link/../escape`)
  // and `real` happens to land back inside cwd but the parent was outside.
  // Skip when the target itself is cwd (realParent would be the parent of
  // cwd, which is necessarily outside).
  if (real !== absCwd) {
    const cmpRealParent = normalizeForCompare(realParent);
    if (cmpRealParent !== cmpCwd && !cmpRealParent.startsWith(cmpCwd + path.sep)) {
      throw new PathGuardError(
        TOOL_ERROR_CODES.PATH_ESCAPE,
        `Path escapes cwd via parent symlink: ${requested} -> ${realParent}`,
      );
    }
  }
  return { resolved: real };
}
