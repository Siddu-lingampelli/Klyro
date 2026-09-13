/**
 * scroll.md §8.5 (S8) — mouse wheel capture for OpenCode-style scrolling.
 *
 * Ink owns stdin via useInput and cannot see mouse events, so the REPL wraps
 * `process.stdin.emit` with this stateful splitter: SGR/X10 mouse sequences
 * are swallowed (wheel → scroll deltas, clicks/motion → dropped), everything
 * else passes through to Ink untouched.
 *
 * Only the wheel is acted on. Clicks are swallowed (not forwarded) because a
 * mouse-reporting terminal would otherwise deliver them to readline as typed
 * garbage; Shift+drag still selects natively in most terminals.
 *
 * Sequences handled:
 *   SGR: `\x1b[<Cb;x;yM` / `...m`  (1006, requested via `CSI ? 1006 h`)
 *   X10: `\x1b[M Cb Cx Cy`         (fallback for terminals ignoring 1006)
 * Wheel bit is 64 in both; direction bit is 1 (down) — modifiers OR into Cb.
 */

export const WHEEL_LINES = 3; // scroll.md §8.4: wheel = ±3 lines

export interface MouseSplit {
  /** bytes Ink is still allowed to see */
  kept: Buffer;
  /** wheel deltas: negative = up (older), positive = down (newer) */
  wheels: number[];
}

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

export class MouseFilter {
  private pending = Buffer.alloc(0);

