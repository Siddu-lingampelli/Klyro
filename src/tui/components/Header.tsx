import React from 'react';
import { Box, Text } from 'ink';

export function Header(props: { version: string; model: string; provider?: string; cwd: string }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box>
        <Text bold>KLYRO</Text>
        <Text color="gray"> v{props.version}</Text>
      </Box>
      <Box>
        <Text color="gray">{props.model}</Text>
        {props.provider ? <Text color="gray"> · {props.provider}</Text> : null}
        <Text color="gray"> · {props.cwd}</Text>
      </Box>
    </Box>
  );
}
