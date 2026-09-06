/**
 * Diff data model shared by the transcript renderer (app.tsx) and the
 * unified-diff parser (diff-parser.ts).
 *
 * NOTE: the old DiffView component was removed: App renders diff hunks
 * inline, and the standalone component's tests gave false coverage for UI
 * nobody sees. Only the types remain.
 */

export type DiffLineKind = 'add' | 'remove' | 'context' | 'header';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffHunk {
  path: string;
  lines: DiffLine[];
}
