/**
 * scroll.md §15.1 — pure unit tests: wrap + line-index (no terminal).
 */
import { describe, it, expect } from 'vitest';
import {
  displayWidth,
  wrapCount,
  blockHeight,
  blockSig,
  MeasureCache,
  buildIndex,
  itemAtRow,
} from './measure.js';

describe('displayWidth (§12: never .length)', () => {
  it('counts ASCII as 1', () => {
    expect(displayWidth('hello')).toBe(5);
  });
  it('counts CJK as 2', () => {
    expect(displayWidth('日本語')).toBe(6);
  });
  it('counts emoji as 2 and combining marks as 0', () => {
    expect(displayWidth('👍')).toBe(2);
    expect(displayWidth('é')).toBe(1); // e + combining acute
  });
  it('ignores ANSI escapes', () => {
    expect(displayWidth('\x1b[31mhi\x1b[0m')).toBe(2);
  });
});

describe('wrapCount', () => {
  it('wraps long lines at width', () => {
    expect(wrapCount('abcdefghij', 5)).toBe(2);
    expect(wrapCount('abc', 5)).toBe(1);
  });
  it('counts each newline segment', () => {
    expect(wrapCount('ab\ncdefgh', 5)).toBe(1 + 2);
  });
  it('empty text is one line', () => {
    expect(wrapCount('', 80)).toBe(1);
  });
});

describe('blockHeight mirrors app.tsx render', () => {
  it('user text = wrapped + margin', () => {
    expect(blockHeight({ kind: 'user', text: 'hi' }, 100)).toBe(2);
  });
  it('assistant text = header + wrapped + margin', () => {
    expect(blockHeight({ kind: 'assistant', text: 'hi' }, 100)).toBe(3);
  });
  it('collapsed group = 2, expanded caps at 12 + overflow (§9.3)', () => {
    expect(blockHeight({ kind: 'group', count: 14, expanded: false, status: 'done', resultLen: 0 }, 100)).toBe(2);
    expect(blockHeight({ kind: 'group', count: 4, expanded: true, status: 'done', resultLen: 0 }, 100)).toBe(1 + 4 + 1);
    expect(blockHeight({ kind: 'group', count: 20, expanded: true, status: 'done', resultLen: 0 }, 100)).toBe(1 + 12 + 1 + 1);
  });
  it('policy renders null → 0', () => {
    expect(blockHeight({ kind: 'policy' }, 100)).toBe(0);
  });
});

describe('blockSig changes when content changes (I6)', () => {
  it('streaming tail text changes sig', () => {
    const a = blockSig({ kind: 'assistant', text: 'hello' });
    const b = blockSig({ kind: 'assistant', text: 'hello world, much longer text here!!' });
    expect(a).not.toBe(b);
  });
  it('same content → same sig (cache hit)', () => {
    expect(blockSig({ kind: 'user', text: 'x' })).toBe(blockSig({ kind: 'user', text: 'x' }));
  });
});

describe('MeasureCache', () => {
  it('hits on same key/width/sig, misses on change', () => {
    const c = new MeasureCache();
    const b1 = { kind: 'assistant', text: 'aaa' } as const;
    const h1 = c.heightFor('k1', b1, 100);
    expect(c.heightFor('k1', b1, 100)).toBe(h1);
    expect(c.size).toBe(1);
    const h2 = c.heightFor('k1', { kind: 'assistant', text: 'aaa bbb ccc ddd eee fff ggg' }, 100);
    expect(h2).toBeGreaterThanOrEqual(h1);
    c.invalidateWidth();
    expect(c.size).toBe(0);
  });
});

describe('buildIndex + itemAtRow (§4.3)', () => {
  it('offsets accumulate heights', () => {
    const idx = buildIndex([2, 3, 1]);
    expect(idx.offsets).toEqual([0, 2, 5]);
    expect(idx.total).toBe(6);
  });
  it('empty → total 0', () => {
    expect(buildIndex([]).total).toBe(0);
  });
  it('itemAtRow boundaries (0, total-1, total)', () => {
    const idx = buildIndex([2, 3, 1]);
    expect(itemAtRow(idx.offsets, 0)).toBe(0);
    expect(itemAtRow(idx.offsets, 1)).toBe(0);
    expect(itemAtRow(idx.offsets, 2)).toBe(1);
    expect(itemAtRow(idx.offsets, 5)).toBe(2);
    expect(itemAtRow(idx.offsets, 5)).toBe(2);
    expect(itemAtRow(idx.offsets, 99)).toBe(2);
  });
  it('incremental rebuild from dirtyFrom', () => {
    const first = buildIndex([2, 3, 1]);
    const second = buildIndex([2, 3, 5], { offsets: first.offsets, dirtyFrom: 2 });
    expect(second.offsets).toEqual([0, 2, 5]);
    expect(second.total).toBe(10);
  });
});
