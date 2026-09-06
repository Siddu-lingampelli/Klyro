/**
 * Klyro TUI v2 — inline/scrollback architecture per TUI_DESIGN.md §1, §10-11
 * Four disciplines:
 * 1. History in <Static> — never re-rendered
 * 2. Only live region is dynamic
 * 3. Stream deltas batched at ~30fps
 * 4. Exactly one useInput owner
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, Static, useInput, useStdout } from 'ink';
import { Banner } from './banner.js';
import { InputBox } from './input-box.js';
import { ActivityLine } from './activity-line.js';
import { ThinkingBlock } from './thinking-block.js';
import { StatusLine, type StatusSnapshot } from './status.js';
import { Transcript, type TranscriptItem } from './transcript.js';
import { ApprovalModal, TuiApprovalBridge } from './approval.js';
import { PlanView } from './plan.js';
import type { PlanStep } from '../agent/runtime.js';
import { parse as parseSlash } from '../cli/slash/parser.js';
import { tokens, glyphs } from './tokens.js';
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

let _id = 0;
function nextId(p: string): string { _id++; return `${p}-${_id}`; }

function getBranch(cwd: string): string {
  try {
    const r = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf-8', timeout: 800, windowsHide: true });
    if (r.status === 0 && r.stdout) return r.stdout.trim().slice(0, 40);
  } catch {}
  return '';
}

function getHistoryPath(): string {
  return path.join(os.homedir() || process.cwd(), '.klyro', 'history');
}

export function App(props: AppProps): React.JSX.Element {
  // Scrollback — committed once to <Static>, never re-rendered (discipline 1)
  const [staticItems, setStaticItems] = useState<TranscriptItem[]>(props.initialTranscript ?? []);
  // Live region — only current turn's streaming text / active tool / activity
  const [liveText, setLiveText] = useState<string>('');
  const [liveThinking, setLiveThinking] = useState<string>('');
  const [isThinkingExpanded, setThinkingExpanded] = useState(false);
  const [activity, setActivity] = useState<{ verb: string; start: number } | null>(null);
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
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = fs.readFileSync(getHistoryPath(), 'utf-8');
      return raw.split('\n').filter(Boolean).slice(-200).map((l) => {
        try { const o = JSON.parse(l) as { cwd?: string; text?: string }; return o.cwd === props.cwd ? o.text ?? '' : ''; } catch { return l; }
      }).filter(Boolean);
    } catch { return []; }
  });
  const histIdx = useRef(-1);
  const lastCtrlC = useRef(0);
  const [queued, setQueued] = useState<string | null>(null);
  const [gitBranch, setGitBranch] = useState(() => getBranch(props.cwd));
  const batchRef = useRef<string>('');
  const batchTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const t = setInterval(() => setGitBranch(getBranch(props.cwd)), 5000);
    return () => clearInterval(t);
  }, [props.cwd]);

  useEffect(() => bridge.subscribe((p) => setAwaitingApproval(p !== null)), [bridge]);

  // Batched delta handler — 30fps (discipline 3)
  const flushBatch = useCallback(() => {
    if (batchRef.current) {
      const chunk = batchRef.current;
      batchRef.current = '';
      setLiveText((prev) => prev + chunk);
    }
    if (batchTimer.current) {
      clearTimeout(batchTimer.current);
      batchTimer.current = null;
    }
  }, []);

  const appendDeltaBatched = useCallback((text: string) => {
    batchRef.current += text;
    if (!batchTimer.current) {
      batchTimer.current = setTimeout(flushBatch, 33); // ~30fps
    }
  }, [flushBatch]);

  // Commit live region to scrollback atomically (discipline 1)
  const commitLive = useCallback(() => {
    flushBatch();
    if (liveText) {
      const item: TranscriptItem = { id: nextId('text'), kind: 'text', text: liveText, role: 'assistant' };
      setStaticItems((prev) => [...prev, item]);
      setLiveText('');
    }
    if (liveThinking) {
      // Thinking is not committed unless expanded — spec says collapsed by default
      setLiveThinking('');
    }
    setActivity(null);
  }, [liveText, liveThinking, flushBatch]);

  const appendStatic = useCallback((item: TranscriptItem) => {
    // If live text is pending, commit first
    if (liveText) commitLive();
    setStaticItems((prev) => [...prev, item]);
  }, [liveText, commitLive]);

  const updateStatus = useCallback((s: Partial<StatusSnapshot>) => setStatus((p) => ({ ...p, ...s })), []);
  const updatePlan = useCallback((p: PlanStep[]) => { setPlan(p); setPlanExpanded(true); }, []);

  const onMountedRef = useRef(props.onMounted);
  useEffect(() => { onMountedRef.current = props.onMounted; }, [props.onMounted]);
  useEffect(() => {
    onMountedRef.current?.({ append: appendStatic, updateStatus, updatePlan });
    (globalThis as unknown as { __klyroAppAppend?: unknown }).__klyroAppAppend = appendStatic;
    (globalThis as unknown as { __klyroAppStatus?: unknown }).__klyroAppStatus = updateStatus;
    (globalThis as unknown as { __klyroAppPlan?: unknown }).__klyroAppPlan = updatePlan;
    return () => {
      delete (globalThis as unknown as { __klyroAppAppend?: unknown }).__klyroAppAppend;
      delete (globalThis as unknown as { __klyroAppStatus?: unknown }).__klyroAppStatus;
      delete (globalThis as unknown as { __klyroAppPlan?: unknown }).__klyroAppPlan;
    };
  }, [appendStatic, updateStatus, updatePlan]);

  // Also handle batched text via global hook for streaming
  useEffect(() => {
    const origAppend = appendStatic;
    (globalThis as unknown as { __klyroAppendDelta?: (t: string) => void }).__klyroAppendDelta = appendDeltaBatched;
    return () => { delete (globalThis as unknown as { __klyroAppendDelta?: unknown }).__klyroAppendDelta; };
  }, [appendDeltaBatched, appendStatic]);

  // Queue handling (2.4)
  useEffect(() => {
    if (queued && status.status !== 'running' && !awaitingApproval) {
      const toSend = queued;
      setQueued(null);
      const trimmed = toSend.trim();
      if (!trimmed) return;
      const item: TranscriptItem = { id: nextId('text'), kind: 'text', text: toSend, role: 'user' };
      setStaticItems((prev) => [...prev, item]);
      try { fs.mkdirSync(path.dirname(getHistoryPath()), { recursive: true }); fs.appendFileSync(getHistoryPath(), JSON.stringify({ cwd: props.cwd, text: toSend, ts: Date.now() }) + '\n'); } catch {}
      const cmd = parseSlash(trimmed);
      if (cmd.kind === 'prompt') void props.onPrompt(cmd.text);
      else void props.onSlash(cmd);
    }
  }, [queued, status.status, awaitingApproval]);

  // Single useInput owner (discipline 4)
  useInput((inputStr, key) => {
    if (awaitingApproval) return; // approval modal owns input

    if (status.status === 'running') {
      if (key.ctrl && inputStr === 'c') { void props.onSlash({ kind: 'quit' }); return; }
      if (key.return) {
        const v = input.trim();
        if (!v) return;
        setQueued(v);
        setInput('');
        // Show queued indicator in live region
        return;
      }
      if (key.ctrl && inputStr === 't') { setThinkingExpanded((v) => !v); return; }
      return;
    }

    if (key.upArrow) {
      if (history.length === 0) return;
      if (histIdx.current === -1) histIdx.current = history.length - 1;
      else if (histIdx.current > 0) histIdx.current--;
      setInput(history[histIdx.current] ?? '');
      return;
    }
    if (key.downArrow) {
      if (histIdx.current === -1) return;
      histIdx.current++;
      if (histIdx.current >= history.length) { histIdx.current = -1; setInput(''); }
      else setInput(history[histIdx.current] ?? '');
      return;
    }
    if (key.ctrl && inputStr === 'r') {
      const term = input.toLowerCase();
      for (let i = history.length - 1; i >= 0; i--) if (history[i]!.toLowerCase().includes(term)) { setInput(history[i]!); return; }
      return;
    }
    if (key.return) {
      const isShift = (key as unknown as { shift?: boolean }).shift === true;
      if (isShift || input.endsWith('\\')) {
        if (input.endsWith('\\')) setInput((v) => v.slice(0, -1) + '\n');
        else setInput((v) => v + '\n');
        return;
      }
      const value = input;
      const trimmed = value.replace(/^\s+|\s+$/g, '');
      if (!trimmed) { setInput(''); return; }
      // @ and ! handling
      if (trimmed.startsWith('@')) {
        const atPath = trimmed.slice(1).trim().split(' ')[0] ?? '';
        setInput('');
        setStaticItems((prev) => [...prev, { id: nextId('text'), kind: 'text', text: value, role: 'user' } as TranscriptItem]);
        void props.onPrompt(`Reference file: ${atPath}`);
        return;
      }
      if (trimmed.startsWith('!')) {
        const cmdText = trimmed.slice(1).trim();
        setInput('');
        setStaticItems((prev) => [...prev, { id: nextId('text'), kind: 'text', text: value, role: 'user' } as TranscriptItem]);
        import('../tools/shell/shell-exec.js').then(async ({ shellExecTool }) => {
          const { builtinRegistry } = await import('../tools/registry.js');
          const reg = builtinRegistry();
          const r = await reg.execute('shell_exec', { command: cmdText }, { cwd: props.cwd, env: process.env, nonInteractive: true });
          const out = r.ok ? JSON.stringify(r.value).slice(0, 500) : String((r as unknown as { error: { message: string } }).error.message);
          setStaticItems((prev) => [...prev, { id: nextId('text'), kind: 'text', text: `!${cmdText}\n${out}`, role: 'assistant' } as TranscriptItem]);
        });
        return;
      }
      if (trimmed.startsWith('# ')) {
        const note = trimmed.slice(2).trim();
        import('node:fs/promises').then(async (fs) => {
          const p = path.join(props.cwd, '.klyro', 'memory', 'session-notes.md');
          await fs.mkdir(path.dirname(p), { recursive: true });
          await fs.appendFile(p, `- ${note}\n`, 'utf-8');
        });
        setInput('');
        setStaticItems((prev) => [...prev, { id: nextId('text'), kind: 'text', text: `Note saved: ${note}`, role: 'assistant' } as TranscriptItem]);
        return;
      }
      setInput('');
      histIdx.current = -1;
      setHistory((prev) => {
        const next = [...prev, value];
        try { fs.mkdirSync(path.dirname(getHistoryPath()), { recursive: true }); fs.appendFileSync(getHistoryPath(), JSON.stringify({ cwd: props.cwd, text: value, ts: Date.now() }) + '\n'); } catch {}
        return next.slice(-200);
      });
      const userItem: TranscriptItem = { id: nextId('text'), kind: 'text', text: value, role: 'user' };
      setStaticItems((prev) => [...prev, userItem]);
      const cmd = parseSlash(trimmed);
      if (cmd.kind === 'prompt') void props.onPrompt(cmd.text);
      else void props.onSlash(cmd);
      return;
    }
    if (key.backspace || key.delete) { setInput((v) => v.slice(0, -1)); return; }
    if (key.ctrl && inputStr === 'c') {
      if (input === '') {
        const now = Date.now();
        if (now - lastCtrlC.current < 1500) { void props.onSlash({ kind: 'quit' }); return; }
        lastCtrlC.current = now;
        setStaticItems((prev) => [...prev, { id: nextId('text'), kind: 'text', text: '(press Ctrl+C again to exit)', role: 'assistant' } as TranscriptItem]);
        return;
      }
      setInput(''); return;
    }
    if (key.ctrl && inputStr === 'd') { void props.onSlash({ kind: 'quit' }); return; }
    if (key.ctrl && inputStr === 'l') { setStaticItems((prev) => [...prev, { id: nextId('text'), kind: 'text', text: '(cleared)', role: 'assistant' } as TranscriptItem]); return; }
    if (key.ctrl && inputStr === 't') { setThinkingExpanded((v) => !v); return; }
    if (!key.ctrl && !key.meta) {
      const norm = inputStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      setInput((v) => v + norm);
    }
  });

  const promptStr = `klyro › ${path.basename(props.cwd)}${gitBranch ? ` (${gitBranch})` : ''}`;

  return (
    <Box flexDirection="column" width="100%">
      {/* Banner — session start, per 5.1 */}
      <Banner
        version="0.1.8"
        cwd={props.cwd}
        branch={gitBranch}
        model={status.model}
        klyroMdLoaded={false}
        packageManager="pnpm"
        testRunner="vitest"
      />
      {/* Legacy header/status for test compatibility */}
      <Box flexDirection="column" width="100%">
        <Box borderStyle="single" borderColor={tokens.ansi.accent as unknown as string} paddingX={1} flexDirection="row" justifyContent="space-between">
          <Box><Text color={tokens.ansi.accent as unknown as string} bold>KLYRO</Text><Text color={tokens.ansi.muted as unknown as string}>  {path.basename(props.cwd)}</Text></Box>
          <Box><Text color={tokens.ansi.muted as unknown as string}>{status.model}  step {status.step}/{status.maxSteps}</Text></Box>
        </Box>
        <StatusLine snapshot={status} />
      </Box>
      <Static items={staticItems}>
        {(item) => (
          <Box key={item.id} flexDirection="column" width="100%">
            {item.kind === 'text' && item.role === 'user' ? (
              <Box><Text color={tokens.ansi.accent as unknown as string}>{glyphs.prompt} </Text><Text>{item.text}</Text></Box>
            ) : item.kind === 'text' ? (
              <Box paddingLeft={2}><Text>{item.text}</Text></Box>
            ) : (
              <Transcript items={[item]} />
            )}
          </Box>
        )}
      </Static>

      {/* Live region — only dynamic part */}
      <Box flexDirection="column" width="100%">
        {liveThinking ? (
          <Box paddingX={1}>
            <Text color={tokens.ansi.muted as unknown as string} dimColor>∴ Thinking…</Text>
            {isThinkingExpanded ? <Text color={tokens.ansi.muted as unknown as string} dimColor> {liveThinking}</Text> : <Text color={tokens.ansi.muted as unknown as string} dimColor> ctrl+t to show</Text>}
          </Box>
        ) : null}
        {liveText ? (
          <Box paddingX={1} flexDirection="column">
            <Text>{liveText}▍</Text>
          </Box>
        ) : null}
        {activity ? (
          <ActivityLine verb={activity.verb} elapsedMs={Date.now() - activity.start} hint="esc to interrupt" />
        ) : null}
        {queued ? (
          <Box paddingX={1}><Text color={tokens.ansi.muted as unknown as string} dimColor>⏳ queued: "{queued.slice(0, 60)}"</Text></Box>
        ) : null}
        <Box borderStyle="round" borderColor={awaitingApproval ? (tokens.ansi.warning as unknown as string) : (tokens.ansi.accent as unknown as string)} paddingX={1}>
          <Text color={tokens.ansi.muted as unknown as string} dimColor>{promptStr} </Text>
          <Text>{input}▏</Text>
        </Box>
        <Box paddingX={1} justifyContent="space-between">
          <Text color={tokens.ansi.muted as unknown as string} dimColor>Tab: slash completion · Shift+Enter: newline · Ctrl+C twice: exit</Text>
          <Text color={tokens.ansi.muted as unknown as string} dimColor>{status.model} · ctx {Math.round(((status.usageInput + status.usageOutput)/128000)*100)}% · ${((status.usageInput/1000)*0.003 + (status.usageOutput/1000)*0.015).toFixed(2)}</Text>
        </Box>
      </Box>
    </Box>
  );
}
