# Klyro TUI — Transcript Scroll: Build Plan

> **Target UX:** Claude Code / OpenCode scroll fidelity + Klyro activity aggregation.
> **Anti-goal:** "a React chat app trapped in a TTY."

---

## 0. Non-Negotiable Invariants

These are the rules that, if violated, cause every scroll bug you've hit. Enforce them with assertions in dev builds.

| # | Invariant | Why |
|---|-----------|-----|
| **I1** | The frame emits **exactly `terminal.rows` lines**. Never more. | One extra line → the terminal itself scrolls → header/input/status leave the screen forever. |
| **I2** | The app runs in the **alternate screen buffer**. | Native scrollback must not fight your viewport. |
| **I3** | Scroll unit is the **wrapped display line**, not the item. | An item can be 1 line or 400 lines. |
| **I4** | Scroll position is stored as an **anchor (itemId + lineInItem)**, never a raw row index. | Reflow (resize, collapse, streaming edit) invalidates raw indices. |
| **I5** | There is **no code path from stdin → ConversationStore**. | This is the root cause of `queued: f`, `queued: df` leaking into the transcript. |
| **I6** | Only the **tail item** mutates during streaming. | Makes cache invalidation O(1). |
| **I7** | `console.*` is **patched out** while the TUI owns stdout. | Stray logs corrupt the frame. |

```
        stdin
          │
     ┌────▼─────┐
     │ KeyRouter│
     └────┬─────┘
     ┌────┼──────────┬─────────────┐
     ▼    ▼          ▼             ▼
 InputBuf Scroll  Palette      Global
          Ctrl                (ctrl+c)

  ✗ NO ARROW FROM ANY OF THESE TO ConversationStore ✗

  ConversationStore ← Normalizer ← Aggregator ← AgentEvents
```

---

## 1. Screen & Terminal Setup

### 1.1 Startup sequence

```ts
// terminal/session.ts
export function enterTui(out: NodeJS.WriteStream) {
  out.write('\x1b[?1049h');   // alternate screen buffer
  out.write('\x1b[?25l');     // hide cursor (we draw our own)
  out.write('\x1b[?1000h');   // mouse: button events
  out.write('\x1b[?1006h');   // mouse: SGR extended coords
  out.write('\x1b[?2004h');   // bracketed paste
  out.write('\x1b[2J\x1b[H'); // clear + home
  process.stdin.setRawMode(true);
}

export function exitTui(out: NodeJS.WriteStream) {
  out.write('\x1b[?2004l\x1b[?1006l\x1b[?1000l');
  out.write('\x1b[?25h');     // show cursor
  out.write('\x1b[?1049l');   // restore main buffer
  process.stdin.setRawMode(false);
}
```

### 1.2 Exit behavior

On clean exit, **replay a plain-text transcript** into the main buffer so the session survives in native scrollback:

```
exitTui() → write plainTextTranscript(conversation) → process.exit(0)
```

Register on: `SIGINT` (2nd press), `SIGTERM`, `exit`, `uncaughtException`. Always restore, even on crash.

---

## 2. Layout Engine

### 2.1 Row budget (deterministic, not flex)

```ts
// layout/compute.ts
export const HEADER_ROWS = 2;     // title line + blank
export const SEP_ROWS    = 1;     // each separator
export const STATUS_ROWS = 1;
export const MAX_INPUT_ROWS = 6;
export const MIN_VIEWPORT   = 3;

export interface Layout {
  header: number; sepTop: number; viewport: number;
  input: number; sepBottom: number; status: number;
  degraded: boolean;
}

export function computeLayout(termRows: number, wantedInputRows: number): Layout {
  let input  = clamp(wantedInputRows, 1, MAX_INPUT_ROWS);
  let header = HEADER_ROWS;

  const fixed = () => header + SEP_ROWS + input + SEP_ROWS + STATUS_ROWS;
  let viewport = termRows - fixed();

  // Degradation ladder
  if (viewport < MIN_VIEWPORT) { input = 1;  viewport = termRows - fixed(); }
  if (viewport < MIN_VIEWPORT) { header = 1; viewport = termRows - fixed(); }

  const degraded = viewport < MIN_VIEWPORT;
  if (degraded) viewport = Math.max(0, termRows - fixed());

  const l = { header, sepTop: SEP_ROWS, viewport, input,
              sepBottom: SEP_ROWS, status: STATUS_ROWS, degraded };

  assertExact(l, termRows); // I1
  return l;
}

function assertExact(l: Layout, rows: number) {
  const sum = l.header + l.sepTop + l.viewport + l.input + l.sepBottom + l.status;
  if (sum !== rows) throw new Error(`Layout invariant broken: ${sum} !== ${rows}`);
}
```

### 2.2 Band map

