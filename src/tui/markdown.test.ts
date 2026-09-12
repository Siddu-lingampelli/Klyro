/**
 * design.md §23/§24 — markdown unit tests (pure, no terminal).
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdownLines, highlightCodeLine, annotateFileLinks } from './markdown.js';

describe('renderMarkdownLines', () => {
  it('parses **bold** segments', () => {
    const lines = renderMarkdownLines('hello **world** end');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.parts).toEqual([
      { text: 'hello ' },
      { text: 'world', bold: true },
      { text: ' end' },
    ]);
  });
  it('strips headings to bold text', () => {
    const lines = renderMarkdownLines('## Changes');
    expect(lines[0]!.parts).toEqual([{ text: 'Changes', bold: true }]);
  });
  it('dims *italic*', () => {
    const lines = renderMarkdownLines('a *b* c');
    expect(lines[0]!.parts).toContainEqual({ text: 'b', dim: true });
  });
  it('marks `code`', () => {
    const lines = renderMarkdownLines('run `npm test` now');
    expect(lines[0]!.parts).toContainEqual({ text: 'npm test', code: true });
  });
  it('renders [links](url) as text + dim url', () => {
    const lines = renderMarkdownLines('see [docs](https://x.example)');
    expect(lines[0]!.parts).toContainEqual({ text: 'docs' });
    expect(lines[0]!.parts).toContainEqual({ text: ' (https://x.example)', dim: true });
  });
  it('syntax-highlights fenced code blocks (R4)', () => {
    const lines = renderMarkdownLines('before\n```ts\nconst a = 1;\n```\nafter');
    expect(lines).toHaveLength(5);
    expect(lines[2]!.fence).toBe(true);
    // Code line is highlighted: the keyword const gets a cyan color, a number.
    const kw = lines[2]!.parts.find((p) => p.text === 'const');
    expect(kw?.color).toBe('cyan');
    expect(lines[2]!.parts.some((p) => p.color === 'yellow')).toBe(true);
    expect(lines[4]!.parts).toEqual([{ text: 'after' }]);
  });
  it('passes lists and tables through', () => {
    const lines = renderMarkdownLines('- item one\n| a | b |');
    expect(lines[0]!.parts[0]!.text).toContain('item one');
    expect(lines[1]!.parts[0]!.text).toContain('| a | b |');
  });
});

describe('highlightCodeLine (R4)', () => {
  it('flushes a whole-line comment as dim', () => {
    const parts = highlightCodeLine('// note', 'ts');
    expect(parts[0]!.text).toBe('// note');
    expect(parts[0]!.dim).toBe(true);
  });
  it('colors known keywords cyan and keeps the rest code', () => {
    const parts = highlightCodeLine('const x = 1;', 'ts');
    const kw = parts.find((p) => p.text === 'const');
    expect(kw?.color).toBe('cyan');
    expect(parts.every((p) => p.code)).toBe(true);
  });
  it('colors numbers yellow', () => {
    const parts = highlightCodeLine('let n = 42', 'ts');
    const num = parts.find((p) => p.text === '42');
    expect(num?.color).toBe('yellow');
  });
  it('dims a trailing inline comment', () => {
    const parts = highlightCodeLine('const a = 1; // init', 'ts');
    expect(parts.some((p) => p.dim && p.text.includes('// init'))).toBe(true);
  });
  it('falls back to code for unknown languages', () => {
    const parts = highlightCodeLine('gibberish ???', 'zzz');
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((p) => p.code)).toBe(true);
  });
});

describe('annotateFileLinks (R4)', () => {
  it('turns file:line into an href-bearing part', () => {
    const links = annotateFileLinks([{ text: 'see src/agent/runtime.ts:210' }]);
    const hit = links.find((p) => p.href);
    expect(hit?.href).toBe('file://src/agent/runtime.ts#L210');
    expect(hit?.text).toBe('src/agent/runtime.ts:210');
  });
  it('leaves code parts (and plain text) untouched', () => {
    const links = annotateFileLinks([{ text: 'const m = runtime:1;', code: true }]);
    expect(links).toHaveLength(1);
    expect(links[0]!.href).toBeUndefined();
  });
});
