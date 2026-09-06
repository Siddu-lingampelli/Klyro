/**
 * scroll.md §5 — Anchor-based scroll model (pure, no React).
 *
 * Position is an Anchor ({itemId, lineInItem}), never a raw row index (I4),
 * so resizes, group expand/collapse, and compaction never make the view jump.
 * While anchored to 'bottom', new output follows; the instant the user scrolls
 * up the anchor pins to an item and freezes, accumulating newSinceUnstick
 * display lines for the `↓ N new` badge (§7).
 */

export type Anchor =
  | { mode: 'bottom' }
  | { mode: 'pinned'; itemId: string; lineInItem: number };

export interface ScrollState {
  anchor: Anchor;
  userScrolled: boolean;
  /** display lines appended since the user unstuck (badge count, §7) */
  newSinceUnstick: number;
}

export const FOLLOW_EPSILON = 1; // within 1 line of bottom counts as "at bottom" (§13)

export const initialScroll: ScrollState = {
  anchor: { mode: 'bottom' },
  userScrolled: false,
  newSinceUnstick: 0,
};

export type ScrollAction =
  | { type: 'BY_LINES'; delta: number }
  | { type: 'BY_PAGE'; dir: -1 | 1 }
  | { type: 'BY_HALF_PAGE'; dir: -1 | 1 }
  | { type: 'TO_TOP' }
  | { type: 'TO_BOTTOM' }
  | { type: 'CONTENT_GREW'; lines: number }
  | { type: 'REFLOW' };

/** Index abstraction over measured display lines (§4.3). */
export interface ScrollCtx {
  /** number of blocks */
  count: number;
  /** display-line offset of block i */
  offsetOf: (i: number) => number;
  /** key of block i (stable across regroups) */
  keyOf: (i: number) => string;
  /** block index containing display row */
  indexAt: (row: number) => number;
  /** total measured display lines */
  total: number;
  viewportH: number;
}

function clampN(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function maxTopFor(ctx: ScrollCtx): number {
  return Math.max(0, ctx.total - ctx.viewportH);
}

function stickBottom(): ScrollState {
  return { anchor: { mode: 'bottom' }, userScrolled: false, newSinceUnstick: 0 };
}

// FOLLOW_EPSILON is directional: scrolling DOWN into the last line re-sticks
// to bottom, but scrolling UP must always escape — otherwise single-line /
// wheel scrolling from the bottom could never leave it (dead scroll trap).
function pinAt(s: ScrollState, ctx: ScrollCtx, row: number, from: number): ScrollState {
  const maxTop = maxTopFor(ctx);
  const top = clampN(row, 0, maxTop);
  if (top >= maxTop - FOLLOW_EPSILON && top >= from) return stickBottom();
  if (ctx.count === 0) return stickBottom();
  const i = clampN(ctx.indexAt(top), 0, ctx.count - 1);
  return {
    anchor: { mode: 'pinned', itemId: ctx.keyOf(i), lineInItem: top - ctx.offsetOf(i) },
    userScrolled: true,
    newSinceUnstick: s.newSinceUnstick,
  };
}

export function scrollReducer(s: ScrollState, a: ScrollAction, ctx: ScrollCtx): ScrollState {
  const maxTop = maxTopFor(ctx);
  // current resolved top (anchor may predate this frame's measurements)
  const cur = resolveTopRow(s, ctx).topRow;

  switch (a.type) {
    case 'BY_LINES':
      return pinAt(s, ctx, cur + a.delta, cur);
    case 'BY_PAGE':
      return pinAt(s, ctx, cur + a.dir * (ctx.viewportH - 1), cur); // 1-line overlap
    case 'BY_HALF_PAGE':
      return pinAt(s, ctx, cur + a.dir * Math.floor(ctx.viewportH / 2), cur);
    case 'TO_TOP':
      return pinAt(s, ctx, 0, cur);
    case 'TO_BOTTOM':
      return stickBottom();
    case 'CONTENT_GREW':
      if (a.lines <= 0) {
        // tail shrank/rewrote (§12): keep anchor, recompute, don't count
        return { ...s };
      }
      if (s.anchor.mode === 'bottom') {
        // follow — keep the counter clean; topRow derives from maxTop
        return { ...s, newSinceUnstick: 0 };
      }
      void maxTop;
      return { ...s, newSinceUnstick: s.newSinceUnstick + a.lines };
    case 'REFLOW':
      return { ...s };
  }
}

export interface Resolved {
  topRow: number;
  atBottom: boolean;
}

/** Anchor → topRow, run once per frame after the line index rebuild (§5.3). */
export function resolveTopRow(s: ScrollState, ctx: ScrollCtx): Resolved {
  const maxTop = maxTopFor(ctx);
  if (s.anchor.mode === 'bottom') return { topRow: maxTop, atBottom: true };
  let i = -1;
  for (let k = 0; k < ctx.count; k++) {
    if (ctx.keyOf(k) === s.anchor.itemId) {
      i = k;
      break;
    }
  }
  if (i === -1) return { topRow: maxTop, atBottom: true }; // pruned → re-stick (§12)
  const raw = ctx.offsetOf(i) + Math.max(0, s.anchor.lineInItem);
  const topRow = clampN(raw, 0, maxTop);
  return { topRow, atBottom: topRow >= maxTop - FOLLOW_EPSILON };
}

/** Badge label per §7.2. Empty string = hidden. */
export function badgeLabel(atBottom: boolean, newSinceUnstick: number, idle: boolean): string {
  if (atBottom || newSinceUnstick <= 0) return '';
  if (idle) return '↓ jump to end';
  if (newSinceUnstick >= 1000) return '↓ 999+ new';
  return `↓ ${newSinceUnstick} new`;
}
