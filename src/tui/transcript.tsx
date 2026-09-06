/**
 * Transcript item types — the scrollable entry list owned by App.
 *
 * NOTE: the old Transcript/TranscriptRow/ToolCard presentational components
 * were removed: App renders entries inline (grouped tool activity), and the
 * standalone components' tests gave false coverage for UI nobody sees.
 * Only the item types remain.
 */

import type { DiffHunk } from './diff.js';

export type TranscriptItem =
  | { id: string; kind: 'text'; text: string; role: 'user' | 'assistant' }
  | {
      id: string;
      kind: 'tool';
      name: string;
      id_call: string;
      args: string;
      result?: string;
      isError?: boolean;
      latencyMs?: number;
      /** When running, no result is attached yet. */
      status: 'running' | 'done' | 'error';
    }
  | { id: string; kind: 'policy'; name: string; action: 'allow' | 'ask' | 'deny'; reason?: string }
  | { id: string; kind: 'error'; message: string }
  | { id: string; kind: 'file_changed'; path: string; op: 'created' | 'modified' | 'deleted' }
  | { id: string; kind: 'diff'; hunks: DiffHunk[]; summary?: string };

/** Patch applied to a running tool item when its result arrives. */
export interface ToolResultPatch {
  result: string;
  isError: boolean;
  latencyMs: number;
  status: 'done' | 'error';
}
