/**
 * Klyro Full-Screen TUI — TUI_DESIGN.md §2, §24, §38 (Phase 1-4)
 * Full viewport, conversation, input, status bar — professional, dense, terminal-native
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput, useStdout, useStdin } from 'ink';
import { Header } from './components/Header.js';
import { StatusLine, type StatusSnapshot } from './status.js';
import { Transcript, type TranscriptItem } from './transcript.js';
import { ApprovalModal, TuiApprovalBridge } from './approval.js';
import { PlanView } from './plan.js';
import type { PlanStep } from '../agent/runtime.js';
import { parse as parseSlash } from '../cli/slash/parser.js';
import { tokens } from './tokens.js';

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

let _id = 0;
function nextId(p: string): string { _id++; return `${p}-${_id}`; }

export function App(props: AppProps): React.JSX.Element {
  const { stdout } = useStdout();
  const [transcript, setTranscript] = useState<TranscriptItem[]>(props.initialTranscript ?? []);
  const [input, setInput] = useState('');
  const [bridge] = useState(() => props.approvalBridge ?? new TuiApprovalBridge());
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [plan, setPlan] = useState<PlanStep[]>([]);
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
  const [elapsed, setElapsed] = useState(0);
  const [queued, setQueued] = useState<string | null>(null);

  useEffect(() => bridge.subscribe((p) => setAwaitingApproval(p !== null)), [bridge]);

  // 2.4 — send queued when idle
  useEffect(() => {
    if (queued && status.status !== 'running' && !awaitingApproval) {
      const toSend = queued;
      setQueued(null);
      const item: TranscriptItem = { id: nextId('text'), kind: 'text', text: toSend, role: 'user' };
      setTranscript((prev) => [...prev, item]);
      const cmd = parseSlash(toSend.trim());
      if (cmd.kind === 'prompt') void props.onPrompt(cmd.text);
      else void props.onSlash(cmd);
    }
  }, [queued, status.status, awaitingApproval]);
  useEffect(() => {
    if (status.status !== 'running') return;
    const start = Date.now() - elapsed;
    const t = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(t);
  }, [status.status, elapsed]);

  const append = useCallback((item: TranscriptItem) => {
    setTranscript((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === 'text' && item.kind === 'text' && last.role === 'assistant' && item.role === 'assistant' && last.id === item.id) {
        return [...prev.slice(0, -1), { ...last, text: last.text + item.text } as TranscriptItem];
      }
      return [...prev, item];
    });
  }, []);

  const updateStatus = useCallback((s: Partial<StatusSnapshot>) => setStatus((p) => ({ ...p, ...s })), []);
  const updatePlan = useCallback((p: PlanStep[]) => setPlan(p), []);

  const onMountedRef = useRef(props.onMounted);
  useEffect(() => { onMountedRef.current = props.onMounted; }, [props.onMounted]);
  useEffect(() => {
    onMountedRef.current?.({ append, updateStatus, updatePlan });
    (globalThis as unknown as { __klyroAppAppend?: unknown }).__klyroAppAppend = append;
    (globalThis as unknown as { __klyroAppStatus?: unknown }).__klyroAppStatus = updateStatus;
    (globalThis as unknown as { __klyroAppPlan?: unknown }).__klyroAppPlan = updatePlan;
    return () => {
      delete (globalThis as unknown as { __klyroAppAppend?: unknown }).__klyroAppAppend;
      delete (globalThis as unknown as { __klyroAppStatus?: unknown }).__klyroAppStatus;
      delete (globalThis as unknown as { __klyroAppPlan?: unknown }).__klyroAppPlan;
    };
  }, [append, updateStatus, updatePlan]);

  // Single useInput owner — handles queued when running (2.4)
  useInput((inputStr, key) => {
    if (awaitingApproval) return;
    if (status.status === 'running') {
      if (key.ctrl && inputStr === 'c') { void props.onSlash({ kind: 'quit' }); return; }
      if (key.return) {
        const v = input.trim();
        if (!v) return;
        setQueued(v);
        setInput('');
        setTranscript((prev) => [...prev, { id: nextId('text'), kind: 'text', text: `queued: ${v.slice(0, 80)}`, role: 'assistant' } as TranscriptItem]);
        return;
      }
      if (key.backspace || key.delete) { setInput((v) => v.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta) {
        const norm = inputStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        setInput((v) => v + norm);
      }
      return;
    }
    if (key.return) {
      const v = input.trim();
      if (!v) return;
      setInput('');
      const item: TranscriptItem = { id: nextId('text'), kind: 'text', text: v, role: 'user' };
      setTranscript((prev) => [...prev, item]);
      const cmd = parseSlash(v);
      if (cmd.kind === 'prompt') void props.onPrompt(cmd.text);
      else void props.onSlash(cmd);
      return;
    }
    if (key.backspace || key.delete) { setInput((v) => v.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta) setInput((v) => v + inputStr);
  });

  const width = stdout?.columns ?? 100;
  const height = stdout?.rows ?? 30;
  const isSmall = width < 80;

  return (
    <Box flexDirection="column" width={width} height={height - 1}>
      {/* Header — compact, per §3 — shows version, model, cwd, step, status */}
      <Box flexDirection="column" borderStyle="single" borderColor={tokens.ansi.border as unknown as string} paddingX={1}>
        <Text bold>KLYRO v0.1.13</Text>
        <Text color={tokens.ansi.muted as unknown as string}>{status.model} · API Usage Billing · step {status.step}/{status.maxSteps} · {status.status} · repairs {status.repairs}</Text>
        <Text color={tokens.ansi.muted as unknown as string}>{props.cwd}</Text>
      </Box>

      {/* Conversation — scrollable, per §4 */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1} paddingY={1}>
        {transcript.length === 0 ? (
          <Box flexDirection="column">
            <Text color={tokens.ansi.muted as unknown as string}>No conversation yet. Try "fix the failing login test"</Text>
          </Box>
        ) : (
          transcript.map((item) => (
            <Box key={item.id} flexDirection="column" marginBottom={1}>
              {item.kind === 'text' && item.role === 'user' ? (
                <Text>› {item.text}</Text>
              ) : item.kind === 'text' ? (
                <Text>  {item.text}</Text>
              ) : item.kind === 'tool' ? (
                <Box flexDirection="column" borderStyle="round" borderColor={tokens.ansi.border as unknown as string} paddingX={1}>
                  <Text>{item.name} {item.isError ? '✗' : '✓'} {item.latencyMs ?? 0}ms</Text>
                  {item.result ? <Text color={tokens.ansi.muted as unknown as string}>{String(item.result).slice(0, 200)}</Text> : null}
                </Box>
              ) : item.kind === 'diff' ? (
                <Box flexDirection="column" borderStyle="round" borderColor={tokens.ansi.border as unknown as string} paddingX={1}>
                  <Text bold>{item.summary ?? 'Diff'}</Text>
                  {item.hunks.map((h, i) => (
                    <Box key={i} flexDirection="column" marginTop={1}>
                      <Text color={tokens.ansi.info as unknown as string}>{h.path}</Text>
                      {h.lines.map((l, j) => (
                        <Text key={j} color={l.kind === 'add' ? (tokens.ansi.success as unknown as string) : l.kind === 'remove' ? (tokens.ansi.error as unknown as string) : (tokens.ansi.muted as unknown as string)}>
                          {l.kind === 'add' ? '+ ' : l.kind === 'remove' ? '- ' : '  '}{l.text}
                        </Text>
                      ))}
                    </Box>
                  ))}
                </Box>
              ) : (
                <Transcript items={[item]} />
              )}
            </Box>
          ))
        )}
        {status.status === 'running' ? (
          <Box>
            <Text color={tokens.ansi.info as unknown as string}>✦ Thinking...</Text>
            <Text color={tokens.ansi.muted as unknown as string}> · {Math.round(elapsed / 1000)}s</Text>
          </Box>
        ) : null}
        {plan.length > 0 ? <PlanView steps={plan} expanded={false} onToggle={() => {}} /> : null}
      </Box>

      {/* Input — always at bottom, per §15 */}
      <Box borderStyle="single" borderColor={tokens.ansi.accent as unknown as string} paddingX={1}>
        <Text>› </Text>
        <Text>{input}▏</Text>
      </Box>

      {/* Status Bar — per §17 */}
      <Box justifyContent="space-between" paddingX={1} borderStyle="single" borderColor={tokens.ansi.border as unknown as string}>
        <Text color={tokens.ansi.muted as unknown as string}>
          {status.model} · {status.usageInput + status.usageOutput} tokens · ${(status.usageInput / 1000 * 0.003 + status.usageOutput / 1000 * 0.015).toFixed(2)} · {Math.round(elapsed / 1000)}s
        </Text>
        <Text color={tokens.ansi.muted as unknown as string}>{isSmall ? 'Ctrl+C interrupt' : 'Ctrl+C interrupt · Ctrl+O expand · ↑↓ scroll'}</Text>
      </Box>
    </Box>
  );
}
