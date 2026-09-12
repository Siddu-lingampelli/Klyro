/**
 * write_file — write content to a file in the workspace.
 *
 * Atomic write via tmp + rename. Refuses paths outside cwd. Creates parent
 * directories if needed.
 */

import * as fs from 'node:fs/promises';
import * as fsSyncNode from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveAndFollowSymlinks, assertNotSymlink, openNoFollowForWrite } from '../../policy/path-guard.js';
import { safe } from '../normalize.js';

// Extension-anchored: matches test.ts, foo.test.ts, foo-test.ts, foo.spec.js,
// __tests__ segments — but NOT latest.ts / attest.ts / contest-data.
const TEST_BASENAME_RE = /(^|[._-])(test|spec)\.[^.]+$|\.test\.[^.]+$|\.spec\.[^.]+$|__(tests|snapshots)__/i;

function checkRepairGuard(targetPath: string, _content: string, deny?: boolean): { ok: false; error: { code: string; message: string } } | null {
  if (!deny) return null;
  const base = targetPath.split(/[\\/]/).pop() ?? targetPath;
  // Basename alone decides. File CONTENT is never consulted for non-test
  // paths (the old assert-skip regex over-blocked ordinary sources
  // containing e.g. `it(` or `test(`), and stays unconsulted for test-like
  // paths too since the basename already denies.
  if (!TEST_BASENAME_RE.test(base)) return null;
  return { ok: false, error: { code: 'POLICY_DENIED', message: 'repair-guard: test edits denied (denyTestEdits)' } };
}

async function checkAllowedPaths(cwd: string, resolved: string, allowed?: readonly string[]): Promise<{ ok: false; error: { code: string; message: string } } | null> {
  if (!allowed) return null;
  // Canonicalize both sides (realpath) so lexical-vs-canonical spellings
  // of the same directory (e.g. Windows 8.3 short names) compare equal.
  const canon = async (p: string): Promise<string> => {
    try { return await fs.realpath(p); } catch { return path.resolve(p); }
  };
  const canonTarget = await canon(resolved);
  for (const base of allowed) {
    const absBase = path.isAbsolute(base) ? path.resolve(base) : path.resolve(cwd, base);
    const canonBase = await canon(absBase);
    const rel = path.relative(canonBase, canonTarget);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return null;
  }
  return { ok: false, error: { code: 'POLICY_DENIED', message: `agent path not allowed: ${resolved}` } };
}

const InputSchema = z.object({
  path: z.string().min(1).describe('Path relative to cwd or absolute (must be inside cwd)'),
  content: z.string().describe('File content. Use empty string to truncate.'),
});

export interface WriteFileOutput {
  path: string;
  bytesWritten: number;
}

import { wasRead } from './read-history.js';

export const writeFileTool = defineTool<z.infer<typeof InputSchema>, WriteFileOutput>({
  name: 'write_file',
  description:
    'Write content to a file. Atomic: writes to a temp file then renames. Creates parent directories as needed.',
  inputSchema: InputSchema,
  permission: 'edit',
  isConcurrencySafe: false,
  renderCall: (input) => `write_file ${input.path} (${input.content.length} chars)`,
  renderResult: (output) => `${output.path} written ${output.bytesWritten} bytes`,
  execute: async (input, ctx) => {
    return safe(async () => {
      const guard = checkRepairGuard(input.path, input.content, ctx.repairGuard?.denyTestEdits);
      if (guard) return guard as unknown as WriteFileOutput;
      const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, input.path);
      const allowed = await checkAllowedPaths(ctx.cwd, resolved, ctx.agentAllowedPaths);
      if (allowed) return allowed as unknown as WriteFileOutput;
      const parent = path.dirname(resolved);
      await fs.mkdir(parent, { recursive: true });

      // 3.2: if file exists and was not read this session, warn but allow with diff
      let existing: string | null = null;
      let needsApproval = false;
      try {
        existing = await fs.readFile(resolved, 'utf-8');
        if (!wasRead(input.path, ctx.cwd) && existing.length > 200) {
          needsApproval = true;
        }
      } catch {
        // not exists — fine
      }

      const suffix = crypto.randomBytes(8).toString('hex');
      const tmp = path.join(parent, `.klyro-write-${process.pid}-${suffix}.tmp`);
      const data = Buffer.from(input.content, 'utf-8');
      // TOCTOU shrink (not elimination): re-resolve symlinks immediately
      // before the write and refuse if the target moved. A racing swap
      // between this check and rename can still occur.
      // NOTE: the pre-check resolution may be lexical (parent missing) while
      // the re-resolution is canonical (parent now exists), so compare
      // canonicalized forms — not raw strings — to avoid false positives
      // (e.g. Windows 8.3 short-name expansion after mkdir).
      const { resolved: reResolved } = await resolveAndFollowSymlinks(ctx.cwd, input.path);
      const canon = async (p: string): Promise<string> => {
        try { return await fs.realpath(p); } catch { /* missing file → try parent */ }
        try { return path.join(await fs.realpath(path.dirname(p)), path.basename(p)); } catch { return p; }
      };
      if ((await canon(reResolved)) !== (await canon(resolved))) {
        throw Object.assign(new Error(`Path target changed between check and write: ${input.path} (POLICY_DENIED)`), { code: 'POLICY_DENIED' });
      }
      // Truncate to 8k tokens ~32k chars for result.
      // The tmp file is opened O_NOFOLLOW (POSIX; plain 'w' on Windows —
      // see openNoFollowForWrite) so a planted link at the fresh tmp name
      // can't redirect the content write; atomic tmp+rename semantics stay.
      const fd = openNoFollowForWrite(parent, path.basename(tmp));
      try {
        fsSyncNode.writeFileSync(fd, data);
        fsSyncNode.fsyncSync(fd);
      } finally {
        try { fsSyncNode.closeSync(fd); } catch { /* already closed */ }
      }
      // Symlink-swap guard: lstat the final dest immediately before rename
      // and refuse if it became a symlink since the up-front resolve.
      await assertNotSymlink(resolved);
      try {
        await fs.rename(tmp, resolved);
      } catch (err) {
        await fs.unlink(tmp).catch(() => undefined);
        throw err;
      }
      // Compute diff for approval UI if needed
      let diff = '';
      if (existing !== null) {
        const before = existing.split('\n').slice(0, 20).join('\n');
        const after = input.content.split('\n').slice(0, 20).join('\n');
        if (before !== after) diff = `--- before\n${before.slice(0, 500)}\n+++ after\n${after.slice(0, 500)}`;
      }
      const result: WriteFileOutput & { diff?: string; needsApproval?: boolean } = {
        path: input.path,
        bytesWritten: data.byteLength,
      };
      if (diff) (result as unknown as Record<string, unknown>).diff = diff;
      if (needsApproval) (result as unknown as Record<string, unknown>).needsApproval = true;
      return result as WriteFileOutput;
    });
  },
});

export type WriteFileInput = z.infer<typeof InputSchema>;
