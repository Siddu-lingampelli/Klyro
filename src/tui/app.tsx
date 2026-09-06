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

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { StatusLine, type StatusSnapshot } from './status.js';
import { Transcript, type TranscriptItem } from './transcript.js';
import { Header } from './header.js';
import { ApprovalModal, TuiApprovalBridge } from './approval.js';
import { PlanView } from './plan.js';
import type { PlanStep } from '../agent/runtime.js';
import { parse as parseSlash, type SlashCommand } from '../cli/slash/parser.js';

export interface AppProps {
  initialModel: string;
  maxSteps: number;
  /** Working directory to display in the header. */
  cwd: string;
  /** Called when the user submits a non-slash prompt. */
  onPrompt: (text: string) => void | Promise<void>;
  /** Called when the user types a slash command. */
  onSlash: (cmd: import('../cli/slash/parser.js').SlashCommand) => void | Promise<void>;
  /** Initial state (e.g. when resuming a session). */
  initialTranscript?: TranscriptItem[];
  initialStatus?: Partial<StatusSnapshot>;
  /** Optional approval bridge — when set, the modal prompts inline. */
  approvalBridge?: TuiApprovalBridge;
  /** Called once after mount with direct hooks; also installs global compat hooks. */
  onMounted?: (hooks: {
    append: (i: TranscriptItem) => void;
    updateStatus: (s: Partial<StatusSnapshot>) => void;
    updatePlan: (p: PlanStep[]) => void;
  }) => void;
}

let _itemCounter = 0;
function nextId(prefix: string): string {
  _itemCounter += 1;
  return `${prefix}-${_itemCounter}`;
}

export function App(props: AppProps): React.JSX.Element {
  const [transcript, setTranscript] = useState<TranscriptItem[]>(props.initialTranscript ?? []);
  const [input, setInput] = useState('');
  const [bridge] = useState(() => props.approvalBridge ?? new TuiApprovalBridge());
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [planExpanded, setPlanExpanded] = useState(false);
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

  // Track bridge state to disable the input box while a prompt is up.
  useEffect(() => {
    return bridge.subscribe((p) => setAwaitingApproval(p !== null));
  }, [bridge]);

  const append = useCallback((item: TranscriptItem) => {
    setTranscript((prev) => {
      const last = prev[prev.length - 1];
      // Only coalesce when IDs match — separate turns have different IDs
      if (
        last?.kind === 'text' &&
        item.kind === 'text' &&
        last.role === 'assistant' &&
        item.role === 'assistant' &&
        last.id === item.id
      ) {
        return [...prev.slice(0, -1), { ...last, text: last.text + item.text } as TranscriptItem];
      }
      return [...prev, item];
    });
  }, []);

  const updateStatus = useCallback((s: Partial<StatusSnapshot>) => {
    setStatus((prev) => ({ ...prev, ...s }));
  }, []);

  const updatePlan = useCallback((p: PlanStep[]) => {
    setPlan(p);
    setPlanExpanded(true);
  }, []);

  // Stabilize onMounted to avoid re-installing hooks on every parent re-render
  const onMountedRef = useRef(props.onMounted);
  useEffect(() => { onMountedRef.current = props.onMounted; }, [props.onMounted]);

  useEffect(() => {
    // Instance-local hooks via callback (preferred)
    onMountedRef.current?.({ append, updateStatus, updatePlan });
    // Global compat hooks for tests / legacy callers (single instance at a time)
    (globalThis as { __klyroAppAppend?: (i: TranscriptItem) => void }).__klyroAppAppend = append;
    (globalThis as { __klyroAppStatus?: (s: Partial<StatusSnapshot>) => void }).__klyroAppStatus = updateStatus;
    (globalThis as { __klyroAppPlan?: (p: PlanStep[]) => void }).__klyroAppPlan = updatePlan;
    return () => {
      delete (globalThis as { __klyroAppAppend?: unknown }).__klyroAppAppend;
      delete (globalThis as { __klyroAppStatus?: unknown }).__klyroAppStatus;
      delete (globalThis as { __klyroAppPlan?: unknown }).__klyroAppPlan;
    };
  }, [append, updateStatus, updatePlan]);

  useInput((inputStr, key) => {
    if (status.status === 'running' || awaitingApproval) return;
    if (key.return) {
      const value = input.trim();
      setInput('');
      if (!value) return;
      append({ id: nextId('text'), kind: 'text', text: value, role: 'user' });
      const cmd: SlashCommand = parseSlash(value);
      if (cmd.kind === 'prompt') {
        void props.onPrompt(cmd.text);
      } else if (cmd.kind === 'plan') {
        // Local UI command — toggle the plan view inline.
        if (plan.length > 0) setPlanExpanded((v) => !v);
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
      <Header cwd={props.cwd} model={status.model} step={status.step} maxSteps={status.maxSteps} />
      <StatusLine snapshot={status} />
      {plan.length > 0 ? (
        <PlanView steps={plan} expanded={planExpanded} onToggle={() => setPlanExpanded((v) => !v)} />
      ) : null}
      <Transcript items={transcript} />
      {awaitingApproval ? <ApprovalModal bridge={bridge} /> : null}
      <Box borderStyle="single" borderColor={awaitingApproval ? 'yellow' : 'gray'} paddingX={1}>
        <Text color="gray">{awaitingApproval ? '! ' : '> '}</Text>
        <Text>{awaitingApproval ? '(awaiting approval — see above)' : input}</Text>
        {status.status === 'running' ? <Text color="cyan"> ▍</Text> : <Text>▍</Text>}
      </Box>
    </Box>
  );
}
