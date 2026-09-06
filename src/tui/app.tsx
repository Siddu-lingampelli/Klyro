/**
 * Ink app root — status line + scrollable transcript + input box.
 *
 * Owns the session state machine:
 *   - transcript: array of TranscriptItem (rendered by <Transcript/>)
 *   - status: snapshot for the <StatusLine/>
 *   - input: the current input-box buffer
 *
 * The actual agent loop runs externally; the app just listens for
 * RuntimeEvents via the onEvent callback wired by cli/repl.ts and
 * translates them into transcript/status updates.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { StatusLine, type StatusSnapshot } from './status.js';
import { Transcript, type TranscriptItem } from './transcript.js';
import { parse as parseSlash, type SlashCommand } from '../cli/slash/parser.js';

export interface AppProps {
  initialModel: string;
  maxSteps: number;
  /** Called when the user submits a non-slash prompt. */
  onPrompt: (text: string) => void | Promise<void>;
  /** Called when the user types a slash command. */
  onSlash: (cmd: import('../cli/slash/parser.js').SlashCommand) => void | Promise<void>;
  /** Initial state (e.g. when resuming a session). */
  initialTranscript?: TranscriptItem[];
  initialStatus?: Partial<StatusSnapshot>;
}

let _itemCounter = 0;
function nextId(prefix: string): string {
  _itemCounter += 1;
  return `${prefix}-${_itemCounter}`;
}

export function App(props: AppProps): React.JSX.Element {
  const [transcript, setTranscript] = useState<TranscriptItem[]>(props.initialTranscript ?? []);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<StatusSnapshot>({
    model: props.initialModel,
    step: 0,
    maxSteps: props.maxSteps,
    usageInput: 0,
    usageOutput: 0,
    repairs: 0,
    status: 'idle',
    ...props.initialStatus,
  });

  const append = useCallback((item: TranscriptItem) => {
    setTranscript((prev) => [...prev, item]);
  }, []);

  useEffect(() => {
    (globalThis as { __klyroAppAppend?: (i: TranscriptItem) => void }).__klyroAppAppend = append;
    (globalThis as { __klyroAppStatus?: (s: Partial<StatusSnapshot>) => void }).__klyroAppStatus = (s) => setStatus((prev) => ({ ...prev, ...s }));
    return () => {
      delete (globalThis as { __klyroAppAppend?: unknown }).__klyroAppAppend;
      delete (globalThis as { __klyroAppStatus?: unknown }).__klyroAppStatus;
    };
  }, [append]);

  useInput((inputStr, key) => {
    if (status.status === 'running') return;
    if (key.return) {
      const value = input.trim();
      setInput('');
      if (!value) return;
      append({ id: nextId('text'), kind: 'text', text: value, role: 'user' });
      const cmd: SlashCommand = parseSlash(value);
      if (cmd.kind === 'prompt') {
        void props.onPrompt(cmd.text);
      } else {
        void props.onSlash(cmd);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (key.ctrl && inputStr === 'c') {
      void props.onSlash({ kind: 'quit' });
      return;
    }
    if (!key.ctrl && !key.meta) {
      setInput((v) => v + inputStr);
    }
  });

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <StatusLine snapshot={status} />
      <Transcript items={transcript} />
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="gray">{'> '}</Text>
        <Text>{input}</Text>
        {status.status === 'running' ? <Text color="cyan"> ▍</Text> : <Text>▍</Text>}
      </Box>
    </Box>
  );
}