```
row 0            ┌─ header ────────────────────────┐  fixed
row 1            │  KLYRO v0.1.24    model·project │
row 2            ├─────────────────────────────────┤  sepTop
row 3            │                                 │
  ...            │        VIEWPORT (scrolls)       │  layout.viewport
row 3+V-1        │                                 │
row 3+V          ├─────────────────────────────────┤  sepBottom
row 3+V+1        │ › Message Klyro...              │  input (1..6)
  ...            ├─────────────────────────────────┤
row rows-1       │ enter send ·  $0.04 · 12% ctx   │  status
                 └─────────────────────────────────┘
```

---

## 3. Conversation Model

```ts
// conversation/types.ts
export type ItemKind =
  | 'user' | 'assistant' | 'activity'
  | 'plan' | 'permission' | 'error' | 'system';

export interface BaseItem {
  id: string;
  kind: ItemKind;
  /** bumped on any mutation; used as cache key */
  version: number;
  /** true while the agent is still writing into this item */
  streaming: boolean;
  createdAt: number;
}

export interface UserMessage      extends BaseItem { kind: 'user';      text: string }
export interface AssistantMessage extends BaseItem { kind: 'assistant'; text: string }

export interface ActivityGroup extends BaseItem {
  kind: 'activity';
  op: 'read' | 'search' | 'edit' | 'command' | 'fetch';
  count: number;
  status: 'running' | 'ok' | 'fail';
  details: string[];       // e.g. file paths
  expanded: boolean;
}

export interface Plan             extends BaseItem { kind: 'plan';       steps: PlanStep[]; expanded: boolean }
export interface PermissionRequest extends BaseItem { kind: 'permission'; prompt: string; options: string[] }
export interface ErrorMessage     extends BaseItem { kind: 'error';      title: string; detail?: string; expanded: boolean }

export type ConversationItem =
  | UserMessage | AssistantMessage | ActivityGroup
  | Plan | PermissionRequest | ErrorMessage;
```

### 3.1 Store API (the only writer)

```ts
// conversation/store.ts
class ConversationStore {
  private items: ConversationItem[] = [];
  private listeners = new Set<() => void>();

  append(item: ConversationItem): void;
  /** streaming: mutate tail only (I6) */
  appendToTail(text: string): void;
  finalizeTail(): void;
  toggleExpand(id: string): void;

  getItems(): readonly ConversationItem[];
  subscribe(fn: () => void): () => void;
}
```

> No component, no key handler, no logger calls anything other than these methods. Enforce with an ESLint rule / module boundary.

---

## 4. Measurement Layer (item → display lines)

This is the piece the naive plan gets wrong. You cannot scroll correctly without measuring **post-wrap** lines.

### 4.1 Renderer contract

```ts
// render/measure.ts
export interface RenderedLine {
  /** already ANSI-styled, already wrapped to `width` */
  text: string;
}

export interface MeasuredItem {
  id: string;
  version: number;
  width: number;
  lines: RenderedLine[];   // length === height
  height: number;
}

/** Pure: item + width → lines. No side effects, no hooks. */
export function renderItem(item: ConversationItem, width: number): RenderedLine[];
```

Wrapping must use **display width**, not `.length`:

```ts
import stringWidth from 'string-width';   // wcwidth: CJK=2, emoji=2, combining=0
import stripAnsi   from 'strip-ansi';
// wrap on grapheme clusters, preserve ANSI state across wrap boundaries
```

### 4.2 Cache

```ts
// render/cache.ts
class MeasureCache {
  private map = new Map<string, MeasuredItem>();  // key: item.id

  measure(item: ConversationItem, width: number): MeasuredItem {
    const hit = this.map.get(item.id);
    if (hit && hit.version === item.version && hit.width === width) return hit;
    const lines = renderItem(item, width);
    const m = { id: item.id, version: item.version, width, lines, height: lines.length };
    this.map.set(item.id, m);
    return m;
  }

  invalidateWidth() { this.map.clear(); }        // on resize
  evictBefore(idx: number, items: ConversationItem[]) { /* LRU for huge sessions */ }
}
```

**Streaming cost:** only the tail item's `version` changes each tick → exactly one re-measure per frame regardless of history size.

### 4.3 Line index (row ↔ item mapping)

```ts
// render/index.ts
class LineIndex {
  private offsets: number[] = [];   // offsets[i] = first display row of items[i]
  private dirtyFrom = 0;
  total = 0;

  markDirty(i: number) { this.dirtyFrom = Math.min(this.dirtyFrom, i); }

  rebuild(items: readonly ConversationItem[], cache: MeasureCache, width: number) {
    for (let i = this.dirtyFrom; i < items.length; i++) {
      this.offsets[i] = i === 0 ? 0 : this.offsets[i-1] + cache.measure(items[i-1], width).height;
    }
    const last = items.length - 1;
    this.total = last < 0 ? 0
      : this.offsets[last] + cache.measure(items[last], width).height;
    this.offsets.length = items.length;
    this.dirtyFrom = items.length;
  }

  /** binary search: display row → item index */
  itemAt(row: number): number { return upperBound(this.offsets, row) - 1; }
  offsetOf(i: number): number { return this.offsets[i] ?? 0; }
}
```

