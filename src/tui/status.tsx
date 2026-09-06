/**
 * Status line — model name, step counter, usage, repair counter.
 *
 * Pure presentation: takes a snapshot of session state, renders a single
 * Ink <Box> with the relevant fields. State changes are pushed from
 * app.tsx via React props.
 */

import React from 'react';
import { Text, Box } from 'ink';

export interface StatusSnapshot {
  model: string;
  step: number;
  maxSteps: number;
  usageInput: number;
  usageOutput: number;
  repairs: number;
  status: 'idle' | 'running' | 'done' | 'error' | 'aborted';
  errorMessage?: string;
}

export function StatusLine({ snapshot }: { snapshot: StatusSnapshot }): React.JSX.Element {
  const { model, step, maxSteps, usageInput, usageOutput, repairs, status } = snapshot;
  const statusColor =
    status === 'running' ? 'cyan' :
    status === 'done' ? 'green' :
    status === 'error' ? 'red' :
    status === 'aborted' ? 'yellow' :
    'gray';
  const usageKbIn = (usageInput / 1024).toFixed(1);
  const usageKbOut = (usageOutput / 1024).toFixed(1);
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text>
        <Text color="gray">model </Text>
        <Text bold>{model}</Text>
        <Text color="gray">  step </Text>
        <Text bold>{step}</Text>
        <Text color="gray">/{maxSteps}</Text>
        <Text color="gray">  repairs </Text>
        <Text bold>{repairs}</Text>
      </Text>
      <Text>
        <Text color="gray">tokens </Text>
        <Text color="cyan">{usageKbIn}K</Text>
        <Text color="gray"> in / </Text>
        <Text color="cyan">{usageKbOut}K</Text>
        <Text color="gray"> out</Text>
      </Text>
      <Text>
        <Text color={statusColor as 'cyan' | 'green' | 'red' | 'yellow' | 'gray'}>● {status}</Text>
      </Text>
    </Box>
  );
}
