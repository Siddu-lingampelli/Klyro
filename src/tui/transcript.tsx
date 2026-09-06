/**
 * Transcript — a scrollable list of transcript entries.
 *
 * Each entry is a typed TranscriptItem (text delta, tool call block,
 * tool result, policy decision, error, file changed). The component
 * takes a flat list and renders it. Tool blocks use a card layout
 * (┌─ name ─┐) and show a spinner while running.
 *
 * State management: parent owns the list, passes a fresh array on every
 * update. This component is pure presentational.
 */

import React from 'react';
import { Text, Box } from 'ink';
import Spinner from 'ink-spinner';
import { DiffView, type DiffHunk } from './diff.js';

/** Patch applied to a running tool item when its result arrives. */
export interface ToolResultPatch {
  result: string;
  isError: boolean;
  latencyMs: number;
  status: 'done' | 'error';
}

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

/** Build a one-line summary of a tool call from its args JSON. */
function summarizeTool(name: string, args: string): string {
  if (!args || args === '{}') return '';
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(args) as Record<string, unknown>; } catch { return args.slice(0, 80); }
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return typeof parsed.path === 'string' ? parsed.path : '';
    case 'shell_exec':
      return typeof parsed.command === 'string' ? parsed.command : '';
    case 'search_files':
    case 'grep': {
      const q = parsed.query ?? parsed.pattern;
      return typeof q === 'string' ? `"${q}"` : '';
    }
    case 'list_directory':
      return typeof parsed.path === 'string' ? parsed.path : '';
    case 'git_status':
    case 'git_diff':
      return '';
    default:
      return '';
  }
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
    return <ToolCard item={item} />;
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
  if (item.kind === 'file_changed') {
    const color = item.op === 'deleted' ? 'red' : item.op === 'created' ? 'green' : 'yellow';
    const glyph = item.op === 'created' ? '+' : item.op === 'deleted' ? '-' : '~';
    return (
      <Box paddingLeft={2}>
        <Text color={color as 'green' | 'red' | 'yellow'}>
          [{glyph} {item.op}] {item.path}
        </Text>
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
  if (item.kind === 'diff') {
    return <DiffView hunks={item.hunks} summary={item.summary} />;
  }
  return null;
}

function ToolCard({ item }: { item: Extract<TranscriptItem, { kind: 'tool' }> }): React.JSX.Element {
  const summary = summarizeTool(item.name, item.args);
  const borderColor =
    item.status === 'error' ? 'red' : item.status === 'running' ? 'cyan' : 'gray';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor as 'red' | 'cyan' | 'gray'}
      marginY={1}
      paddingX={1}
    >
      <Box>
        <Text color="gray">┌─ </Text>
        <Text bold>{item.name}</Text>
        {item.status === 'running' ? (
          <Text color="cyan">  <Spinner type="dots" /> running</Text>
        ) : item.status === 'error' ? (
          <Text color="red">  ✗ error</Text>
        ) : (
          <Text color="green">  ✓ {item.latencyMs ?? 0}ms</Text>
        )}
        <Text color="gray"> ─────────────────────────────────────</Text>
      </Box>
      {summary ? (
        <Box paddingLeft={2}>
          <Text>{truncate(summary, 200)}</Text>
        </Box>
      ) : null}
      {item.status !== 'running' && item.result ? (
        <Box paddingLeft={2} flexDirection="column">
          <Text color={item.isError ? 'red' : 'gray'}>
            {item.isError ? '✗ ' : '→ '}{truncate(item.result, 400)}
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text color="gray">└──────────────────────────────────────────</Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
