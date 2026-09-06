/**
 * Transcript — a scrollable list of transcript entries.
 *
 * Each entry is a typed TranscriptItem (text delta, tool call block,
 * tool result, policy decision, error). The component takes a flat list
 * and renders it. Tool call blocks are collapsible via a `collapsed` flag.
 *
 * State management: parent owns the list, passes a fresh array on every
 * update. This component is pure presentational.
 */

import React from 'react';
import { Text, Box } from 'ink';

export type TranscriptItem =
  | { id: string; kind: 'text'; text: string; role: 'user' | 'assistant' }
  | { id: string; kind: 'tool'; name: string; id_call: string; args: string; result?: string; isError?: boolean; latencyMs?: number; collapsed?: boolean }
  | { id: string; kind: 'policy'; name: string; action: 'allow' | 'ask' | 'deny'; reason?: string }
  | { id: string; kind: 'error'; message: string };

export function Transcript({ items }: { items: TranscriptItem[] }): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {items.length === 0 ? (
        <Text color="gray" dimColor>Type a prompt or /help for commands.</Text>
      ) : items.map((item) => (
        <TranscriptRow key={item.id} item={item} />
      ))}
    </Box>
  );
}

function TranscriptRow({ item }: { item: TranscriptItem }): React.JSX.Element | null {
  if (item.kind === 'text') {
    const color = item.role === 'user' ? 'blue' : undefined;
    return (
      <Box marginY={0}>
        <Text color={color as 'blue' | undefined}>
          {item.role === 'user' ? '> ' : ''}
          {item.text}
        </Text>
      </Box>
    );
  }
  if (item.kind === 'tool') {
    const headerColor = item.isError ? 'red' : 'yellow';
    return (
      <Box flexDirection="column" marginY={0} paddingLeft={2}>
        <Text>
          <Text color={headerColor as 'red' | 'yellow'}>[tool] {item.name}</Text>
          {item.latencyMs !== undefined ? (
            <Text color="gray">  ({item.latencyMs}ms)</Text>
          ) : null}
        </Text>
        {item.collapsed ? (
          <Text color="gray" dimColor>  (collapsed — {item.args.length} chars of args, {item.result?.length ?? 0} chars of result)</Text>
        ) : (
          <>
            <Text color="gray">  args: {truncate(item.args, 200)}</Text>
            {item.result !== undefined ? (
              <Text color={item.isError ? 'red' : 'gray'}>  -&gt; {truncate(item.result, 400)}</Text>
            ) : null}
          </>
        )}
      </Box>
    );
  }
  if (item.kind === 'policy') {
    const color = item.action === 'allow' ? 'green' : item.action === 'deny' ? 'red' : 'yellow';
    return (
      <Box paddingLeft={2}>
        <Text color="gray">[policy] </Text>
        <Text color={color as 'green' | 'red' | 'yellow'}>{item.action}</Text>
        <Text color="gray"> {item.name}</Text>
        {item.reason ? <Text color="gray"> — {item.reason}</Text> : null}
      </Box>
    );
  }
  if (item.kind === 'error') {
    return (
      <Box paddingLeft={2}>
        <Text color="red">[error] {item.message}</Text>
      </Box>
    );
  }
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
