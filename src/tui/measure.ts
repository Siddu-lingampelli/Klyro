/**
 * scroll.md §4 — Measurement layer (item → display lines).
 *
 * Pure functions only: no hooks, no side effects. The App measures each
 * transcript block into wrapped display-line heights, caches by
 * (key, width, content-signature), and builds a cumulative line index so
 * scrolling is O(1) per frame and only the streaming tail is re-measured.
 *
 * Heights mirror the render structure in app.tsx:
 *   user text      = wrapped lines + 1 (marginBottom)
 *   assistant text = 1 (guide+Klyro header) + wrapped + 1
 *   group collapsed= 1 + 1 margin; expanded = 1 + min(n,12) + overflow?1 + 1
 *   error          = wrapped + 1 margin
 *   policy         = 0 (renders null)
 *   file_changed   = 1 + 1 margin
 *   diff           = 1 summary + Σ(1 path + wrapped hunk lines) + 1 margin
 *   plan block     = 1 + min(8, steps) + 1 margin
 *   thinking/queue = content lines + 1 margin
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff)
  );
}

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x00ad
  );
}

/** Display width per scroll.md §12: never `.length` (CJK=2, emoji=2, combining=0). */
export function displayWidth(s: string): number {
  const clean = s.replace(ANSI_RE, '').replace(/\t/g, '        ');
  let w = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isZeroWidth(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/** Wrapped display-line count for already-newline-split text at `width`. */
export function wrapCount(text: string, width: number): number {
  const w = Math.max(1, width);
  let n = 0;
  for (const line of text.split('\n')) {
    const dw = displayWidth(line);
    n += dw === 0 ? 1 : Math.max(1, Math.ceil(dw / w));
  }
  return Math.max(1, n);
}

/** Content width inside the transcript column (guide prefix + padding). */
export function contentWidth(termWidth: number): number {
  return Math.max(20, termWidth - 10);
}

export type BlockDesc =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'group'; count: number; expanded: boolean; status: string; resultLen: number }
  | { kind: 'error'; message: string }
  | { kind: 'policy' }
  | { kind: 'file'; path: string }
  | { kind: 'diff'; hunks: Array<{ path: string; lines: string[] }> }
  | { kind: 'plan'; done: number; total: number }
  | { kind: 'thinking' }
  | { kind: 'queued'; count: number };

export const EXPANDED_DETAIL_CAP = 12; // scroll.md §9.3

export function blockHeight(b: BlockDesc, termWidth: number): number {
  const cw = contentWidth(termWidth);
  switch (b.kind) {
    case 'user':
      return wrapCount(b.text, termWidth) + 1;
    case 'assistant':
      return 1 + wrapCount(b.text, cw) + 1;
    case 'group':
      if (!b.expanded) return 1 + 1;
      return 1 + Math.min(b.count, EXPANDED_DETAIL_CAP) + (b.count > EXPANDED_DETAIL_CAP ? 1 : 0) + 1;
    case 'error':
      return wrapCount(b.message, termWidth) + 1;
    case 'policy':
      return 0;
    case 'file':
      return 1 + 1;
    case 'diff': {
      let n = 1; // summary
      for (const h of b.hunks) n += 1 + h.lines.reduce((s, l) => s + wrapCount(l, cw), 0);
      return n + 1;
    }
    case 'plan':
      return 1 + Math.min(8, b.total) + 1;
    case 'thinking':
      return 1 + 1;
    case 'queued':
      return b.count + 1;
  }
}

/** Content fingerprint: changes whenever the block's rendered lines could change. */
export function blockSig(b: BlockDesc): string {
  switch (b.kind) {
    case 'user':
      return `u:${b.text.length}:${b.text.slice(0, 16)}:${b.text.slice(-16)}`;
    case 'assistant':
      return `a:${b.text.length}:${b.text.slice(0, 16)}:${b.text.slice(-16)}`;
    case 'group':
      return `g:${b.count}:${b.expanded ? 1 : 0}:${b.status}:${b.resultLen}`;
    case 'error':
      return `e:${b.message.length}:${b.message.slice(-32)}`;
    case 'policy':
      return 'p';
    case 'file':
      return `f:${b.path}`;
    case 'diff':
      return `d:${b.hunks.length}:${b.hunks.reduce((s, h) => s + h.lines.length, 0)}`;
    case 'plan':
      return `pl:${b.done}/${b.total}`;
    case 'thinking':
      return 't';
    case 'queued':
      return `q:${b.count}`;
  }
}

/** Cache: key → height. Only the streaming tail changes sig per tick (I6 → O(1)). */
export class MeasureCache {
  private map = new Map<string, { width: number; sig: string; height: number }>();
  private maxEntries: number;
  constructor(maxEntries = 2000) {
    this.maxEntries = maxEntries;
  }
  heightFor(key: string, block: BlockDesc, termWidth: number): number {
    const sig = blockSig(block);
    const hit = this.map.get(key);
    if (hit && hit.width === termWidth && hit.sig === sig) return hit.height;
    const height = blockHeight(block, termWidth);
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { width: termWidth, sig, height });
    return height;
  }
  /** Resize (width change) invalidates everything — scroll.md §12. */
  invalidateWidth(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}

export interface LineIndex {
  offsets: number[];
  total: number;
}

/** Cumulative first-row offsets; dirtyFrom allows incremental rebuild (only tail dirtied). */
export function buildIndex(
  heights: number[],
  prev?: { offsets: number[]; dirtyFrom: number },
): LineIndex {
  const offsets: number[] = prev ? [...prev.offsets] : [];
  const from = prev ? Math.min(prev.dirtyFrom, heights.length) : 0;
  for (let i = Math.max(0, from); i < heights.length; i++) {
    offsets[i] = i === 0 ? 0 : offsets[i - 1]! + heights[i - 1]!;
  }
  offsets.length = heights.length;
  const last = heights.length - 1;
  const total = last < 0 ? 0 : offsets[last]! + heights[last]!;
  return { offsets, total };
}

/** Binary search: display row → block index (upperBound(offsets, row) - 1). */
export function itemAtRow(offsets: number[], row: number): number {
  if (offsets.length === 0) return -1;
  if (row <= 0) return 0;
  let lo = 0;
  let hi = offsets.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid]! <= row) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
