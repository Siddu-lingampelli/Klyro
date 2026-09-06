/**
 * scroll.md §15.1 — scroll/reducer + resolve unit tests (no terminal).
 */
import { describe, it, expect } from 'vitest';
import {
  initialScroll,
  scrollReducer,
  resolveTopRow,
  badgeLabel,
  type ScrollCtx,
} from './scroll-model.js';

/** 5 blocks of heights [2,2,2,2,2] → total 10, viewport 6 → maxTop 4. */
function ctx5(viewportH = 6): ScrollCtx {
  const heights = [2, 2, 2, 2, 2];
  const offsets = [0, 2, 4, 6, 8];
  return {
    count: 5,
    offsetOf: (i) => offsets[i] ?? 0,
    keyOf: (i) => `k${i}`,
    indexAt: (row) => {
      let ans = 0;
      for (let i = 0; i < offsets.length; i++) if (offsets[i]! <= row) ans = i;
      return ans;
    },
    total: 10,
    viewportH,
  };
}

describe('follow at bottom (§5.6)', () => {
  it('CONTENT_GREW at bottom keeps topRow at maxTop', () => {
    const c = ctx5();
    const s = scrollReducer(initialScroll, { type: 'CONTENT_GREW', lines: 4 }, c);
    expect(s.anchor.mode).toBe('bottom');
    expect(resolveTopRow(s, c).topRow).toBe(4);
    expect(resolveTopRow(s, c).atBottom).toBe(true);
  });
});

describe('freeze when pinned (§5.6)', () => {
  it('scrolling up pins; growth freezes topRow and counts lines', () => {
    const c = ctx5();
    const pinned = scrollReducer(initialScroll, { type: 'TO_TOP' }, c);
    expect(pinned.anchor.mode).toBe('pinned');
    const before = resolveTopRow(pinned, c).topRow;
    const grown: ScrollCtx = { ...c, total: c.total + 6 };
    const after = scrollReducer(pinned, { type: 'CONTENT_GREW', lines: 6 }, grown);
    expect(resolveTopRow(after, grown).topRow).toBe(before);
    expect(after.newSinceUnstick).toBe(6);
    expect(badgeLabel(false, after.newSinceUnstick, false)).toBe('↓ 6 new');
  });
  it('badge counts display lines, caps at 999+', () => {
    expect(badgeLabel(false, 1200, false)).toBe('↓ 999+ new');
    expect(badgeLabel(true, 5, false)).toBe('');
    expect(badgeLabel(false, 0, false)).toBe('');
    expect(badgeLabel(false, 5, true)).toBe('↓ jump to end');
  });
});

describe('pages, clamps, epsilon', () => {
  it('BY_PAGE has 1-line overlap', () => {
    const c = ctx5(6);
    const s = scrollReducer(initialScroll, { type: 'TO_TOP' }, c);
    const paged = scrollReducer(s, { type: 'BY_PAGE', dir: 1 }, c);
    // viewportH-1 = 5 → row 5 → clamped to maxTop 4 → re-sticks (within ε)
    expect(paged.anchor.mode).toBe('bottom');
  });
  it('BY_LINES clamps at top and bottom', () => {
    const c = ctx5();
    const top = scrollReducer(initialScroll, { type: 'TO_TOP' }, c);
    expect(resolveTopRow(top, c).topRow).toBe(0);
    const over = scrollReducer(top, { type: 'BY_LINES', delta: 999 }, c);
    expect(over.anchor.mode).toBe('bottom');
    const under = scrollReducer(top, { type: 'BY_LINES', delta: -999 }, c);
    expect(resolveTopRow(under, c).topRow).toBe(0);
  });
  it('scrolling back within ε re-sticks', () => {
    const c = ctx5();
    const pinned = scrollReducer(initialScroll, { type: 'BY_LINES', delta: -2 }, c);
    expect(pinned.anchor.mode).toBe('pinned');
    const back = scrollReducer(pinned, { type: 'BY_LINES', delta: 2 }, c);
    expect(back.anchor.mode).toBe('bottom');
  });
  it('TO_TOP from bottom pins to first item', () => {
    const c = ctx5();
    const s = scrollReducer(initialScroll, { type: 'TO_TOP' }, c);
    expect(s.anchor).toEqual({ mode: 'pinned', itemId: 'k0', lineInItem: 0 });
  });
});

describe('anchor survives collapse above it (I4)', () => {
  it('same itemId at a new offset → same item stays on top', () => {
    const c = ctx5();
    // pin to item k2 line 0 (offset 4)
    const pinned = scrollReducer(initialScroll, { type: 'BY_LINES', delta: -0 }, c);
    void pinned;
    const manual = { anchor: { mode: 'pinned' as const, itemId: 'k2', lineInItem: 0 }, userScrolled: true, newSinceUnstick: 0 };
    expect(resolveTopRow(manual, c).topRow).toBe(4);
    // collapse: k0 shrinks 2→1, so k2 moves 4→3 — anchor follows the ITEM
    const collapsed: ScrollCtx = {
      count: 5,
      offsetOf: (i) => [0, 1, 3, 5, 7][i] ?? 0,
      keyOf: (i) => `k${i}`,
      indexAt: (row) => row < 1 ? 0 : row < 3 ? 1 : row < 5 ? 2 : row < 7 ? 3 : 4,
      total: 9,
      viewportH: 6,
    };
    expect(resolveTopRow(manual, collapsed).topRow).toBe(3);
  });
  it('pruned anchor → re-stick to bottom (§12)', () => {
    const c = ctx5();
    const gone = { anchor: { mode: 'pinned' as const, itemId: 'missing', lineInItem: 0 }, userScrolled: true, newSinceUnstick: 3 };
    const r = resolveTopRow(gone, c);
    expect(r.topRow).toBe(4);
    expect(r.atBottom).toBe(true);
  });
});

describe('REFLOW keeps anchor on resize', () => {
  it('width change re-resolves same item', () => {
    const c = ctx5();
    const manual = { anchor: { mode: 'pinned' as const, itemId: 'k1', lineInItem: 1 }, userScrolled: true, newSinceUnstick: 0 };
    const s = scrollReducer(manual, { type: 'REFLOW' }, c);
    expect(s.anchor).toEqual(manual.anchor);
    expect(resolveTopRow(s, c).topRow).toBe(3);
  });
});
