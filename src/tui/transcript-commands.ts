/**
 * scroll.md §§2/4/5/6 — TranscriptCommand abstraction.
 *
 * Only four scroll commands exist (Cline parity):
 *   messages_half_page_up / messages_half_page_down /
 *   messages_first / messages_last
 *
 * Flow (§6): Keyboard → getTranscriptCommand() → TranscriptScrollHandle →
 * ChatMessageList. Keys are matched in ONE place (the §5 binding table);
 * the App routes everything else (history, autocomplete, approvals).
 *
 * Note on the stack: the doc's `<scrollbox stickyScroll>` is OpenTUI-only
 * and this app renders with Ink, which has no scrollbox primitive — so the
 * handle drives the measured anchor viewport (tui/scroll-model.ts) instead.
 * The command vocabulary and all §21 behaviors are identical.
 */

export type TranscriptCommand =
  | 'messages_half_page_up'
  | 'messages_half_page_down'
  | 'messages_first'
  | 'messages_last';

export interface TranscriptScrollHandle {
  runTranscriptCommand(command: TranscriptCommand): void;
}

/** Minimal Ink key shape needed for the binding table. */
export interface TranscriptKey {
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  ctrl?: boolean;
}

/**
 * scroll.md §5 binding table (pure — unit-tested):
 *   PageUp / Ctrl+U → up · PageDown / Ctrl+D → down ·
 *   Ctrl+Home → first · Ctrl+End → last · anything else → undefined.
 */
export function getTranscriptCommand(
  input: string,
  key: TranscriptKey,
): TranscriptCommand | undefined {
  if (key.pageUp || (key.ctrl && input === 'u')) return 'messages_half_page_up';
  if (key.pageDown || (key.ctrl && input === 'd')) return 'messages_half_page_down';
  if (key.home && key.ctrl) return 'messages_first';
  if (key.end && key.ctrl) return 'messages_last';
  return undefined;
}
