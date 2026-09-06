/**
 * 5.2 Input Box — rounded border, accent when focused
 * TUI_DESIGN.md §5.2
 */

import React from 'react';
import { Box, Text } from 'ink';
import { tokens, glyphs } from './tokens.js';

export interface InputBoxProps {
  value: string;
  placeholder?: string;
  isFocused?: boolean;
  isThinking?: boolean;
  queued?: string | null;
  mode?: 'default' | 'accept-edits' | 'plan' | 'auto';
  width?: number;
}

const placeholders = [
  'Try "add tests for src/utils/date.ts"',
  'Try "fix the failing login test"',
  'Try "explain @src/auth/verify.ts"',
];

export function InputBox(props: InputBoxProps): React.JSX.Element {
  const { value, isFocused = true, queued, mode = 'default' } = props;
  const placeholder = props.placeholder ?? placeholders[Math.floor(Date.now() / 7000) % placeholders.length] ?? placeholders[0]!;

  const borderColor = !isFocused
    ? (tokens.ansi.border as unknown as string)
    : mode === 'accept-edits'
      ? (tokens.ansi.info as unknown as string)
      : mode === 'plan'
        ? (tokens.ansi.warning as unknown as string)
        : mode === 'auto'
          ? (tokens.ansi.error as unknown as string)
          : (tokens.ansi.accent as unknown as string);

  const showQueued = queued ? (
    <Box marginBottom={1} paddingX={1}>
      <Text color={tokens.ansi.muted} dimColor>⏳ queued: "{queued.slice(0, 60)}"</Text>
    </Box>
  ) : null;

  const isMultiline = value.includes('\n');
  const displayValue = value || '';

  return (
    <Box flexDirection="column" width="100%">
      {showQueued}
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
        <Box>
          <Text color={tokens.ansi.accent}>{glyphs.prompt} </Text>
          {displayValue ? (
            <Text>{displayValue}▏</Text>
          ) : (
            <Text color={tokens.ansi.muted} dimColor>{placeholder}</Text>
          )}
        </Box>
        {isMultiline ? <Text color={tokens.ansi.muted} dimColor>  enter to send · shift+enter newline</Text> : null}
      </Box>
    </Box>
  );
}

export function ShellInputBox(props: { command: string }): React.JSX.Element {
  return (
    <Box borderStyle="round" borderColor={tokens.ansi.warning as unknown as string} paddingX={1}>
      <Text color={tokens.ansi.warning}>! {props.command}▏</Text>
    </Box>
  );
}

export function NoteInputBox(props: { text: string }): React.JSX.Element {
  return (
    <Box borderStyle="round" borderColor={tokens.ansi.accent as unknown as string} paddingX={1}>
      <Text># {props.text}▏</Text>
    </Box>
  );
}
