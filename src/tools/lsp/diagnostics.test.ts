import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '../types.js';
import { lspDiagnosticsTool, lspGotoDefinitionTool } from './diagnostics.js';

function makeCtx(cwd: string): ToolContext {
  return { cwd, env: {} };
}

describe('lsp_goto_definition (repo-map backed)', () => {
  it('resolves an identifier to its definition in another file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-goto-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function functionWidget() {\n  return 1;\n}\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'import { functionWidget } from "./a";\nconsole.log(functionWidget());\n');
    const ctx = makeCtx(dir);
    const r = await lspGotoDefinitionTool.execute({ path: 'b.ts', line: 2, character: 20 }, ctx);
    expect(r.ok).toBe(true);
    const v = (r as { ok: true; value: { location: { file: string; name: string } | null } }).value;
    expect(v.location?.file).toBe('a.ts');
    expect(v.location?.name).toBe('functionWidget');
  });

  it('returns null with a note when no identifier is under the cursor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-goto-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), '   \n');
    const r = await lspGotoDefinitionTool.execute({ path: 'a.ts', line: 1, character: 1 }, makeCtx(dir));
    expect(r.ok).toBe(true);
    const v = (r as { ok: true; value: { location: null } }).value;
    expect(v.location).toBeNull();
  });

  it('stays off when KLYRO_LSP=0', async () => {
    process.env.KLYRO_LSP = '0';
    try {
      const r = await lspDiagnosticsTool.execute({}, makeCtx(process.cwd()));
      expect(r.ok).toBe(true);
      expect((r as { ok: true; value: { enabled: boolean } }).value.enabled).toBe(false);
    } finally {
      delete process.env.KLYRO_LSP;
    }
  });
});
