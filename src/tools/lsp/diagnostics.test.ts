import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '../types.js';
import { lspDiagnosticsTool, lspGotoDefinitionTool, lspOutlineTool, lspReferencesTool } from './diagnostics.js';

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

describe('lsp_outline', () => {
  it('outlines a nested file that is NOT the first file in the walk', async () => {
    // Regression: the tool used to go through buildRepoMap({maxFiles:1}), which
    // caps the whole-tree walk at one file — the requested file was then absent
    // from the index and the tool always returned "file not in repo-map".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-outline-'));
    // a.ts sorts first and would win any single-file repo-map slot.
    fs.mkdirSync(path.join(dir, 'aaa'));
    fs.writeFileSync(path.join(dir, 'aaa', 'first.ts'), 'export const decoy = 1;\n');
    fs.mkdirSync(path.join(dir, 'zzz'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'zzz', 'target.ts'),
      'export class Widget {\n  render(): string {\n    return "x";\n  }\n}\nexport function helper(): void {}\n',
    );
    const r = await lspOutlineTool.execute({ path: 'zzz/target.ts' }, makeCtx(dir));
    expect(r.ok).toBe(true);
    const v = (r as { ok: true; value: { outline: Array<{ name: string; kind: string; children: Array<{ name: string }> }> } }).value;
    const widget = v.outline.find((o) => o.name === 'Widget');
    expect(widget).toBeDefined();
    expect(widget?.kind).toBe('class');
    expect(widget?.children.map((c) => c.name)).toContain('helper');
  });

  it('reports unreadable files instead of throwing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-outline-'));
    const r = await lspOutlineTool.execute({ path: 'missing.ts' }, makeCtx(dir));
    expect(r.ok).toBe(true);
    const v = (r as { ok: true; value: { outline: unknown[]; note?: string } }).value;
    expect(v.outline).toEqual([]);
    expect(v.note).toContain('unreadable');
  });

  it('stays off when KLYRO_LSP=0', async () => {
    process.env.KLYRO_LSP = '0';
    try {
      const r = await lspOutlineTool.execute({ path: 'a.ts' }, makeCtx(process.cwd()));
      expect((r as { ok: true; value: { enabled: boolean } }).value.enabled).toBe(false);
    } finally {
      delete process.env.KLYRO_LSP;
    }
  });
});

describe('lsp_references', () => {
  it('finds references to an identifier across files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-refs-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function sharedThing() {\n  return 1;\n}\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'import { sharedThing } from "./a";\nsharedThing();\n');
    const r = await lspReferencesTool.execute({ path: 'a.ts', line: 1, character: 18 }, makeCtx(dir));
    expect(r.ok).toBe(true);
    const v = (r as { ok: true; value: { references: Array<{ name: string }> } }).value;
    expect(v.references.length).toBeGreaterThan(0);
    expect(v.references.every((ref) => ref.name === 'sharedThing')).toBe(true);
  });
});
