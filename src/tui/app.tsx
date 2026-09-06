/**
 * Ink app root — status line + scrollable transcript + input box.
 * 1.4: history per project, multiline, Ctrl+C double, slash registry, Windows handling
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
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

export interface AppProps {
  initialModel: string;
  maxSteps: number;
  cwd: string;
  onPrompt: (text: string) => void | Promise<void>;
  onSlash: (cmd: import('../cli/slash/parser.js').SlashCommand) => void | Promise<void>;
  initialTranscript?: TranscriptItem[];
  initialStatus?: Partial<StatusSnapshot>;
  approvalBridge?: TuiApprovalBridge;
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

function getGitBranch(cwd: string): string {
  try {
    const r = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf-8', timeout: 800, windowsHide: true });
    if (r.status === 0 && r.stdout) return r.stdout.trim().slice(0, 40);
  } catch { /* ignore */ }
  return '';
}

function getHistoryPath(): string {
  const home = os.homedir() || process.cwd();
  return path.join(home, '.klyro', 'history');
}

function loadHistory(cwd: string): string[] {
  try {
    const raw = fs.readFileSync(getHistoryPath(), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const out: string[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as { cwd?: string; text?: string };
        if (obj.cwd === cwd && typeof obj.text === 'string') out.push(obj.text);
      } catch {
        // legacy plain text per line
        if (line.trim()) out.push(line.trim());
      }
    }
    return out.slice(-200);
  } catch {
    return [];
  }
}

