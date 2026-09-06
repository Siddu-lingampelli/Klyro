/**
 * design.md §23/§24 — markdown unit tests (pure, no terminal).
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdownLines } from './markdown.js';

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
  it('dims fenced code blocks', () => {
    const lines = renderMarkdownLines('before\n```ts\nconst a = 1;\n```\nafter');
    expect(lines).toHaveLength(5);
    expect(lines[2]!.fence).toBe(true);
    expect(lines[2]!.parts[0]).toMatchObject({ dim: true });
    expect(lines[4]!.parts).toEqual([{ text: 'after' }]);
  });
  it('passes lists and tables through', () => {
    const lines = renderMarkdownLines('- item one\n| a | b |');
    expect(lines[0]!.parts[0]!.text).toContain('item one');
    expect(lines[1]!.parts[0]!.text).toContain('| a | b |');
  });
});
