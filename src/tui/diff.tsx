/**
 * DiffView — a scrollable unified diff display.
 *
 * Data model: a list of `DiffHunk` (one per file). Each hunk has a path
 * and a list of `DiffLine` with kind (add/remove/context/header).
 *
 *   src/auth/service.ts
 *   -  const old = 1;
 *   +  const old = 2;
 *     const same = true;
 *   +  // new line
 *
 * Lines are truncated to 200 chars and color-coded. The view returns
 * null when there's no diff to show.
 */

import React from 'react';
import { Box, Text } from 'ink';

export type DiffLineKind = 'add' | 'remove' | 'context' | 'header';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffHunk {
  path: string;
  lines: DiffLine[];
}

export interface DiffViewProps {
  hunks: DiffHunk[];
  /** Optional: total file count summary. */
  summary?: string;
}

const LINE_COLORS: Record<DiffLineKind, 'green' | 'red' | 'gray' | 'cyan'> = {
  add: 'green',
  remove: 'red',
  context: 'gray',
  header: 'cyan',
};

const GLYPHS: Record<DiffLineKind, string> = {
  add: '+',
  remove: '-',
  context: ' ',
  header: '@',
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

export function DiffView({ hunks, summary }: DiffViewProps): React.JSX.Element | null {
  if (hunks.length === 0) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1} marginY={1}>
        <Text color="gray">(no working-tree changes)</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      {summary ? (
        <Box>
          <Text color="cyan" bold>📝 Diff </Text>
          <Text color="gray">  {summary}</Text>
        </Box>
      ) : null}
      {hunks.map((h, i) => (
        <Box key={`${h.path}-${i}`} flexDirection="column">
          <Box>
            <Text color="cyan" bold>── {h.path} </Text>
            <Text color="gray">
              ({h.lines.filter((l) => l.kind === 'add').length}+ /{' '}
              {h.lines.filter((l) => l.kind === 'remove').length}-)
            </Text>
          </Box>
          {h.lines.map((l, j) => (
            <Box key={j}>
              <Text color={LINE_COLORS[l.kind]}>{GLYPHS[l.kind]} </Text>
              <Text color={LINE_COLORS[l.kind]}>{truncate(l.text, 200)}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
