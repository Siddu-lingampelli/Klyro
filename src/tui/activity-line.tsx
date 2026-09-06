/**
 * 5.6 Activity Line (Spinner) — TUI_DESIGN.md §5.6
 * Composition: spinner · verb · elapsed · tokens up/down · hint
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { tokens, glyphs } from './tokens.js';

export interface ActivityLineProps {
  verb?: string;
  elapsedMs?: number;
  tokensUp?: number;
  tokensDown?: number;
  hint?: string;
  planProgress?: string;
  isPaused?: boolean;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

export function ActivityLine(props: ActivityLineProps): React.JSX.Element | null {
  const { verb = 'Working…', elapsedMs = 0, tokensUp, tokensDown, hint = 'esc to interrupt', planProgress, isPaused } = props;

  if (isPaused) {
    return (
      <Box paddingX={1}>
        <Text color={tokens.ansi.warning}>⏸ Paused — type an instruction to steer, or enter to continue, esc again to stop</Text>
      </Box>
    );
  }

  const elapsed = formatElapsed(elapsedMs);
  const tokensPart =
    tokensUp !== undefined || tokensDown !== undefined
      ? ` · ↑ ${tokensUp ?? 0} ${tokensDown !== undefined ? `↓ ${tokensDown}` : ''}`
      : '';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={tokens.ansi.info}><Spinner type="dots" /> </Text>
        <Text bold>{verb} </Text>
        <Text color={tokens.ansi.muted} dimColor>({elapsed}{tokensPart} · {hint})</Text>
      </Box>
      {planProgress ? (
        <Box paddingLeft={2}>
          <Text color={tokens.ansi.muted} dimColor>Plan {planProgress}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function CompactionDivider(props: { before: number; after: number }): React.JSX.Element {
  const pctBefore = Math.round(props.before / 1000);
  const pctAfter = Math.round(props.after / 1000);
  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={tokens.ansi.muted} dimColor>──────────────────────── {glyphs.compaction} context compacted · {pctBefore}% → {pctAfter}% ────────────────────────</Text>
      <Text color={tokens.ansi.muted} dimColor>  kept: task, decisions, files changed, todos, last turns verbatim</Text>
    </Box>
  );
}