| Event | Dirty from |
|-------|-----------|
| append item | `items.length - 1` |
| tail streaming update | `items.length - 1` |
| expand/collapse item *i* | `i` |
| resize (width change) | `0` (+ `cache.invalidateWidth()`) |

Upgrade `offsets[]` → Fenwick tree only when `items.length > 10_000` (Phase 11).

---

## 5. Scroll Model — Anchor-Based

### 5.1 Why not `position: number`

```
Conversation with an ActivityGroup at item 40.
User scrolled so topRow = 1200.
Agent finishes → group collapses from 14 lines → 1 line.

  position-based:  topRow stays 1200 → content jumps 13 lines. ✗
  anchor-based:    anchor = {itemId:"m73", lineInItem:2} → still shows m73. ✓
```

### 5.2 State

```ts
// scroll/state.ts
export type Anchor =
  | { mode: 'bottom' }
  | { mode: 'pinned'; itemId: string; lineInItem: number };

export interface ScrollState {
  anchor: Anchor;
  /** derived each frame, exposed for the UI/tests */
  topRow: number;
  atBottom: boolean;
  userScrolled: boolean;
  /** display lines appended since the user unstuck */
  newSinceUnstick: number;
}

export const initialScroll: ScrollState = {
  anchor: { mode: 'bottom' },
  topRow: 0, atBottom: true, userScrolled: false, newSinceUnstick: 0,
};
```

### 5.3 Resolution (run once per frame, after `LineIndex.rebuild`)

```ts
// scroll/resolve.ts
export function resolveTopRow(
  s: ScrollState, items: readonly ConversationItem[],
  index: LineIndex, viewportH: number,
): { topRow: number; atBottom: boolean } {
  const maxTop = Math.max(0, index.total - viewportH);

  if (s.anchor.mode === 'bottom') return { topRow: maxTop, atBottom: true };

  const i = items.findIndex(it => it.id === s.anchor.itemId);
  if (i === -1) return { topRow: maxTop, atBottom: true };   // item pruned → re-stick

  const raw = index.offsetOf(i) + s.anchor.lineInItem;
  const topRow = clamp(raw, 0, maxTop);
  return { topRow, atBottom: topRow >= maxTop };
}
```

### 5.4 Actions

```ts
export type ScrollAction =
  | { type: 'BY_LINES'; delta: number }        // ±1, wheel = ±3
  | { type: 'BY_PAGE'; dir: -1 | 1 }
  | { type: 'BY_HALF_PAGE'; dir: -1 | 1 }
  | { type: 'TO_TOP' }
  | { type: 'TO_BOTTOM' }
  | { type: 'CONTENT_GREW'; lines: number }
  | { type: 'REFLOW' };                        // resize / expand-collapse
```

### 5.5 Reducer

```ts
// scroll/reducer.ts
export interface Ctx {
  items: readonly ConversationItem[];
  index: LineIndex;
  viewportH: number;
}

const FOLLOW_EPSILON = 1;   // within 1 line of bottom counts as "at bottom"

export function scrollReducer(s: ScrollState, a: ScrollAction, ctx: Ctx): ScrollState {
  const { index, viewportH, items } = ctx;
  const maxTop = Math.max(0, index.total - viewportH);
  const cur = s.topRow;

  const pinAt = (row: number): ScrollState => {
    const top = clamp(row, 0, maxTop);
    if (top >= maxTop - FOLLOW_EPSILON) return stickBottom();
    const i = index.itemAt(top);
    return {
      anchor: { mode: 'pinned', itemId: items[i].id, lineInItem: top - index.offsetOf(i) },
      topRow: top, atBottom: false, userScrolled: true,
      newSinceUnstick: s.newSinceUnstick,
    };
  };

  const stickBottom = (): ScrollState => ({
    anchor: { mode: 'bottom' },
    topRow: maxTop, atBottom: true, userScrolled: false, newSinceUnstick: 0,
  });

  switch (a.type) {
    case 'BY_LINES':     return pinAt(cur + a.delta);
    case 'BY_PAGE':      return pinAt(cur + a.dir * (viewportH - 1));   // 1-line overlap
    case 'BY_HALF_PAGE': return pinAt(cur + a.dir * Math.floor(viewportH / 2));
    case 'TO_TOP':       return pinAt(0);
    case 'TO_BOTTOM':    return stickBottom();

    case 'CONTENT_GREW':
      if (s.anchor.mode === 'bottom') return stickBottom();   // follow
      return { ...s, newSinceUnstick: s.newSinceUnstick + a.lines };   // freeze + count

    case 'REFLOW': {
      const r = resolveTopRow(s, items, index, viewportH);
      return { ...s, topRow: r.topRow, atBottom: r.atBottom };
    }
  }
}
```

### 5.6 Behavior lock

