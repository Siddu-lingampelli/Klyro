/**
 * 5.5 Thinking Block — collapsed by default
 * TUI_DESIGN.md §5.5
 */

import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { tokens } from './tokens.js';

export interface ThinkingBlockProps {
  text: string;
  elapsedMs: number;
  isExpanded?: boolean;
  onToggle?: () => void;
}

export function ThinkingBlock(props: ThinkingBlockProps): React.JSX.Element | null {
  if (!props.text) return null;

  if (!props.isExpanded) {
    return (
      <Box paddingX={1}>
        <Text color={tokens.ansi.muted} dimColor>∴ Thinking… ({Math.round(props.elapsedMs / 1000)}s)</Text>
        <Text color={tokens.ansi.muted} dimColor>                                             ctrl+t to show</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={tokens.ansi.muted as unknown as string}>
      <Text color={tokens.ansi.muted} dimColor>∴ Thinking ({Math.round(props.elapsedMs / 1000)}s)</Text>
      <Box flexDirection="column" paddingLeft={1} borderStyle="single" borderColor={tokens.ansi.muted as unknown as string}>
        <Text color={tokens.ansi.muted} dimColor>{props.text}</Text>
      </Box>
    </Box>
  );
}
