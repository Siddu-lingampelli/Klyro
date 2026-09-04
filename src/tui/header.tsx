/**
 * Header — top-of-screen chrome: app name, cwd, model, step counter.
 *
 * Renders a single line with two padded cells separated by a vertical bar.
 * Pure presentational; takes all data as props.
 */
import React from 'react';
import { Box, Text } from 'ink';

export interface HeaderProps {
  /** Working directory, displayed abbreviated (last 2 path segments) if long. */
  cwd: string;
  /** Model id, e.g. "claude-sonnet" or "gpt-4o". */
  model: string;
  /** Current step number (0 when not started). */
  step: number;
  /** Max steps for this run (used to render "step / max"). */
  maxSteps: number;
}

/** Abbreviate a path to the last two segments so long paths don't overflow. */
export function abbrevPath(p: string, maxChars = 60): string {
  if (p.length <= maxChars) return p;
  // Detect the original separator style and rejoin with it.
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return '…' + sep + parts.slice(-2).join(sep);
}

export function Header({ cwd, model, step, maxSteps }: HeaderProps): React.JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      flexDirection="row"
      justifyContent="space-between"
    >
      <Box>
        <Text color="cyan" bold>KLYRO</Text>
        <Text color="gray">  </Text>
        <Text color="gray">{abbrevPath(cwd)}</Text>
      </Box>
      <Box>
        <Text color="gray">{model}</Text>
        <Text color="gray">  </Text>
        <Text color={step >= maxSteps ? 'red' : 'gray'}>
          step {step}/{maxSteps}
        </Text>
      </Box>
    </Box>
  );
}