  /**
   * Split one stdin chunk. Holds an unambiguous trailing partial mouse
   * sequence for the next chunk; a lone trailing ESC passes through
   * immediately so the Esc key (queued-drop) never lags.
   */
  push(chunk: Buffer): MouseSplit {
    const buf = Buffer.concat([this.pending, chunk]);
    this.pending = Buffer.alloc(0);
    const kept: Buffer[] = [];
    const wheels: number[] = [];
    let i = 0;
    const n = buf.length;

    while (i < n) {
      // SGR mouse: ESC [ < Cb ; x ; y (M|m)
      if (buf[i] === 0x1b && i + 2 < n && buf[i + 1] === 0x5b && buf[i + 2] === 0x3c) {
        let j = i + 3;
        while (j < n && (isDigit(buf[j]!) || buf[j] === 0x3b)) j++;
        if (j >= n) {
          // split across chunks — hold for more data
          this.pending = buf.subarray(i);
          break;
        }
        const term = buf[j]!;
        if (term === 0x4d || term === 0x6d) {
          const cb = parseInt(buf.subarray(i + 3, j).toString().split(';')[0] ?? 'NaN', 10);
          if (!Number.isNaN(cb) && (cb & 64) !== 0) {
            wheels.push((cb & 1) === 0 ? -WHEEL_LINES : WHEEL_LINES);
          }
          i = j + 1; // swallow (wheel or click/motion)
          continue;
        }
        // ESC [ < not followed by digits→M/m: not a mouse seq, pass ESC through
        kept.push(buf.subarray(i, i + 1));
        i++;
        continue;
      }
      // X10 mouse: ESC [ M Cb Cx Cy
      if (buf[i] === 0x1b && i + 2 < n && buf[i + 1] === 0x5b && buf[i + 2] === 0x4d) {
        if (i + 5 >= n) {
          this.pending = buf.subarray(i); // split across chunks
          break;
        }
        const cb = buf[i + 3]! - 32;
        if ((cb & 64) !== 0) {
          wheels.push((cb & 1) === 0 ? -WHEEL_LINES : WHEEL_LINES);
        }
        i += 6; // swallow
        continue;
      }
      // Trailing partial that could ONLY be a split SGR/X10 start: hold it.
      // A lone trailing ESC passes through (Esc key must not lag).
      const tail = n - i;
      if (tail <= 5) {
        const rest = buf.subarray(i).toString('latin1');
        if (/^\x1b\[<$/.test(rest) || /^\x1b\[<[\d;]+$/.test(rest) || /^\x1b\[M.{0,2}$/.test(rest)) {
          this.pending = buf.subarray(i);
          break;
        }
      }
      kept.push(buf.subarray(i, i + 1));
      i++;
    }

    return { kept: Buffer.concat(kept), wheels };
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
  }
}

export const MOUSE_ENABLE = '\x1b[?1000h\x1b[?1006h'; // button events + SGR coords
export const MOUSE_DISABLE = '\x1b[?1000l\x1b[?1006l';

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
export const PASTE_ENABLE = '\x1b[?2004h'; // bracketed paste: terminal wraps pastes
export const PASTE_DISABLE = '\x1b[?2004l';
const PASTE_START_BUF = Buffer.from(PASTE_START, 'latin1');
const PASTE_END_BUF = Buffer.from(PASTE_END, 'latin1');
const MAX_PASTE_BYTES = 1024 * 1024;

/**
 * Bracketed-paste splitter. Strips the `ESC[200~` / `ESC[201~` markers and
 * delivers pasted content as one atomic string so the TUI can bulk-insert
 * it (no per-char autocomplete/history side effects). Content split across
 * stdin chunks is reassembled; an unterminated paste is held (up to 1 MiB,
 * then force-flushed) so a partial escape never leaks into the input.
 */
export class PasteFilter {
  private pending = Buffer.alloc(0);
  private inPaste = false;
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): { kept: Buffer; pastes: string[] } {
    const data = Buffer.concat([this.pending, chunk]);
    this.pending = Buffer.alloc(0);
    const kept: Buffer[] = [];
    const pastes: string[] = [];
    let pos = 0;
    const tailPartial = (from: number): number => {
      // Length of the trailing run that could be a split marker prefix.
      const tail = data.subarray(from);
      for (let len = Math.min(tail.length, 5); len >= 1; len--) {
        const piece = tail.subarray(tail.length - len);
        if (PASTE_START_BUF.subarray(0, len).equals(piece) || PASTE_END_BUF.subarray(0, len).equals(piece)) return len;
      }
      return 0;
    };
    while (pos < data.length) {
      if (!this.inPaste) {
        const idx = data.indexOf(PASTE_START_BUF, pos);
        if (idx === -1) {
          const hold = tailPartial(pos);
          kept.push(data.subarray(pos, hold > 0 ? data.length - hold : data.length));
          if (hold > 0) this.pending = data.subarray(data.length - hold);
          break;
        }
        kept.push(data.subarray(pos, idx));
        pos = idx + PASTE_START_BUF.length;
        this.inPaste = true;
        this.chunks = [];
        this.size = 0;
        continue;
      }
      const idx = data.indexOf(PASTE_END_BUF, pos);
      if (idx === -1) {
        const hold = tailPartial(pos);
        const end = hold > 0 ? data.length - hold : data.length;
        if (end > pos) {
          this.chunks.push(data.subarray(pos, end));
          this.size += end - pos;
        }
        if (hold > 0) this.pending = data.subarray(data.length - hold);
        if (this.size >= MAX_PASTE_BYTES) {
          pastes.push(Buffer.concat(this.chunks).toString('utf8'));
          this.chunks = [];
          this.size = 0;
          this.inPaste = false; // force-flush: don't hold unbounded input
        }
        break;
      }
      this.chunks.push(data.subarray(pos, idx));
      pastes.push(Buffer.concat(this.chunks).toString('utf8'));
      this.chunks = [];
      this.size = 0;
      this.inPaste = false;
      pos = idx + PASTE_END_BUF.length;
    }
    return { kept: Buffer.concat(kept), pastes };
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
    this.inPaste = false;
    this.chunks = [];
    this.size = 0;
  }
}

/**
 * stdin.read() wrapper implementing the tap (see repl.ts installMouseTap).
 * Ink 7 consumes stdin via paused-mode read() calls, so filtering happens
 * here — not on 'data' events (which never fire for Ink).
 *
 * Contract: sized reads pass through untouched; null passes through;
 * mouse sequences are swallowed (wheels dispatched); everything else is
 * returned byte-identical in its original string/Buffer shape.
 */
export function createReadWrapper(
  origRead: (size?: number) => unknown,
  filter: MouseFilter,
  onWheel: (delta: number) => void,
  opts?: { onPaste?: (text: string) => void; pasteFilter?: PasteFilter },
): (size?: number) => unknown {
  return (size?: number): unknown => {
    if (size !== undefined) return origRead(size);
    const chunk = origRead();
    if (chunk == null) return chunk;
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    if (opts?.pasteFilter) {
      const split = opts.pasteFilter.push(buf);
      for (const p of split.pastes) {
        try {
          opts.onPaste?.(p);
        } catch { /* ignore */ }
      }
      buf = split.kept;
      if (buf.length === 0 && split.pastes.length > 0) return null;
    }
    const msplit = filter.push(buf);
    for (const w of msplit.wheels) {
      try {
        onWheel(w);
      } catch { /* ignore */ }
    }
    if (msplit.kept.length === 0) return null;
    return typeof chunk === 'string' ? msplit.kept.toString('utf8') : msplit.kept;
  };
}