```
                    ┌─────────────────────┐
                    │ anchor = 'bottom'   │◄──── TO_BOTTOM (End/Ctrl+G/Enter)
                    │ atBottom = true     │◄──── scrolled back within ε
                    └──────────┬──────────┘      item pruned
                               │
                     CONTENT_GREW
                               │
                    ┌──────────▼──────────┐
                    │ topRow = maxTop     │   AUTO-FOLLOW
                    └─────────────────────┘

          user scrolls up (↑ / PgUp / Ctrl+U / wheel)
                               │
                    ┌──────────▼──────────────────┐
                    │ anchor = {itemId, line}     │
                    │ atBottom=false              │   FROZEN
                    │ userScrolled=true           │
                    └──────────┬──────────────────┘
                               │
                     CONTENT_GREW
                               │
                    ┌──────────▼──────────────────┐
                    │ topRow UNCHANGED            │
                    │ newSinceUnstick += n        │
                    │ badge: "↓ 8 new"            │
                    └─────────────────────────────┘
```

---

## 6. Auto-Follow Wiring

Per frame, in order:

```
1. store.getItems()
2. index.rebuild(items, cache, width)          ← measures dirty tail only
3. grew = index.total - prevTotal
4. if (grew > 0) dispatch CONTENT_GREW { lines: grew }
   if (widthChanged || expandToggled) dispatch REFLOW
5. { topRow, atBottom } = resolveTopRow(scroll, items, index, viewportH)
6. lines = sliceLines(topRow, topRow + viewportH)
7. compose frame → write
8. prevTotal = index.total
```

`CONTENT_GREW` is computed from **measured display lines**, not item count. This is what makes `↓ 8 new` accurate.

### 6.1 Slicing

```ts
function sliceLines(items, index, cache, width, start: number, end: number): string[] {
  const out: string[] = [];
  let i = index.itemAt(start);
  let row = index.offsetOf(i);
  while (i < items.length && row < end) {
    const m = cache.measure(items[i], width);
    for (let k = 0; k < m.height && row < end; k++, row++) {
      if (row >= start) out.push(m.lines[k].text);
    }
    i++;
  }
  while (out.length < end - start) out.push('');   // pad → I1
  return out;
}
```

Only items intersecting `[start, end)` are ever measured after the first pass. **This is virtualization** — you get it for free from the line index.

---

## 7. Jump-to-Bottom Badge

### 7.1 Rendering — overlay, not a new row

Do **not** add a row (that breaks I1). Overwrite the **last viewport line**, right-aligned:

```ts
function overlayBadge(lines: string[], n: number, width: number): string[] {
  if (n <= 0) return lines;
  const label = `  ↓ ${n} new  `;
  const col = Math.max(0, width - stringWidth(label) - 2);
  const last = lines.length - 1;
  lines[last] = overwriteAt(lines[last], col, dim(inverse(label)), width);
  return lines;
}
```

Result:

```
│    src/auth/session.ts                                       │
│    src/auth/middleware.ts                                    │
│    Running tests...                            ↓ 8 new       │
├──────────────────────────────────────────────────────────────┤
│ › Message Klyro...                                           │
```

### 7.2 Rules

| Condition | Badge |
|-----------|-------|
| `atBottom === true` | hidden |
| `newSinceUnstick === 0` | hidden |
| `1..999` | `↓ N new` |
| `>= 1000` | `↓ 999+ new` |
| agent idle **and** frozen | `↓ jump to end` (no count) |

Dismissed by: `End`, `Ctrl+G`, `Enter` (when input is empty), or scrolling back within ε.

---

## 8. Input Isolation & Key Routing

### 8.1 Focus ownership

```ts
type FocusOwner = 'input' | 'permission' | 'palette' | 'search';

interface FocusState { owner: FocusOwner; }
```

Exactly one owner at a time. `KeyRouter` consults focus **before** dispatch.

### 8.2 Routing precedence

```
                     key event
                         │
              ┌──────────▼───────────┐
              │ 1. Global intercepts │  ctrl+c, ctrl+d, ctrl+l
              └──────────┬───────────┘  (never forwarded)
                         │ not handled
              ┌──────────▼───────────┐
              │ 2. Modal owner       │  permission / palette
              └──────────┬───────────┘  (consumes ALL keys)
                         │ owner === 'input'
              ┌──────────▼───────────┐
              │ 3. Explicit scroll   │  PgUp/PgDn, Ctrl+U/D,
              └──────────┬───────────┘  Home/End, Ctrl+G, wheel
                         │ not a scroll key
              ┌──────────▼───────────┐
              │ 4. Contextual ↑/↓    │  see table below
              └──────────┬───────────┘
                         │
              ┌──────────▼───────────┐
              │ 5. InputBuffer       │  text, backspace, enter…
              └──────────────────────┘
```

### 8.3 Contextual `↑` / `↓` (the subtle part)

