/**
 * 4.2 — multi_edit: atomic sequential edits with rollback on failure
 */

import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveAndFollowSymlinks, assertNotSymlink } from '../../policy/path-guard.js';
import { safe } from '../normalize.js';
import { wasRead } from './read-history.js';
import { checkStaleness, recordEditStaleness } from './edit-file.js';
import * as path from 'node:path';

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

const EditSchema = z.object({
  find: z.string().min(1),
  replace: z.string(),
  replaceAll: z.boolean().optional(),
});

const InputSchema = z.object({
  path: z.string().min(1),
  edits: z.array(EditSchema).min(1).max(20),
});

export const multiEditTool = defineTool({
  name: 'multi_edit',
  description: 'Apply multiple sequential edits atomically to a file. Fails fast with rollback if any edit fails.',
  inputSchema: InputSchema,
  permission: 'edit',
  isConcurrencySafe: false,
  execute: async (input, ctx) => {
    return safe(async () => {
      const combined = input.edits.map((e) => `${e.find}\n${e.replace}`).join('\n');
      const guard = checkRepairGuard(input.path, combined, ctx.repairGuard?.denyTestEdits);
      if (guard) return guard as unknown as { path: string; edits: number; diff: string };
      const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, input.path, ctx.agentAllowedPaths);
      const allowed = await checkAllowedPaths(ctx.cwd, resolved, ctx.agentAllowedPaths);
      if (allowed) return allowed as unknown as { path: string; edits: number; diff: string };
      const stat = await fs.stat(resolved);
      let content = await fs.readFile(resolved, 'utf-8');
      if (checkStaleness(resolved, stat.mtimeMs, crypto.createHash('sha256').update(content, 'utf-8').digest('hex'))) {
        throw Object.assign(new Error(`File ${input.path} changed externally since last read — please re-read before editing`), { code: 'STALE' });
      }
      if (!wasRead(input.path, ctx.cwd) && content.length > 200) {
        throw Object.assign(
          new Error(`File ${input.path} was not read this session and is >200 bytes — re-read before editing (POLICY_DENIED)`),
          { code: 'POLICY_DENIED' },
        );
      }
      for (let i = 0; i < input.edits.length; i++) {
        const e = input.edits[i]!;
        const count = content.split(e.find).length - 1;
        if (count === 0) throw Object.assign(new Error(`edit ${i}: find not found`), { code: 'MATCH_NOT_FOUND' });
        if (!e.replaceAll && count > 1) throw Object.assign(new Error(`edit ${i}: ambiguous (${count} matches)`), { code: 'MATCH_AMBIGUOUS' });
        content = e.replaceAll ? content.split(e.find).join(e.replace) : content.replace(e.find, e.replace);
      }
      // TOCTOU shrink (mirrors write_file): re-resolve symlinks immediately
      // before the write and refuse if the target moved. Compares
      // canonicalized forms (not raw strings) to avoid false positives from
      // lexical-vs-canonical spellings (e.g. `sub/../a.txt`, short names).
      const { resolved: reResolved } = await resolveAndFollowSymlinks(ctx.cwd, input.path, ctx.agentAllowedPaths);
      const canon = async (p: string): Promise<string> => {
        try { return await fs.realpath(p); } catch { /* missing file → try parent */ }
        try { return path.join(await fs.realpath(path.dirname(p)), path.basename(p)); } catch { return p; }
      };
      if ((await canon(reResolved)) !== (await canon(resolved))) {
        throw Object.assign(new Error(`Path target changed between check and write: ${input.path} (POLICY_DENIED)`), { code: 'POLICY_DENIED' });
      }
      const tmp = `${resolved}.klyro-multi-${Date.now()}.tmp`;
      await fs.writeFile(tmp, content, 'utf-8');
      // Symlink-swap guard: refuse if the final dest became a symlink
      // since the up-front resolve (lstat never follows the final link).
      await assertNotSymlink(resolved);
      try { await fs.rename(tmp, resolved); } catch (err) { await fs.unlink(tmp).catch(() => undefined); throw err; }
      const newStat = await fs.stat(resolved);
      recordEditStaleness(resolved, newStat.mtimeMs, crypto.createHash('sha256').update(content, 'utf-8').digest('hex'));
      return { path: input.path, edits: input.edits.length, diff: `multi_edit ${input.edits.length} edits` } as const;
    });
  },
});
