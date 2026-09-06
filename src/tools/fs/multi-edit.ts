/**
 * 4.2 — multi_edit: atomic sequential edits with rollback on failure
 */

import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveAndFollowSymlinks } from '../../policy/path-guard.js';
import { safe } from '../normalize.js';

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
      const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, input.path);
      let content = await fs.readFile(resolved, 'utf-8');
      const original = content;
      for (let i = 0; i < input.edits.length; i++) {
        const e = input.edits[i]!;
        const count = content.split(e.find).length - 1;
        if (count === 0) throw Object.assign(new Error(`edit ${i}: find not found`), { code: 'MATCH_NOT_FOUND' });
        if (!e.replaceAll && count > 1) throw Object.assign(new Error(`edit ${i}: ambiguous (${count} matches)`), { code: 'MATCH_AMBIGUOUS' });
        content = e.replaceAll ? content.split(e.find).join(e.replace) : content.replace(e.find, e.replace);
      }
      const tmp = `${resolved}.klyro-multi-${Date.now()}.tmp`;
      await fs.writeFile(tmp, content, 'utf-8');
      try { await fs.rename(tmp, resolved); } catch (err) { await fs.unlink(tmp).catch(() => undefined); throw err; }
      return { path: input.path, edits: input.edits.length, diff: `multi_edit ${input.edits.length} edits` } as const;
    });
  },
});