| Input buffer state | `↑` | `↓` |
|---|---|---|
| empty, no history browsing | **scroll up 1** | **scroll down 1** |
| empty, browsing history | prev history | next history → then empty |
| single line, has text | prev history | next history |
| multiline, cursor **not** on first line | move cursor up | — |
| multiline, cursor on first line | prev history | — |
| multiline, cursor **not** on last line | — | move cursor down |
| multiline, cursor on last line | — | next history |

> `↑`/`↓` are **never** stolen from the editor while the user has text. Scrolling long transcripts is done with PgUp/PgDn, Ctrl+U/D, or the wheel.

### 8.4 Full binding table

| Key | Sequence | Action |
|---|---|---|
| `↑` / `↓` | `\x1b[A` / `\x1b[B` | contextual (table 8.3) |
| `PageUp` | `\x1b[5~` | `BY_PAGE -1` |
| `PageDown` | `\x1b[6~` | `BY_PAGE +1` |
| `Ctrl+U` | `\x15` | `BY_HALF_PAGE -1` |
| `Ctrl+D` | `\x04` | `BY_HALF_PAGE +1` (if input empty; else EOF guard) |
| `Home` | `\x1b[H` / `\x1b[1~` | `TO_TOP` |
| `End` | `\x1b[F` / `\x1b[4~` | `TO_BOTTOM` |
| `Ctrl+G` | `\x07` | `TO_BOTTOM` |
| `Enter` | `\r` | send if input non-empty; else `TO_BOTTOM` if badge visible |
| `Shift+Enter` | `\x1b\r` / `\x1b[13;2u` | newline in input |
| Wheel up | `\x1b[<64;C;RM` | `BY_LINES -3` |
| Wheel down | `\x1b[<65;C;RM` | `BY_LINES +3` |
| `Ctrl+L` | `\x0c` | force full repaint |
| `Ctrl+C` | `\x03` | interrupt agent; 2nd press exits |
| `o` (viewport focus) | — | toggle expand of item under cursor |

### 8.5 Raw key decoder

Ink's `useInput` does **not** reliably emit PageUp/PageDown/Home/End or mouse. Own the decoder.

```ts
// input/decode.ts
export type Key =
  | { t:'char'; value:string }
  | { t:'special'; name:'up'|'down'|'left'|'right'|'pageup'|'pagedown'|'home'|'end'|'enter'|'shiftEnter'|'backspace'|'tab'|'esc' }
  | { t:'ctrl'; letter:string }
  | { t:'wheel'; dir:-1|1 }
  | { t:'paste'; text:string };

export function decode(buf: Buffer, state: DecoderState): Key[];
```

Must handle:
- **Bracketed paste**: buffer everything between `\x1b[200~` and `\x1b[201~`, emit one `paste` event. Prevents a 500-line paste being interpreted as 500 keystrokes.
- **Partial escape sequences** across chunk boundaries (`\x1b` arriving alone). Keep a pending buffer with a 25 ms flush timer to disambiguate lone `ESC`.
- **SGR mouse**: `\x1b[<{b};{x};{y}{M|m}`; `b & 64` → wheel, `b & 1` → down vs up.

### 8.6 Killing the `queued: f` bug

Root causes and their guards:

| Cause | Guard |
|---|---|
| Key handler writes debug text into transcript | **I5** — no path from router to store; enforced by module boundary lint |
| Keys buffered during a blocking render, flushed as text later | Decoder runs on the stdin `data` event, **synchronously**, independent of the render loop |
| `console.log` from a tool/agent hitting stdout | Patch `console.*` → ring buffer + `~/.klyro/debug.log` while TUI is active |
| Modal opens, keys leak to input | Single `FocusOwner`; modals consume all keys |
| Paste interpreted per-char | Bracketed paste (8.5) |

---

## 9. Activity Aggregation

### 9.1 Pipeline

```
AgentEvent stream
      │
   Normalizer         raw → { type, tool, target, status, ts }
      │
   Aggregator         merge consecutive same-op events into one ActivityGroup
      │
   ConversationStore  append / mutate tail
      │
   MeasureCache + LineIndex
      │
   Viewport slice
```

### 9.2 Merge rules

```ts
// conversation/aggregator.ts
const MERGE_WINDOW_MS = 5000;

function shouldMerge(tail: ConversationItem | undefined, e: AgentEvent): boolean {
  return tail?.kind === 'activity'
      && tail.op === opOf(e.tool)
      && tail.status === 'running'
      && (e.ts - tail.lastTs) < MERGE_WINDOW_MS;
}
```

| Consecutive events | Collapsed line |
|---|---|
| N × read_file | `✓ Read 14 files` |
| N × grep/glob | `✓ Searched 38 files` |
| N × edit/write | `✓ Modified 4 files` |
| N × bash | `✓ Ran 4 commands` |
| in-flight | `⠋ Reading files… (7)` |
| any failure in group | `✗ Modified 3 files · 1 failed` |

**Never break a group** across a different op — `read,read,edit,read` → 3 groups, not 2.