function appendHistory(cwd: string, text: string): void {
  try {
    const p = getHistoryPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const entry = JSON.stringify({ cwd, text, ts: Date.now() });
    fs.appendFileSync(p, entry + '\n', 'utf-8');
  } catch { /* ignore */ }
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
  const [history, setHistory] = useState<string[]>(() => loadHistory(props.cwd));
  const historyIndexRef = useRef<number>(-1);
  const lastCtrlCRef = useRef<number>(0);
  const [gitBranch, setGitBranch] = useState<string>(() => getGitBranch(props.cwd));
  const [queued, setQueued] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setGitBranch(getGitBranch(props.cwd)), 5000);
    return () => clearInterval(t);
  }, [props.cwd]);

  useEffect(() => {
    return bridge.subscribe((p) => setAwaitingApproval(p !== null));
  }, [bridge]);

  const append = useCallback((item: TranscriptItem) => {
    setTranscript((prev) => {
      const last = prev[prev.length - 1];
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

  const onMountedRef = useRef(props.onMounted);
  useEffect(() => { onMountedRef.current = props.onMounted; }, [props.onMounted]);

  useEffect(() => {
    onMountedRef.current?.({ append, updateStatus, updatePlan });
    (globalThis as { __klyroAppAppend?: (i: TranscriptItem) => void }).__klyroAppAppend = append;
    (globalThis as { __klyroAppStatus?: (s: Partial<StatusSnapshot>) => void }).__klyroAppStatus = updateStatus;
    (globalThis as { __klyroAppPlan?: (p: PlanStep[]) => void }).__klyroAppPlan = updatePlan;
    return () => {
      delete (globalThis as { __klyroAppAppend?: unknown }).__klyroAppAppend;
      delete (globalThis as { __klyroAppStatus?: unknown }).__klyroAppStatus;
      delete (globalThis as { __klyroAppPlan?: unknown }).__klyroAppPlan;
    };
  }, [append, updateStatus, updatePlan]);

  // Handle Windows raw-mode fallback warning
  const [rawModeWarning, setRawModeWarning] = useState<string | null>(null);
  useEffect(() => {
    try {
      const stdin = process.stdin as unknown as { isTTY?: boolean; setRawMode?: (b: boolean) => void };
      if (stdin.isTTY && typeof stdin.setRawMode !== 'function') {
        setRawModeWarning('Raw mode not available (mintty) — input may be limited');
      }
    } catch { /* ignore */ }
  }, []);

  // Queue next message if typed during stream (2.4)
  useEffect(() => {
    if (queued && status.status !== 'running' && !awaitingApproval) {
      const toSend = queued;
      setQueued(null);
      const trimmed = toSend.trim();
      if (!trimmed) return;
      append({ id: nextId('text'), kind: 'text', text: toSend, role: 'user' });
      const cmd = parseSlash(trimmed);
      if (cmd.kind === 'prompt') void props.onPrompt(cmd.text);
      else if (cmd.kind === 'plan') {
        if (plan.length > 0) setPlanExpanded((v) => !v);
      } else void props.onSlash(cmd);
    }
  }, [queued, status.status, awaitingApproval, plan.length, append]);

  useInput((inputStr, key) => {
    if (awaitingApproval) return;
    if (status.status === 'running') {
      if (key.ctrl && inputStr === 'c') {
        void props.onSlash({ kind: 'quit' });
        return;
      }
      if (key.return) {
        const value = input.trim();
        if (!value) return;
        setQueued(value);
        setInput('');
        append({ id: nextId('text'), kind: 'text', text: `queued: ${value.slice(0, 80)}`, role: 'assistant' });
        return;
      }
      if (!key.ctrl && !key.meta) {
        // Show typing indicator but don't change input (queued mode)
        return;
      }
      return;
    }

    // History navigation
    if (key.upArrow) {
      if (history.length === 0) return;
      if (historyIndexRef.current === -1) historyIndexRef.current = history.length - 1;
      else if (historyIndexRef.current > 0) historyIndexRef.current--;
      setInput(history[historyIndexRef.current] ?? '');
      return;
    }
    if (key.downArrow) {
      if (historyIndexRef.current === -1) return;
      historyIndexRef.current++;
      if (historyIndexRef.current >= history.length) {
        historyIndexRef.current = -1;
        setInput('');
      } else {
        setInput(history[historyIndexRef.current] ?? '');
      }
      return;
    }
    // Ctrl+R search — simple: cycle history
    if (key.ctrl && inputStr === 'r') {
      if (history.length === 0) return;
      const term = input.toLowerCase();
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]!.toLowerCase().includes(term)) {
          setInput(history[i]!);
          return;
        }
      }
      return;
    }
    if (key.return) {
      // Multiline: trailing \ or Shift+Enter (where supported, key.shift is true)
      // Ink's key object has `shift` for Shift+Enter on some terminals
      const isShiftEnter = (key as unknown as { shift?: boolean }).shift === true;
      if (isShiftEnter || input.endsWith('\\')) {
        // Replace trailing \ with newline, or just add newline for Shift+Enter
        if (input.endsWith('\\')) setInput((v) => v.slice(0, -1) + '\n');
        else setInput((v) => v + '\n');
        return;
      }
      const value = input;
      // Preserve newlines for bracketed paste — don't trim inner newlines, only outer
      const trimmedOuter = value.replace(/^\s+|\s+$/g, '');
      if (!trimmedOuter) {
        setInput('');
        return;
      }
      // Check for Ctrl+C double at empty prompt handled below, but here handle submit
      setInput('');
      historyIndexRef.current = -1;
      // Save to history
      setHistory((prev) => {
        const next = [...prev, value];
        appendHistory(props.cwd, value);
        return next.slice(-200);
      });
      append({ id: nextId('text'), kind: 'text', text: value, role: 'user' });
      const cmd = parseSlash(trimmedOuter);
      if (cmd.kind === 'prompt') {
        void props.onPrompt(cmd.text);
      } else if (cmd.kind === 'plan') {
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
    // Ctrl+C double at empty prompt exits
    if (key.ctrl && inputStr === 'c') {
      if (input === '') {
        const now = Date.now();
        if (now - lastCtrlCRef.current < 1500) {
          void props.onSlash({ kind: 'quit' });
          return;
        }
        lastCtrlCRef.current = now;
        append({ id: nextId('text'), kind: 'text', text: '(press Ctrl+C again to exit)', role: 'assistant' });
        return;
      }
      // Single Ctrl+C cancels input
      setInput('');
      return;
    }
    if (key.ctrl && inputStr === 'd') {
      void props.onSlash({ kind: 'quit' });
      return;
    }
    if (key.ctrl && inputStr === 'l') {
      // Clear — keep session but clear transcript marker
      append({ id: nextId('text'), kind: 'text', text: '(cleared)', role: 'assistant' });
      return;
    }
    // Handle bracketed paste: inputStr may contain \r\n or multiple lines
    if (!key.ctrl && !key.meta) {
      // Preserve all characters including newlines from paste
      // Normalize \r\n to \n
      const normalized = inputStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      setInput((v) => v + normalized);
    }
  });

  const promptStr = `klyro › ${path.basename(props.cwd)}${gitBranch ? ` (${gitBranch})` : ''}`;

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Header cwd={props.cwd} model={status.model} step={status.step} maxSteps={status.maxSteps} />
      {rawModeWarning ? <Box><Text color="yellow">{rawModeWarning}</Text></Box> : null}
      <StatusLine snapshot={status} />
      {plan.length > 0 ? (
        <PlanView steps={plan} expanded={planExpanded} onToggle={() => setPlanExpanded((v) => !v)} />
      ) : null}
      <Transcript items={transcript} />
      {awaitingApproval ? <ApprovalModal bridge={bridge} /> : null}
      <Box borderStyle="single" borderColor={awaitingApproval ? 'yellow' : 'gray'} paddingX={1}>
        <Text color="gray">{awaitingApproval ? '! ' : `${promptStr} `}</Text>
        <Text>{awaitingApproval ? '(awaiting approval — see above)' : input}</Text>
        {status.status === 'running' ? <Text color="cyan"> ▍</Text> : <Text>▍</Text>}
      </Box>
      <Box paddingX={1}><Text dimColor>Tab: slash completion · Shift+Enter: newline · Ctrl+C twice: exit · Ctrl+R: history</Text></Box>
    </Box>
  );
}
