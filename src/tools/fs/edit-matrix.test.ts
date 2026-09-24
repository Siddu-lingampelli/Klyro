/**
 * 4.1/4.2 — table-driven edit matrix.
 *
 * Same engine as the example-style suites, but every row is a table case
 * (`it.each`) so the "60 cases / 100 tests" shape from the plan is
 * literally present: exact preservation, fuzzy tiers, diagnostics,
 * multi-edit atomicity, and patch application.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { editFileTool } from './edit-file.js';
import { multiEditTool } from './multi-edit.js';
import { applyPatchTool } from './apply-patch.js';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-edit-matrix-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function write(file: string, content: string): Promise<void> {
  const p = path.join(tmp, file);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
}

async function read(file: string): Promise<string> {
  return fs.readFile(path.join(tmp, file), 'utf-8');
}

const ctx = () => ({ cwd: tmp, env: {} as Record<string, string> });

describe('edit matrix: exact preservation', () => {
  interface Row { name: string; content: string; find: string; replace: string; expected: string; replaceAll?: boolean }
  const rows: Row[] = [
    { name: 'lf basic', content: 'hello world', find: 'world', replace: 'there', expected: 'hello there' },
    { name: 'lf multiline find', content: 'a\nb\nc', find: 'a\nb', replace: 'A\nB', expected: 'A\nB\nc' },
    { name: 'crlf single line', content: 'a\r\nb\r\nc\r\n', find: 'b', replace: 'B', expected: 'a\r\nB\r\nc\r\n' },
    { name: 'crlf multiline find', content: 'a\r\nb\r\nc\r\n', find: 'a\r\nb', replace: 'A\r\nB', expected: 'A\r\nB\r\nc\r\n' },
    { name: 'crlf no trailing newline kept', content: 'a\r\nb', find: 'b', replace: 'B', expected: 'a\r\nB' },
    { name: 'bom preserved', content: '﻿hello', find: 'hello', replace: 'hi', expected: '﻿hi' },
    { name: 'bom with trailing newline', content: '﻿hi\n', find: 'hi', replace: 'hello', expected: '﻿hello\n' },
    { name: 'trailing newline kept', content: 'hello\n', find: 'hello', replace: 'hi', expected: 'hi\n' },
    { name: 'missing trailing newline kept', content: 'hello', find: 'hello', replace: 'hi', expected: 'hi' },
    { name: 'replacement drops newline, original kept', content: 'hi\n', find: 'hi', replace: 'hello', expected: 'hello\n' },
    { name: 'tabs preserved', content: '\tindented\n\tmore', find: 'more', replace: 'M', expected: '\tindented\n\tM' },
    { name: 'unicode emoji', content: 'hi 🌍 bye', find: '🌍', replace: '🌎', expected: 'hi 🌎 bye' },
    { name: 'unicode cjk', content: '日本語テスト', find: 'テスト', replace: '試験', expected: '日本語試験' },
    { name: 'deletion via empty replace', content: 'abXXcd', find: 'XX', replace: '', expected: 'abcd' },
    { name: 'regex chars literal', content: 'a.*b+c?d', find: '.*b+c?', replace: 'X', expected: 'aXd' },
    { name: 'dollar literal', content: 'cost $5', find: '$5', replace: '$6', expected: 'cost $6' },
    { name: 'case sensitive', content: 'Foo foo', find: 'foo', replace: 'bar', expected: 'Foo bar' },
    { name: 'replaceAll many', content: 'x x x', find: 'x', replace: 'y', expected: 'y y y', replaceAll: true },
  ];
  it.each(rows)('$name', async (row) => {
    await write('a.txt', row.content);
    const r = await editFileTool.execute(
      { path: 'a.txt', find: row.find, replace: row.replace, ...(row.replaceAll ? { replaceAll: true } : {}) },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await read('a.txt')).toBe(row.expected);
  });
});

describe('edit matrix: fuzzy tiers', () => {
  // NOTE: each `find` is crafted to NOT be an exact substring (otherwise the
  // exact path wins and no [fuzzy:tier] label is emitted) while matching
  // after the tier transform. Tab-vs-spaces is the standard trick.
  interface Row { name: string; content: string; find: string; replace: string; tier: string; expected: string; replaceAll?: boolean }
  const rows: Row[] = [
    { name: 'trailing spaces', content: 'hello   \nworld', find: 'hello\t', replace: 'hi', tier: 'trailing-whitespace', expected: 'hi\nworld' },
    { name: 'trailing tab', content: 'hello\t\nworld', find: 'hello  ', replace: 'hi', tier: 'trailing-whitespace', expected: 'hi\nworld' },
    { name: 'trailing spaces multiline', content: 'a  \nb  \n', find: 'a\t\nb\t', replace: 'A\nB', tier: 'trailing-whitespace', expected: 'A\nB\n' },
    { name: 'indent spaces to tab', content: '\tfoo', find: '  foo', replace: 'hi', tier: 'indent-width', expected: 'hi' },
    { name: 'indent tab to spaces', content: '  foo', find: '\tfoo', replace: 'hi', tier: 'indent-width', expected: 'hi' },
    { name: 'indent nested', content: '\t\tdeep', find: '    deep', replace: 'hi', tier: 'indent-width', expected: 'hi' },
    { name: 'curly double quotes', content: '“hello”', find: '"hello"', replace: 'hi', tier: 'unicode-quotes', expected: 'hi' },
    { name: 'curly single quotes', content: '‘hi’', find: "'hi'", replace: 'yo', tier: 'unicode-quotes', expected: 'yo' },
    { name: 'em dash', content: 'a—b', find: 'a-b', replace: 'hi', tier: 'unicode-quotes', expected: 'hi' },
    { name: 'line window one char', content: 'abcdefghijklmnopqrst', find: 'abcdefghijklmnopqrSt', replace: 'hi', tier: 'line-window-0.95', expected: 'hi' },
    { name: 'line window tail char', content: '0123456789abcdefghij', find: '0123456789abcdefghiJ', replace: 'hi', tier: 'line-window-0.95', expected: 'hi' },
    { name: 'fuzzy replaceAll both', content: 'x  \nx\t\n', find: 'x \t', replace: 'y', tier: 'trailing-whitespace', expected: 'y\ny\n', replaceAll: true },
  ];
  it.each(rows)('$name', async (row) => {
    await write('a.txt', row.content);
    const r = await editFileTool.execute(
      { path: 'a.txt', find: row.find, replace: row.replace, ...(row.replaceAll ? { replaceAll: true } : {}) },
      ctx(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.diff).toContain(`[fuzzy:${row.tier}]`);
    expect(await read('a.txt')).toBe(row.expected);
  });
});

describe('edit matrix: diagnostics', () => {
  it.each([
    { name: 'exact ambiguous x2', content: 'foo foo', find: 'foo' },
    { name: 'exact ambiguous x3', content: 'ab ab ab', find: 'ab' },
    { name: 'exact ambiguous lines', content: 'k\nk\n', find: 'k' },
  ])('$name', async (row) => {
    await write('a.txt', row.content);
    const r = await editFileTool.execute({ path: 'a.txt', find: row.find, replace: 'z' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('MATCH_AMBIGUOUS');
      expect(r.error.message).toMatch(/replaceAll=true/);
    }
    expect(await read('a.txt')).toBe(row.content);
  });

  it.each([
    { name: 'fuzzy ambiguous trailing ws', content: 'hello   \nhello  \n', find: 'hello\t' },
    { name: 'fuzzy ambiguous quotes', content: '“a” “a”', find: '"a"' },
  ])('$name', async (row) => {
    await write('a.txt', row.content);
    const r = await editFileTool.execute({ path: 'a.txt', find: row.find, replace: 'z' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('MATCH_AMBIGUOUS');
      expect(r.error.message).toMatch(/fuzzy:/);
    }
  });

  it.each([
    { name: 'not found short', content: 'hello world', find: 'nope' },
    { name: 'not found long', content: 'alpha\nbeta\ngamma', find: 'delta epsilon' },
  ])('$name', async (row) => {
    await write('a.txt', row.content);
    const r = await editFileTool.execute({ path: 'a.txt', find: row.find, replace: 'z' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('MATCH_NOT_FOUND');
      expect(r.error.message).toMatch(/Closest match/);
      expect(r.error.message).toMatch(/similarity/);
      expect(r.error.message).toMatch(/line \d+-\d+/);
    }
  });

  it('stale after external change', async () => {
    await write('a.txt', 'v1');
    const first = await editFileTool.execute({ path: 'a.txt', find: 'v1', replace: 'v2' }, ctx());
    expect(first.ok).toBe(true);
    await write('a.txt', 'v1-external');
    const second = await editFileTool.execute({ path: 'a.txt', find: 'v1-external', replace: 'v3' }, ctx());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('STALE');
  });

  it('not stale without external change', async () => {
    await write('a.txt', 'v1');
    expect((await editFileTool.execute({ path: 'a.txt', find: 'v1', replace: 'v2' }, ctx())).ok).toBe(true);
    const second = await editFileTool.execute({ path: 'a.txt', find: 'v2', replace: 'v3' }, ctx());
    expect(second.ok).toBe(true);
    expect(await read('a.txt')).toBe('v3');
  });

  it.each([
    { name: 'large unread denied', content: 'x'.repeat(500), denied: true },
    { name: 'small unread allowed', content: 'x'.repeat(50), denied: false },
  ])('$name', async (row) => {
    await write('a.txt', row.content);
    const r = await editFileTool.execute({ path: 'a.txt', find: 'x', replace: 'y', replaceAll: true }, ctx());
    expect(r.ok).toBe(!row.denied);
    if (!r.ok && row.denied) expect(r.error.code).toBe('POLICY_DENIED');
  });
});

describe('edit matrix: multi-edit atomicity', () => {
  interface Row {
    name: string; initial: string;
    edits: Array<{ find: string; replace: string; replaceAll?: boolean }>;
    ok: boolean; expected: string;
  }
  const rows: Row[] = [
    { name: 'two sequential', initial: 'a b c', edits: [{ find: 'a', replace: 'A' }, { find: 'b', replace: 'B' }], ok: true, expected: 'A B c' },
    { name: 'three sequential', initial: '1 2 3', edits: [{ find: '1', replace: 'a' }, { find: '2', replace: 'b' }, { find: '3', replace: 'c' }], ok: true, expected: 'a b c' },
    { name: 'second fails rolls back', initial: 'hello', edits: [{ find: 'hello', replace: 'hi' }, { find: 'nope', replace: 'x' }], ok: false, expected: 'hello' },
    { name: 'first fails untouched', initial: 'hello', edits: [{ find: 'nope', replace: 'x' }, { find: 'hello', replace: 'hi' }], ok: false, expected: 'hello' },
    { name: 'ambiguous fails all', initial: 'k k', edits: [{ find: 'k', replace: 'K' }], ok: false, expected: 'k k' },
    { name: 'replaceAll inside multi', initial: 'd d', edits: [{ find: 'd', replace: 'D', replaceAll: true }], ok: true, expected: 'D D' },
    { name: 'dependent chain', initial: 'ab', edits: [{ find: 'ab', replace: 'abc' }, { find: 'abc', replace: 'abcd' }], ok: true, expected: 'abcd' },
  ];
  it.each(rows)('$name', async (row) => {
    await write('a.txt', row.initial);
    const r = await multiEditTool.execute({ path: 'a.txt', edits: row.edits }, ctx());
    expect(r.ok).toBe(row.ok);
    expect(await read('a.txt')).toBe(row.expected);
  });

  it('empty edits rejected at schema (registry path)', async () => {
    await write('a.txt', 'ab');
    // Direct execute() bypasses zod; the schema users hit via the registry
    // requires min(1) edits.
    const parsed = multiEditTool.inputSchema.safeParse({ path: 'a.txt', edits: [] });
    expect(parsed.success).toBe(false);
    expect(await read('a.txt')).toBe('ab');
  });
});

describe('edit matrix: apply_patch', () => {
  interface Row { name: string; initial: string | null; patch: string; ok: boolean; expected?: string }
  const rows: Row[] = [
    {
      name: 'codex add lines', initial: null,
      patch: '*** Begin Patch\n*** Update File: a.txt\n+hello world\n*** End Patch',
      ok: true, expected: 'hello world',
    },
    {
      name: 'codex hunk replace', initial: 'line1\nline2\nline3\n',
      patch: ['*** Begin Patch', '*** Update File: a.txt', '@@ -1,3 +1,3 @@', ' line1', '-line2', '+LINE2', ' line3', '*** End Patch'].join('\n'),
      ok: true, expected: 'line1\nLINE2\nline3\n',
    },
    {
      name: 'codex add file', initial: null,
      patch: '*** Begin Patch\n*** Add File: b.txt\n+new content\n*** End Patch',
      ok: true, expected: 'new content',
    },
    {
      name: 'delete section rejected loudly', initial: 'gone',
      patch: '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch',
      ok: false, expected: 'gone',
    },
    {
      name: 'context mismatch fails', initial: 'line1\nline2\n',
      patch: ['*** Begin Patch', '*** Update File: a.txt', '@@ -1,2 +1,2 @@', ' WRONG', '-line2', '+L2', '*** End Patch'].join('\n'),
      ok: false, expected: 'line1\nline2\n',
    },
    {
      name: 'garbage rejected', initial: 'x',
      patch: 'not a patch', ok: false, expected: 'x',
    },
    {
      name: 'update missing file fails', initial: null,
      patch: ['*** Begin Patch', '*** Update File: missing.txt', '@@ -1,1 +1,1 @@', '-a', '+b', '*** End Patch'].join('\n'),
      ok: false,
    },
    {
      name: 'multi hunk drift', initial: 'a\nb\nc\nd\ne\nf\n',
      patch: ['*** Begin Patch', '*** Update File: a.txt', '@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -5,2 +5,2 @@', ' e', '-f', '+F', '*** End Patch'].join('\n'),
      ok: true, expected: 'a\nB\nc\nd\ne\nF\n',
    },
  ];
  it.each(rows)('$name', async (row) => {
    if (row.initial !== null) await write('a.txt', row.initial);
    const r = await applyPatchTool.execute({ patch: row.patch }, ctx());
    expect(r.ok).toBe(row.ok);
    if (!r.ok && row.name === 'delete section rejected loudly') {
      expect(r.error.code).toBe('INVALID_PATCH');
    }
    if (row.expected !== undefined) {
      const file = row.patch.includes('*** Add File: b.txt') ? 'b.txt' : 'a.txt';
      expect(await read(file)).toContain(row.expected);
    }
  });
});