### 9.3 Collapsed / expanded heights

```
collapsed:                    expanded:
  ✓ Read 14 files               ▼ Read 14 files
  → height 1                      src/auth/index.ts
                                  src/auth/service.ts
                                  … 11 more
                                  src/auth/types.ts
                                → height 1 + min(details, 12) + overflow line
```

Cap expanded detail at 12 rows + `… N more` to keep any single item from dwarfing the viewport.

On toggle: `store.toggleExpand(id)` → `index.markDirty(i)` → `dispatch REFLOW`. Because the anchor is item-relative (**I4**), the viewport does **not** jump.

---

## 10. Render Pipeline & Frame Scheduling

### 10.1 Decouple agent rate from frame rate

```ts
// render/loop.ts
const FRAME_MS = 1000 / 30;   // 30 fps cap
let dirty = false;

store.subscribe(() => { dirty = true; });
scrollBus.subscribe(() => { dirty = true; });

setInterval(() => {
  if (!dirty) return;
  dirty = false;
  renderFrame();
}, FRAME_MS);
```

An agent emitting 400 events/sec produces **30 frames/sec**, not 400.

### 10.2 Frame composition

```ts
function renderFrame() {
  const { rows, columns } = out;
  const layout = computeLayout(rows, inputEditor.wrappedRows(columns));

  index.rebuild(items, cache, columns);
  reconcileScroll(layout.viewport);

  const frame: string[] = [
    ...renderHeader(layout.header, columns),
    separator(columns),
    ...overlayBadge(
        sliceLines(items, index, cache, columns, scroll.topRow, scroll.topRow + layout.viewport),
        scroll.atBottom ? 0 : scroll.newSinceUnstick, columns),
    separator(columns),
    ...inputEditor.render(layout.input, columns),
    renderStatus(columns),
  ];

  assert(frame.length === rows);   // I1
  writer.paint(frame);
}
```

### 10.3 Writer — line-diff, no flicker

