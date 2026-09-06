/**
 * 5.1 Banner — session start / resume
 * TUI_DESIGN.md §5.1
 */

import React from 'react';
import { Box, Text } from 'ink';
import { tokens, glyphs } from './tokens.js';
import { abbrevPath } from './header.js';

export interface BannerProps {
  version: string;
  cwd: string;
  branch?: string;
  dirtyCount?: number;
  model: string;
  klyroMdLoaded?: boolean;
  packageManager?: string;
  testRunner?: string;
  packageCount?: number;
  isResume?: boolean;
  resumeInfo?: {
    task: string;
    lastActive: string;
    turns: number;
    cost: string;
    branch: string;
    planProgress?: string;
    interrupted?: string;
    staleness?: string;
  };
}

export function Banner(props: BannerProps): React.JSX.Element {
  if (props.isResume && props.resumeInfo) {
    const r = props.resumeInfo;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={tokens.ansi.warning as unknown as string} paddingX={1} marginBottom={1}>
        <Text color={tokens.ansi.warning} bold>{glyphs.repair} Resuming</Text>
        <Text>  {r.task}</Text>
        <Text color={tokens.ansi.muted} dimColor>  last active {r.lastActive} · {r.turns} turns · {r.cost} · {r.branch}</Text>
        {r.planProgress ? <Text color={tokens.ansi.muted} dimColor>  Plan {r.planProgress}</Text> : null}
        {r.interrupted ? <Text color={tokens.ansi.warning}>  ⚠ Last tool call was interrupted ({r.interrupted}) — not applied.</Text> : null}
        {r.staleness ? <Text color={tokens.ansi.warning}>  ⚠ Changed since: {r.staleness} (will re-read before editing)</Text> : null}
        <Text>Continue? (Y/n) ▏</Text>
      </Box>
    );
  }

  const dirty = props.dirtyCount ? ` ✎${props.dirtyCount}` : '';
  const branchPart = props.branch ? ` (${props.branch}${dirty})` : '';
  const klyroPart = props.klyroMdLoaded ? 'KLYRO.md loaded' : 'No KLYRO.md — run /init';
  const toolsPart = [props.packageManager, props.testRunner].filter(Boolean).join(' · ');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tokens.ansi.accent as unknown as string} paddingX={1} marginBottom={1}>
      <Text color={tokens.ansi.accent} bold>{glyphs.brand} Klyro v{props.version}</Text>
      <Text color={tokens.ansi.muted} dimColor>  {abbrevPath(props.cwd)}{branchPart}  ·  {props.model} {toolsPart ? `·  ${toolsPart}` : ''} {props.packageCount ? `·  ${props.packageCount} packages` : ''}</Text>
      <Text color={tokens.ansi.muted} dimColor>  {klyroPart}  ·  /help for commands · /status for setup</Text>
      <Text color={tokens.ansi.muted} dimColor>  Tip: use @ to mention files, ! to run a shell command, /plan to plan first</Text>
    </Box>
  );
}
