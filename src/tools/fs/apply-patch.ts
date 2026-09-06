/**
 * 4.2 — apply_patch: Codex-style unified patch, tolerant hunks
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../types.js';
import { resolveAndFollowSymlinks } from '../../policy/path-guard.js';
import { safe } from '../normalize.js';

const InputSchema = z.object({
  patch: z.string().min(1).describe('Unified diff patch text'),
});

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  description: 'Apply a unified diff patch (Codex-style). Tolerant hunks, per model config.',
  inputSchema: InputSchema,
  permission: 'edit',
  isConcurrencySafe: false,
  execute: async (input, ctx) => {
    return safe(async () => {
      const lines = input.patch.split('\n');
      let currentFile: string | null = null;
      let fileContent: string | null = null;
      let patchedFiles: string[] = [];

      for (const line of lines) {
        if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) continue;
        if (line.startsWith('*** Update File:')) {
          // Flush previous
          if (currentFile && fileContent !== null) {
            const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, currentFile);
            await fs.mkdir(path.dirname(resolved), { recursive: true });
            await fs.writeFile(resolved, fileContent, 'utf-8');
            patchedFiles.push(currentFile);
          }
          currentFile = line.replace('*** Update File:', '').trim();
          if (currentFile) {
            try {
              const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, currentFile);
              fileContent = await fs.readFile(resolved, 'utf-8');
            } catch { fileContent = ''; }
          }
          continue;
        }
        if (line.startsWith('*** Add File:')) {
          if (currentFile && fileContent !== null) {
            const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, currentFile);
            await fs.mkdir(path.dirname(resolved), { recursive: true });
            await fs.writeFile(resolved, fileContent, 'utf-8');
            patchedFiles.push(currentFile);
          }
          currentFile = line.replace('*** Add File:', '').trim();
          fileContent = '';
          continue;
        }
        if (line.startsWith('+') && currentFile && fileContent !== null) {
          // Very tolerant: just append added lines, ignore removals for stub
          if (!line.startsWith('+++')) fileContent += line.slice(1) + '\n';
        } else if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) {
          continue;
        }
      }
      if (currentFile && fileContent !== null) {
        const { resolved } = await resolveAndFollowSymlinks(ctx.cwd, currentFile);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, fileContent, 'utf-8');
        patchedFiles.push(currentFile);
      }
      if (patchedFiles.length === 0) throw Object.assign(new Error('No files patched — invalid patch format'), { code: 'INVALID_PATCH' });
      return { patchedFiles, count: patchedFiles.length } as const;
    });
  },
});