```ts
// render/writer.ts
class Writer {
  private prev: string[] = [];

  paint(next: string[]) {
    let buf = '\x1b[?25l';           // hide cursor during paint
    for (let r = 0; r < next.length; r++) {
      if (this.prev[r] === next[r]) continue;
      buf += `\x1b[${r + 1};1H\x1b[2K` + next[r];
    }
    buf += this.cursorTo(inputEditor.cursorRow, inputEditor.cursorCol);
    buf += '\x1b[?25h';
    this.out.write(buf);
    this.prev = next;
  }

  full() { this.prev = []; }        // Ctrl+L / resize
}
```

Typing a character repaints **1 line**, not 40. Streaming repaints only the changed tail lines.

> **If using Ink:** keep Ink for composing the *strings*, but let `Writer` own stdout, or accept Ink's full-frame diff. Either way `frame.length === rows` must hold. The custom writer is strongly recommended once you hit L5+.

---

## 11. Virtualization Path

You already have virtualization from §6.1 (only visible items are measured). The remaining scaling work:

| Session size | Action |
|---|---|
| < 2 000 items | Nothing. `offsets[]` + linear rebuild is fine. |
| 2 000 – 10 000 | Cap `MeasureCache` to ~500 entries, LRU-evict off-screen items. |
| > 10 000 | Replace `offsets[]` with a **Fenwick tree** → `O(log n)` height update and prefix query. |
| > 50 000 / long autonomous runs | **Compaction**: fold items older than N into a single `system` item: `⋯ 8,412 earlier messages (ctrl+r to load)`. Keep them on disk. |

```
Fenwick upgrade (drop-in, same interface):
  itemAt(row)      → O(log n) tree descent
  offsetOf(i)      → O(log n) prefix sum
  setHeight(i, h)  → O(log n) point update
```

Gate behind `KLYRO_TRANSCRIPT_ENGINE=fenwick`.

---

## 12. Resize & Edge Cases

| Case | Handling |
|---|---|
| **Width change** | `cache.invalidateWidth()`, `index.markDirty(0)`, rebuild, `REFLOW`, `writer.full()` |
| **Height change** | recompute layout, `REFLOW` (anchor keeps the same item on screen) |
| **Resize storm** | debounce 50 ms trailing; drop intermediate frames |
| **Terminal < 10 rows** | degraded mode: header 1 row, input 1 row, viewport = remainder, no separators |
| **Terminal < 5 rows** | render only input + status; transcript hidden; status shows `⚠ terminal too small` |
| **Single item taller than viewport** | scroll *within* it — anchor's `lineInItem` handles this natively |
| **Empty conversation** | `total = 0`, `maxTop = 0`, viewport = blank padding, `atBottom = true` |
| **Item pruned/compacted while pinned** | `resolveTopRow` finds no `itemId` → re-stick to bottom |
| **Streaming tail shrinks** (text rewrite) | `CONTENT_GREW` with negative delta → ignore the counter, still `REFLOW` |
| **Emoji / CJK / combining marks** | `string-width` everywhere; never `.length` |
| **ANSI across wrap boundary** | wrapper re-emits active SGR state at each wrapped line start |

---

## 13. Failure Modes → Guards

| Symptom | Root cause | Guard |
|---|---|---|
| Whole screen scrolls, header gone | frame > terminal rows | **I1** assertion in dev; padding in `sliceLines` |
| Input duplicated down the screen | not using alt screen / no full clear | **I2** + `writer.full()` on resize |
| Viewport yanks down mid-read | position-based follow | **I4** anchor + `CONTENT_GREW` freeze branch |
| Content jumps when a group collapses | raw row index | **I4** anchor is item-relative |
| `queued: f` in transcript | stdin → store path | **I5** + focus owner + bracketed paste |
| Flicker while streaming | full repaint every frame | line-diff `Writer` |
| Freezes at 500 events/s | render per event | 30 fps coalescing loop |
| Badge count wrong | counting items, not lines | count **display lines** from `LineIndex` delta |
| Scroll feels sticky near bottom | no epsilon | `FOLLOW_EPSILON = 1` |
| Stray tool output corrupts frame | `console.log` | **I7** console patch |

---

## 14. Module Structure

```
src/tui/
├── index.ts                     # enterTui / exitTui / bootstrap
│
├── terminal/
│   ├── session.ts               # alt screen, raw mode, mouse, paste
│   ├── size.ts                  # resize observer + debounce
│   └── console-patch.ts         # I7
│
├── layout/
│   └── compute.ts               # row budget + assertExact
│
├── conversation/
│   ├── types.ts
│   ├── store.ts                 # ONLY writer to transcript
│   ├── normalizer.ts            # AgentEvent → typed
│   └── aggregator.ts            # merge rules
│
├── render/
│   ├── measure.ts               # renderItem(item, width) → lines
│   ├── wrap.ts                  # ANSI-aware, wcwidth-aware wrapping
│   ├── cache.ts                 # MeasureCache (+ LRU)
│   ├── line-index.ts            # offsets / Fenwick
│   ├── slice.ts                 # sliceLines + padding
│   ├── writer.ts                # line-diff painter
│   └── loop.ts                  # 30fps frame scheduler
│
├── scroll/
│   ├── state.ts                 # Anchor, ScrollState
│   ├── reducer.ts               # pure
│   ├── resolve.ts               # anchor → topRow
│   └── controller.ts            # binds actions to bus
│
├── input/
│   ├── decode.ts                # raw escape-sequence decoder
│   ├── router.ts                # precedence chain (§8.2)
│   ├── focus.ts                 # FocusOwner
│   ├── buffer.ts                # text buffer, cursor, multiline
│   └── history.ts
│
└── views/
    ├── header.ts
    ├── status.ts
    ├── badge.ts
    ├── separator.ts
    └── items/                   # per-kind renderers (pure, string[])
        ├── user.ts
        ├── assistant.ts
        ├── activity.ts
        ├── plan.ts
        ├── permission.ts
        └── error.ts
```

**Boundary lint rule:**
```
input/**  MUST NOT import  conversation/store     (I5)
views/**  MUST BE pure     (no store writes, no stdout)
render/** MUST NOT import  input/**
```

---

## 15. Test Matrix

### 15.1 Pure unit (no terminal)

| Suite | Cases |
|---|---|
| `layout` | 24/50/8/4-row terminals; input 1–6 rows; `assertExact` never throws |
| `wrap` | ASCII, CJK, emoji ZWJ, combining accents, ANSI spanning a wrap, zero-width, tabs |
| `line-index` | append; tail grow; mid-list height change; `itemAt` boundaries (0, total-1, total) |
| `scroll/reducer` | **follow at bottom**; **freeze when pinned**; badge increments by display lines; page overlap = 1; clamp at top/bottom; epsilon re-stick; pruned anchor → bottom |
| `scroll/resolve` | collapse above anchor → same item visible; resize width → same item visible |
| `aggregator` | 14 reads → 1 group; read,read,edit,read → 3 groups; window timeout splits; failure marks group |
| `decode` | split escape across chunks; lone ESC; bracketed paste with embedded `\r`; SGR wheel; shift+enter variants |

### 15.2 Golden-frame (snapshot the exact `string[]`)

```ts
it('freezes viewport while agent streams', () => {
  const t = harness({ rows: 24, cols: 80 });
  t.seed(500);                       // 500 display lines
  t.key('pageup'); t.key('pageup');
  const before = t.frame();
  t.stream(200);                     // agent emits 200 more lines
  expect(t.frame().slice(3, 20)).toEqual(before.slice(3, 20));   // viewport identical
  expect(t.frame()).toContainBadge('↓ 200 new');
});
```

Required goldens:
- fresh session (empty transcript)
- mid-stream, at bottom (follows)
- mid-stream, scrolled up (frozen + badge)
- badge dismissal via `End`
- expand `Read 14 files` → viewport does not jump
- multiline input grows → viewport shrinks by exactly that many rows
- resize 80→40 cols → anchored item still visible
- terminal 6 rows → degraded mode, no crash

### 15.3 Invariant fuzz

```
for 10_000 random ops (append | stream | expand | collapse | scroll | resize):
  assert frame.length === rows
  assert 0 <= topRow <= max(0, total - viewportH)
  assert atBottom === (topRow >= maxTop - EPS)
  assert every rendered line's displayWidth <= cols
  assert no transcript line originated from stdin
```

### 15.4 Performance gates (CI-enforced)

| Metric | Budget |
|---|---|
| frame compose, 10 000 items, scrolled to middle | < 4 ms |
| `index.rebuild` on tail stream tick | < 0.2 ms |
| `writer.paint` on 1-char input change | < 0.5 ms, ≤ 2 lines written |
| frames/sec under 500 agent events/sec | ≤ 31 |
| RSS growth over 10 000-item session | < 80 MB |

---

## 16. Build Order

| Sprint | Deliverable | Acceptance criteria |
|---|---|---|
| **S1** | `terminal/session`, `layout/compute`, `writer`, static 4-band frame | Resize any size → header/input/status stay pinned; `assertExact` never throws; Ctrl+C restores terminal cleanly |
| **S2** | `wrap`, `measure`, `cache`, `line-index` | Golden tests for CJK/emoji/ANSI wrapping; `itemAt`/`offsetOf` fuzz-clean |
| **S3** | `scroll/state`, `reducer`, `resolve`, `slice` + manual keys (PgUp/PgDn/Home/End) | Can scroll 5 000 seeded lines; no jump, no overflow; anchor survives resize |
| **S4** | `CONTENT_GREW` auto-follow | Streaming 200 lines while at bottom → viewport follows, never overflows |
| **S5** | Freeze-on-scroll-up + `badge` overlay | Golden test 15.2 #1 passes; badge count == display lines; `End`/`Ctrl+G`/`Enter` dismiss |
| **S6** | `input/decode`, `router`, `focus`, `buffer`, `history` | Contextual ↑/↓ table 8.3 fully honored; paste 500 lines → 1 event; **zero** stdin→transcript paths (lint gate green) |
| **S7** | `normalizer`, `aggregator`, activity item renderer | `read×14` → `✓ Read 14 files`; expand/collapse causes no viewport jump |
| **S8** | Mouse wheel + `render/loop` coalescing + `console-patch` | 500 ev/s → ≤ 31 fps; wheel scrolls 3 lines; no stray log corrupts frame |
| **S9** | Edge cases, degraded mode, resize debounce, exit transcript replay | Test matrix 15.1–15.3 green; tiny-terminal cases pass |
| **S10** | Perf pass: LRU cache eviction, perf gates in CI | Budgets in 15.4 met at 10 000 items |
| **S11** *(pre-L9)* | Fenwick line index + history compaction, behind flag | 100 000-item synthetic session holds all perf budgets |

**S1–S9 ≈ 8–9 days** to a locked, production-grade scroll. S10–S11 before autonomous long-runs.

---

## 17. Non-Goals (v1)

- Horizontal scrolling — content wraps or truncates with `…`.
- Text selection / copy via mouse drag — mouse reporting is wheel-only; hold `Shift` for native terminal selection.
- Split panes, multiple transcripts.
- Persisted scroll position across restarts.
- Search-in-transcript (`/`) — designed for, but shipped in a later phase (it reuses `LineIndex` + anchor).
- Smooth/animated scrolling — terminals are line-quantized; snapping is correct.

---

## 18. The Spec in One Paragraph

Klyro owns the **alternate screen** and paints **exactly `terminal.rows` lines every frame** across four bands: pinned header, scrolling transcript viewport, pinned input, pinned status. The transcript is measured into **wrapped display lines** by a pure renderer whose output is cached per `(itemId, version, width)` and indexed by cumulative offsets — so only the ~40 lines intersecting the viewport are ever composed, and only the streaming tail is ever re-measured. Scroll position is an **anchor `{itemId, lineInItem}`**, not a row number, so resizes, activity-group collapses, and history compaction never make the view jump. While anchored to `bottom`, new output follows; the instant the user scrolls up the anchor **pins to an item and freezes**, and appended display lines accumulate into a subtle right-aligned `↓ N new` overlay on the viewport's last row — dismissed by `End`, `Ctrl+G`, `Enter`, or scrolling back within one line of the end. Keys are decoded from raw escape sequences by a single router with strict precedence, so `↑`/`↓` belong to the editor whenever it holds text and to the viewport when it doesn't, and **there is no code path from stdin to the conversation store** — `queued: f` is structurally impossible. Tool events are merged by an aggregator into `✓ Read 14 files` lines that expand in place without moving the view. Rendering is coalesced to 30 fps and written with a line-diff painter, so a 500-event/second agent costs 30 frames and a keystroke costs one repainted line.