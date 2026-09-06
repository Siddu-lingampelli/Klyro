/**
 * Klyro TUI - opencode-clean - no clumsy words, correct wrap, markdown, scroll
 * Header 3 rows, guide │ at col2, ● Klyro accent, prose wrapped at word boundaries
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { execFileSync } from 'node:child_process';
import type { StatusSnapshot } from './status.js';
import type { TranscriptItem, ToolResultPatch } from './transcript.js';
import { TuiApprovalBridge, ApprovalModal } from './approval.js';
import type { PlanStep } from '../agent/runtime.js';
import { parse as parseSlash, suggestCommands } from '../cli/slash/parser.js';
import { tokens, g } from './tokens.js';
import {
  initialScroll,
  scrollReducer,
  resolveTopRow,
  maxTopFor,
  type ScrollState,
  type ScrollAction,
  type ScrollCtx,
} from './scroll-model.js';
import { buildIndex, itemAtRow, MeasureCache, type BlockDesc } from './measure.js';
import { renderMarkdownLines } from './markdown.js';
import { readVersion } from '../version.js';
import {
  getTranscriptCommand,
  type TranscriptCommand,
  type TranscriptScrollHandle,
} from './transcript-commands.js';
import { estimateCost, getModelInfo } from '../providers/model-info.js';

export interface AppProps {
  initialModel: string;
  maxSteps: number;
  cwd: string;
  onPrompt: (text: string) => void | Promise<void>;
  onSlash: (cmd: import('../cli/slash/parser.js').SlashCommand) => void | Promise<void>;
  initialTranscript?: TranscriptItem[];
  initialStatus?: Partial<StatusSnapshot>;
  approvalBridge?: TuiApprovalBridge;
  onMounted?: (hooks: { append: (i: TranscriptItem) => void; appendDelta: (text: string) => void; updateStatus: (s: Partial<StatusSnapshot>) => void; updatePlan: (p: PlanStep[]) => void; clearTranscript: () => void; scrollLines: (delta: number) => void; scrollToBottom: () => void; scrollHalfPage: (dir: -1 | 1) => void; scrollToTop: () => void; transcript: TranscriptScrollHandle; updateTool: (idCall: string, patch: ToolResultPatch) => void; appendThinkingDelta: (text: string) => void; clearThinking: () => void }) => void;
  version?: string;
  isFullscreen?: boolean;
}
let _id = 0;
function nextId(p: string): string { _id++; return `${p}-${_id}`; }

function Header({ cwd, model, version, width }: { cwd: string; model: string; version: string; width: number }) {
  const branch = useMemo(() => {
    try {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return '';
    }
  }, [cwd]);
  const showLinks = width >= 120;
  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Box justifyContent="space-between">
        <Text bold color={tokens.colors.accent as string}>KLYRO  v{version}</Text>
        {showLinks ? <Text color={tokens.colors.dim as string}>│  /help   /config   /clear   /exit</Text> : null}
      </Box>
      <Text color={tokens.colors.dim as string}>{model}  ·  {cwd}</Text>
      {branch ? <Text color={tokens.colors.dim as string}>⎇  {branch}</Text> : null}
    </Box>
  );
}

type Verb = 'Read' | 'Listed' | 'Searched' | 'Ran' | 'Edited' | 'Created' | 'Checked git' | 'Fetched' | 'Searched web' | 'Called';
function verbForTool(name: string): Verb {
  if (name === 'read_file') return 'Read' as Verb;
  if (name === 'list_directory') return 'Listed' as Verb;
  if (name === 'grep' || name === 'glob' || name === 'find_files' || name === 'search_files' || name === 'recent_files') return 'Searched' as Verb;
  if (name === 'shell_exec' || name === 'run_verify') return 'Ran' as Verb;
  if (name.startsWith('git_')) return 'Checked git' as Verb;
  if (name === 'web_fetch') return 'Fetched' as Verb;
  if (name === 'web_search') return 'Searched web' as Verb;
  if (name === 'edit_file' || name === 'multi_edit' || name === 'apply_patch' || name === 'write_file') return 'Edited' as Verb;
  return 'Called' as Verb;
}
interface Group { id: string; verb: Verb; items: Extract<TranscriptItem, { kind: 'tool' }>[]; totalMs: number; status: 'running' | 'done' | 'error'; }
/**
 * Aggregator (scroll.md §9): merge CONSECUTIVE same-op tool events into one
 * ActivityGroup. Never merge across a different op — read,read,edit,read →
 * 3 groups, not 2. Group ids are content-derived (stable across regroups so
 * scroll anchors and expansion state survive streaming appends).
 */
function groupTools(items: TranscriptItem[]): Array<TranscriptItem | Group> {
  const out: Array<TranscriptItem | Group> = [];
  let cur: Extract<TranscriptItem, { kind: 'tool' }>[] = [];
  let curVerb: Verb | null = null;
  const flush = () => {
    if (cur.length === 0) return;
    const verb = curVerb!;
    const totalMs = cur.reduce((s, x) => s + (x.latencyMs ?? 0), 0);
    const status = cur.some((x) => x.isError || x.status === 'error') ? 'error' as const : cur.some((x) => x.status === 'running') ? 'running' as const : 'done' as const;
    out.push({ id: `g:${verb}:${cur.map((i) => i.id_call).join('|')}`, verb, items: cur, totalMs, status });
    cur = [];
    curVerb = null;
  };
  for (const it of items) {
    if (it.kind === 'tool') {
      const v = verbForTool((it as Extract<TranscriptItem, { kind: 'tool' }>).name);
      if (curVerb !== null && v !== curVerb) flush(); // different op → break the group
      curVerb = v;
      cur.push(it as Extract<TranscriptItem, { kind: 'tool' }>);
    } else {
      flush();
      out.push(it);
    }
  }
  flush(); return out;
}

// design.md §23/§24 — terminal Markdown via tui/markdown.ts: headings,
// **bold**, *italic*, `code`, fences, links, lists. Ink wraps the text.
//
// CRITICAL: this must return a SINGLE <Text> with inline nested parts.
// A fragment of sibling <Text>s inside the row-direction parent Box lays
// out as side-by-side COLUMNS (garbled transcript) instead of lines.
function MarkdownText({ text, dim, width }: { text: string; dim?: boolean; width?: number }) {
  void width;
  const lines = useMemo(() => renderMarkdownLines(text), [text]);
  const dimColor = tokens.colors.dim as string;
  const softColor = tokens.colors.soft as string;
  return (
    <Text wrap="wrap" color={dim ? dimColor : undefined}>
      {lines.map((l, i) => (
        <React.Fragment key={i}>
          {i > 0 ? '\n' : null}
          {l.parts.map((p, j) => (
            <Text
              key={j}
              bold={p.bold || undefined}
              color={p.bold ? (dim ? undefined : softColor) : p.dim ? dimColor : p.code ? softColor : undefined}
            >
              {p.text}
            </Text>
          ))}
        </React.Fragment>
      ))}
    </Text>
  );
}

// Chat scroll — scroll.md §5 anchor model adapted to Ink.
//
// Position is an Anchor ({itemId, lineInItem}), never a raw row index (I4),
// resolved per frame against measured *display lines* (I3, see measure.ts).
// While anchored to 'bottom', new output follows; scrolling up pins to an
// item and freezes, accumulating newSinceUnstick lines for the `↓ N new` pill.
//
// Deviation from §7.1: Ink cannot overlay rows, so the badge renders as a
// one-line pill above the input instead of overwriting the last viewport row.
function useChatScroll(opts: {
  keys: string[];
  heights: number[];
  viewportH: number;
  width: number;
}) {
  const { keys, heights, viewportH, width } = opts;
  const [state, setState] = useState<ScrollState>(initialScroll);

  const index = useMemo(() => buildIndex(heights), [heights]);

  const ctx: ScrollCtx = {
    count: keys.length,
    offsetOf: (i) => index.offsets[i] ?? 0,
    keyOf: (i) => keys[i] ?? '',
    indexAt: (row) => itemAtRow(index.offsets, row),
    total: index.total,
    viewportH,
  };
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // Auto-follow wiring (§6): measured total deltas → CONTENT_GREW;
  // width change → REFLOW (§12). Initial anchor is 'bottom' → follow-tail.
  const prevTotalRef = useRef(index.total);
  const prevWidthRef = useRef(width);
  useEffect(() => {
    const prevTotal = prevTotalRef.current;
    const prevWidth = prevWidthRef.current;
    prevTotalRef.current = index.total;
    prevWidthRef.current = width;
    if (width !== prevWidth) {
      setState((s) => scrollReducer(s, { type: 'REFLOW' }, ctxRef.current));
      return;
    }
    const delta = index.total - prevTotal;
    if (delta !== 0) {
      setState((s) => scrollReducer(s, { type: 'CONTENT_GREW', lines: delta }, ctxRef.current));
    }
  }, [index.total, width]);

  const dispatch = useCallback((a: ScrollAction) => {
    setState((s) => scrollReducer(s, a, ctxRef.current));
  }, []);

  const stateRef = useRef(state);
  stateRef.current = state;

  // design.md §9/§11: PageUp/Dn = half page, Home/End = first/last.
  // (TranscriptCommand abstraction: messages_half_page_up/down,
  // messages_first, messages_last.)
  const commands = useMemo(() => ({
    lineUp: () => dispatch({ type: 'BY_LINES', delta: -1 }),
    lineDown: () => dispatch({ type: 'BY_LINES', delta: 1 }),
    pageUp: () => dispatch({ type: 'BY_HALF_PAGE', dir: -1 }),
    pageDown: () => dispatch({ type: 'BY_HALF_PAGE', dir: 1 }),
    jumpTop: () => dispatch({ type: 'TO_TOP' }),
    jumpBottom: () => dispatch({ type: 'TO_BOTTOM' }),
    reset: () => dispatch({ type: 'TO_BOTTOM' }),
  }), [dispatch]);

  const resolved = resolveTopRow(state, ctx);
  const maxTop = maxTopFor(ctx);
  const pinned = state.anchor.mode === 'pinned' && !resolved.atBottom;
  return {
    topRow: resolved.topRow,
    atBottom: resolved.atBottom,
    maxTop,
    pinned,
    pendingNew: state.newSinceUnstick,
    commands,
  };
}

export function App(props: AppProps): React.JSX.Element {
  const { stdout } = useStdout();
  const [transcript, setTranscript] = useState<TranscriptItem[]>(props.initialTranscript ?? []);
  const [input, setInput] = useState('');
  const [bridge] = useState(() => props.approvalBridge ?? new TuiApprovalBridge());
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [status, setStatus] = useState<StatusSnapshot>({ model: props.initialModel, step: 0, maxSteps: props.maxSteps, usageInput: 0, usageOutput: 0, repairs: 0, status: 'idle', ...props.initialStatus });
  const [elapsed, setElapsed] = useState(0);
  const [queuedInputs, setQueuedInputs] = useState<string[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const streamingIdRef = useRef<string | null>(null);
  // Input history for contextual ↑/↓ (scroll.md §8.3, S6)
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const pushHistory = useCallback((v: string) => {
    setHistory((prev) => (prev[prev.length - 1] === v ? prev : [...prev.slice(-99), v]));
    setHistIdx(null);
  }, []);
  // design.md §18: Ctrl+C cancels the run first, exits on second press.
  const ctrlCArmed = useRef(false);
  useEffect(() => {
    if (status.status !== 'running') ctrlCArmed.current = false;
  }, [status.status]);
  // scroll.md §7: submit bumps a version key; the settle effect below pins
  // to bottom immediate + microtask + timeout so layout settles first.
  // (Decoupled from render: never scroll directly inside the submit handler.)
  const [submitKey, setSubmitKey] = useState(0);
  useEffect(() => {
    if (!submitKey) return;
    const toBottom = (): void => {
      scrollCmdsRef.current.bottom();
    };
    toBottom();
    queueMicrotask(toBottom);
    const t = setTimeout(toBottom, 0);
    return () => clearTimeout(t);
  }, [submitKey]);
  // Shift+Enter intent: explicit shift+return, kitty/CSI-u sequence, legacy
  // ESC+CR pair, or Esc immediately followed by Return (75ms, non-empty input).
  const escReturnAt = useRef(0);
  // Live scroll control for external drivers (mouse-wheel tap in repl.ts).
  // design.md §9 TranscriptCommand: half-page up/down, first, last.
  const scrollCmdsRef = useRef({
    line: (_d: number) => {},
    bottom: () => {},
    halfPage: (_dir: -1 | 1) => {},
    top: () => {},
    reset: () => {},
  });

  const width = stdout?.columns ?? 100;
  const height = stdout?.rows ?? 30;
  const isFullscreen = props.isFullscreen ?? false;
  // §16: don't regroup on every render (e.g. the 1s status ticker) —
  // only when the transcript itself changes.
  const grouped = useMemo(() => groupTools(transcript), [transcript]);
  const viewportH = Math.max(5, height - 10);
  // Degraded mode (§12): terminal < 10 rows → transcript hidden, input+status only.
  const tiny = height < 10;

  // --- Measured blocks (§4): one entry per grouped item + tail blocks ------
  // Heights are estimated wrapped display lines; the cache makes streaming
  // O(1) (only the tail sig changes per tick, I6).
  const measureCacheRef = useRef<MeasureCache | null>(null);
  if (!measureCacheRef.current) measureCacheRef.current = new MeasureCache();
  const cache = measureCacheRef.current;

  interface ViewBlock {
    key: string;
    desc: BlockDesc;
    groupIndex: number | null; // index into `grouped`, null for tail blocks
    tail: 'plan' | 'thinking' | 'queued' | null;
  }
  const blocks: ViewBlock[] = useMemo(() => {
    const out: ViewBlock[] = [];
    grouped.forEach((entry, gi) => {
      if ((entry as Group).verb) {
        const gr = entry as Group;
        out.push({
          key: gr.id,
          desc: {
            kind: 'group',
            count: gr.items.length,
            expanded: expandedGroups.has(gr.id),
            status: gr.status,
            resultLen: gr.items.reduce((s, x) => s + (x.result?.length ?? 0), 0),
          },
          groupIndex: gi,
          tail: null,
        });
        return;
      }
      const it = entry as TranscriptItem;
      if (it.kind === 'text' && it.role === 'user') {
        out.push({ key: it.id, desc: { kind: 'user', text: it.text }, groupIndex: gi, tail: null });
      } else if (it.kind === 'text') {
        out.push({ key: it.id, desc: { kind: 'assistant', text: it.text }, groupIndex: gi, tail: null });
      } else if (it.kind === 'thinking') {
        out.push({ key: it.id, desc: { kind: 'reasoning', text: it.text }, groupIndex: gi, tail: null });
      } else if (it.kind === 'error') {
        out.push({ key: it.id, desc: { kind: 'error', message: it.message }, groupIndex: gi, tail: null });
      } else if (it.kind === 'policy') {
        out.push({ key: it.id, desc: { kind: 'policy' }, groupIndex: gi, tail: null });
      } else if (it.kind === 'file_changed') {
        out.push({ key: it.id, desc: { kind: 'file', path: it.path }, groupIndex: gi, tail: null });
      } else if (it.kind === 'diff') {
        out.push({
          key: it.id,
          desc: { kind: 'diff', hunks: it.hunks.map((h) => ({ path: h.path, lines: h.lines.map((l) => l.text) })) },
          groupIndex: gi,
          tail: null,
        });
      }
    });
    if (plan.length > 0) {
      out.push({
        key: 'tail:plan',
        desc: { kind: 'plan', done: plan.filter((p) => p.status === 'done').length, total: plan.length },
        groupIndex: null,
        tail: 'plan',
      });
    }
    if (status.status === 'running' && !streamingIdRef.current) {
      out.push({ key: 'tail:thinking', desc: { kind: 'thinking' }, groupIndex: null, tail: 'thinking' });
    }
    if (queuedInputs.length > 0) {
      out.push({ key: 'tail:queued', desc: { kind: 'queued', count: queuedInputs.length }, groupIndex: null, tail: 'queued' });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, plan, status.status, queuedInputs.length, expandedGroups, width]);

  const blockKeys = useMemo(() => blocks.map((b) => b.key), [blocks]);
  const blockHeights = useMemo(
    () => blocks.map((b) => cache.heightFor(b.key, b.desc, width)),
    [blocks, width, cache],
  );

  const scroll = useChatScroll({ keys: blockKeys, heights: blockHeights, viewportH, width });
  const { topRow, maxTop, pinned, pendingNew, commands } = scroll;
  const trackH = viewportH;
  const thumbPos = maxTop === 0 ? 0 : Math.round((topRow / maxTop) * (trackH - 1));

  // Slice *display lines* [topRow, topRow+viewportH): intersecting blocks only
  // (§6.1 virtualization — only visible items are composed).
  const endRow = topRow + viewportH;
  let gi0 = grouped.length;
  let gi1 = -1;
  let showPlan = false;
  let showThinking = false;
  let showQueued = false;
  if (!isFullscreen || tiny) {
    gi0 = 0;
    gi1 = grouped.length - 1;
    showPlan = true;
    showThinking = true;
    showQueued = true;
  } else {
    let row = 0;
    for (let bi = 0; bi < blocks.length; bi++) {
      const h = blockHeights[bi] ?? 0;
      const bStart = row;
      const bEnd = row + h;
      row = bEnd;
      if (bEnd <= topRow || bStart >= endRow || h === 0) continue;
      const b = blocks[bi]!;
      if (b.groupIndex !== null) {
        gi0 = Math.min(gi0, b.groupIndex);
        gi1 = Math.max(gi1, b.groupIndex);
      } else if (b.tail === 'plan') showPlan = true;
      else if (b.tail === 'thinking') showThinking = true;
      else if (b.tail === 'queued') showQueued = true;
    }
    if (gi1 < gi0) { gi0 = 0; gi1 = -1; }
  }
  const visibleGrouped = isFullscreen && !tiny ? grouped.slice(gi0, gi1 + 1) : grouped;
  // Publish live scroll control for the mouse-wheel tap (stable callbacks, latest ctx).
  scrollCmdsRef.current = {
    line: (d: number) => {
      const n = Math.abs(Math.round(d));
      for (let i = 0; i < n; i++) {
        if (d < 0) commands.lineUp();
        else commands.lineDown();
      }
    },
    bottom: () => commands.jumpBottom(),
    reset: () => commands.reset(),
    halfPage: (dir: -1 | 1) => {
      if (dir < 0) commands.pageUp();
      else commands.pageDown();
    },
    top: () => commands.jumpTop(),
  };

  useEffect(() => bridge.subscribe((p) => setAwaitingApproval(p !== null)), [bridge]);
  useEffect(() => {
    if (queuedInputs.length > 0 && status.status !== 'running' && !awaitingApproval) {
      const toSend = queuedInputs[0]!;
      setQueuedInputs((prev) => prev.slice(1));
      setTranscript((prev) => [...prev, { id: nextId('user'), kind: 'text', text: toSend, role: 'user' } as TranscriptItem]);
      streamingIdRef.current = null;
      const cmd = parseSlash(toSend.trim());
      if (cmd.kind === 'prompt') void props.onPrompt(cmd.text); else void props.onSlash(cmd);
    }
  }, [queuedInputs, status.status, awaitingApproval]);
  useEffect(() => { if (status.status !== 'running') return; const start = Date.now() - elapsed; const t = setInterval(() => setElapsed(Date.now() - start), 1000); return () => clearInterval(t); }, [status.status, elapsed]);

  const append = useCallback((item: TranscriptItem) => { if (item.kind !== 'text' || item.role !== 'assistant') streamingIdRef.current = null; setTranscript((prev) => [...prev, item]); }, []);
  const appendDelta = useCallback((text: string) => {
    if (!text) return; const sid = streamingIdRef.current;
    if (sid) setTranscript((prev) => { const idx = prev.findIndex((x) => x.id === sid); if (idx === -1) return [...prev, { id: sid, kind: 'text', text, role: 'assistant' } as TranscriptItem]; const cur = prev[idx] as Extract<TranscriptItem, { kind: 'text' }>; const copy = [...prev]; copy[idx] = { ...cur, text: cur.text + text } as TranscriptItem; return copy; });
    else { const id = nextId('stream'); streamingIdRef.current = id; setTranscript((prev) => [...prev, { id, kind: 'text', text, role: 'assistant' } as TranscriptItem]); }
  }, []);
  // Ephemeral reasoning display: merges into one transient item (never in
  // context/persistence); removed when the turn's answer completes.
  const thinkingIdRef = useRef<string | null>(null);
  const appendThinkingDelta = useCallback((text: string) => {
    if (!text) return; const tid = thinkingIdRef.current;
    if (tid) setTranscript((prev) => { const idx = prev.findIndex((x) => x.id === tid); if (idx === -1) return [...prev, { id: tid, kind: 'thinking', text } as TranscriptItem]; const cur = prev[idx] as Extract<TranscriptItem, { kind: 'thinking' }>; const copy = [...prev]; copy[idx] = { ...cur, text: cur.text + text } as TranscriptItem; return copy; });
    else { const id = nextId('thinking'); thinkingIdRef.current = id; setTranscript((prev) => [...prev, { id, kind: 'thinking', text } as TranscriptItem]); }
  }, []);
  const clearThinking = useCallback(() => {
    thinkingIdRef.current = null;
    setTranscript((prev) => (prev.some((x) => x.kind === 'thinking') ? prev.filter((x) => x.kind !== 'thinking') : prev));
  }, []);
  useEffect(() => {
    if (status.status !== 'running') {
      streamingIdRef.current = null;
      thinkingIdRef.current = null;
      // Runs that end without final_text (abort/cancel/error) must not leave
      // stale thinking blocks behind — only the response may remain.
      setTranscript((prev) => (prev.some((x) => x.kind === 'thinking') ? prev.filter((x) => x.kind !== 'thinking') : prev));
    }
  }, [status.status]);
  const updateStatus = useCallback((s: Partial<StatusSnapshot>) => setStatus((p) => ({ ...p, ...s })), []);
  const updatePlan = useCallback((p: PlanStep[]) => setPlan(p), []);
  // Tool results patch the running start-item IN PLACE (no second item, so a
  // group never stays 'running' forever showing a ticking elapsed timer).
  const updateTool = useCallback((idCall: string, patch: ToolResultPatch) => {
    setTranscript((prev) => {
      const idx = prev.findIndex(
        (x) =>
          x.kind === 'tool' &&
          (x as Extract<TranscriptItem, { kind: 'tool' }>).id_call === idCall &&
          (x as Extract<TranscriptItem, { kind: 'tool' }>).status === 'running',
      );
      if (idx === -1) return prev;
      const copy = [...prev];
      copy[idx] = { ...(copy[idx] as Extract<TranscriptItem, { kind: 'tool' }>), ...patch } as TranscriptItem;
      return copy;
    });
  }, []);
  const clearTranscript = useCallback(() => {
    streamingIdRef.current = null;
    thinkingIdRef.current = null;
    setTranscript([]);
    setPlan([]);
    // Fresh content → fresh scroll (a pruned anchor would otherwise stick to
    // the bottom with a stale newSinceUnstick badge count).
    scrollCmdsRef.current.reset();
  }, []);
  // Scroll control for external drivers (mouse-wheel tap in repl.ts, §8.4).
  // Stored in refs so the callbacks stay stable while acting on latest state.
  const scrollLines = useCallback((delta: number) => { scrollCmdsRef.current.line(delta); }, []);
  const scrollToBottom = useCallback(() => { scrollCmdsRef.current.bottom(); }, []);
  const scrollHalfPage = useCallback((dir: -1 | 1) => { scrollCmdsRef.current.halfPage(dir); }, []);
  const scrollToTop = useCallback(() => { scrollCmdsRef.current.top(); }, []);
  // scroll.md §2/§10: the four-command TranscriptScrollHandle.
  const transcriptHandle = useMemo<TranscriptScrollHandle>(
    () => ({
      runTranscriptCommand: (command: TranscriptCommand) => {
        switch (command) {
          case 'messages_half_page_up':
            scrollCmdsRef.current.halfPage(-1);
            return;
          case 'messages_half_page_down':
            scrollCmdsRef.current.halfPage(1);
            return;
          case 'messages_first':
            scrollCmdsRef.current.top();
            return;
          case 'messages_last':
            scrollCmdsRef.current.bottom();
            return;
        }
      },
    }),
    [],
  );
  const onMountedRef = useRef(props.onMounted);
  useEffect(() => { onMountedRef.current = props.onMounted; }, [props.onMounted]);
  useEffect(() => { onMountedRef.current?.({ append, appendDelta, updateStatus, updatePlan, clearTranscript, scrollLines, scrollToBottom, scrollHalfPage, scrollToTop, transcript: transcriptHandle, updateTool, appendThinkingDelta, clearThinking }); (globalThis as unknown as Record<string, unknown>).__klyroAppAppend = append; (globalThis as unknown as Record<string, unknown>).__klyroAppendDelta = appendDelta; (globalThis as unknown as Record<string, unknown>).__klyroAppStatus = updateStatus; (globalThis as unknown as Record<string, unknown>).__klyroAppPlan = updatePlan; (globalThis as unknown as Record<string, unknown>).__klyroAppendThinking = appendThinkingDelta; (globalThis as unknown as Record<string, unknown>).__klyroClearThinking = clearThinking; return () => { delete (globalThis as unknown as Record<string, unknown>).__klyroAppAppend; delete (globalThis as unknown as Record<string, unknown>).__klyroAppendDelta; delete (globalThis as unknown as Record<string, unknown>).__klyroAppStatus; delete (globalThis as unknown as Record<string, unknown>).__klyroAppPlan; delete (globalThis as unknown as Record<string, unknown>).__klyroAppendThinking; delete (globalThis as unknown as Record<string, unknown>).__klyroClearThinking; }; }, [append, appendDelta, updateStatus, updatePlan, clearTranscript, scrollLines, scrollToBottom, scrollHalfPage, scrollToTop, transcriptHandle, updateTool, appendThinkingDelta, clearThinking]);

  const toggleGroup = (id: string) => setExpandedGroups((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // `/` autocomplete — top 6 prefix matches while completing a command name (no space yet)
  const slashSuggest = input.startsWith('/') && !input.slice(1).includes(' ') && !awaitingApproval
    ? suggestCommands(input, 6)
    : [];

  useInput((inputStr, key) => {
    if (key.escape && queuedInputs.length > 0) { setQueuedInputs((prev) => prev.slice(1)); return; }
    // Tab completes the top slash suggestion (e.g. `/c` → `/clear `)
    if ((key.tab || inputStr === '\t') && slashSuggest.length > 0) {
      const top = slashSuggest[0]!;
      setInput(`/${top.name} `);
      return;
    }
    // Scroll keys (work in any mode, including while running).
    // scroll.md §6 flow: Keyboard → getTranscriptCommand → handle.
    // design.md §11: PageUp/Ctrl+U half-up, PageDown/Ctrl+D half-down,
    // Ctrl+Home/Ctrl+End first/last. (Plain Home/End + Ctrl+B/F/G kept.)
    if (isFullscreen && maxTop > 0) {
      const tcmd = getTranscriptCommand(inputStr, key);
      if (tcmd) { transcriptHandle.runTranscriptCommand(tcmd); return; }
      if (key.home) { commands.jumpTop(); return; }
      if (key.end)  { commands.jumpBottom(); return; }
      if (key.ctrl && inputStr === 'g') { commands.jumpBottom(); return; } // Ctrl+G → bottom
      if ((key.ctrl && inputStr === 'b')) { commands.pageUp(); return; }
      if ((key.ctrl && inputStr === 'f')) { commands.pageDown(); return; }
      if (key.upArrow && (key.shift || key.ctrl)) { commands.lineUp(); return; }
      if (key.downArrow && (key.shift || key.ctrl)) { commands.lineDown(); return; }
    }
    if (awaitingApproval) return;
    if (key.ctrl && inputStr === 'o') { const groups = grouped.filter((x): x is Group => typeof (x as Group).verb === 'string'); const last = groups[groups.length - 1]; if (last) toggleGroup(last.id); return; }
    // design.md §18: Shift+Enter → newline (never submit). Detect explicit
    // shift+return, CSI-u / ESC+CR sequences, or Esc→Return within 75ms.
    const now = Date.now();
    if (key.escape && input.trim() !== '') escReturnAt.current = now;
    if (
      (key.shift && key.return) ||
      inputStr === '\x1b\r' ||
      inputStr === '\x1b[13;2u' ||
      (key.return && input.trim() !== '' && now - escReturnAt.current < 75)
    ) {
      setInput((v) => v + '\n');
      setHistIdx(null);
      return;
    }
    if (status.status === 'running') {
      // design.md §18: first Ctrl+C cancels the run, second quits.
      if (key.ctrl && inputStr === 'c') {
        if (!ctrlCArmed.current) {
          ctrlCArmed.current = true;
          void props.onSlash({ kind: 'cancel' });
        } else {
          void props.onSlash({ kind: 'quit' });
        }
        return;
      }
      // Esc with an empty queue cancels streaming (§18); non-empty drops one (top).
      if (key.escape) { void props.onSlash({ kind: 'cancel' }); return; }
      // Enter on empty input dismisses the badge (jump to bottom, §7.2)
      if (key.return) { const v = input.trim(); if (!v) { if (pinned) commands.jumpBottom(); return; } if (queuedInputs.length >= 3) return; setQueuedInputs((prev) => [...prev, v]); setInput(''); pushHistory(v); setSubmitKey((k) => k + 1); return; }
      if (key.backspace || key.delete) { setInput((v) => v.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta) setInput((v) => v + inputStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
      return;
    }
    // design.md §18: idle Ctrl+C exits.
    if (key.ctrl && inputStr === 'c') { void props.onSlash({ kind: 'quit' }); return; }
    // Contextual ↑/↓ (§8.3): text in buffer (or browsing) → history;
    // empty buffer → scroll viewport one line.
    if (key.upArrow && !key.shift && !key.ctrl) {
      if (input.trim() !== '' || histIdx !== null) {
        if (history.length > 0) {
          const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
          setHistIdx(next);
          setInput(history[next] ?? '');
        }
        return;
      }
      if (isFullscreen && maxTop > 0) { commands.lineUp(); return; }
    }
    if (key.downArrow && !key.shift && !key.ctrl) {
      if (histIdx !== null) {
        const next = histIdx + 1;
        if (next >= history.length) { setHistIdx(null); setInput(''); }
        else { setHistIdx(next); setInput(history[next] ?? ''); }
        return;
      }
      if (input.trim() !== '') return; // single line with text, nothing newer
      if (isFullscreen && maxTop > 0) { commands.lineDown(); return; }
    }
    // Enter on empty input dismisses the badge (jump to bottom, §7.2)
    if (key.return) { const v = input.trim(); if (!v) { if (pinned) commands.jumpBottom(); return; } setInput(''); setHistIdx(null); pushHistory(v); setTranscript((prev) => [...prev, { id: nextId('user'), kind: 'text', text: v, role: 'user' } as TranscriptItem]); streamingIdRef.current = null; setSubmitKey((k) => k + 1); const cmd = parseSlash(v); if (cmd.kind === 'prompt') void props.onPrompt(cmd.text); else void props.onSlash(cmd); return; }
    if (key.backspace || key.delete) { setInput((v) => v.slice(0, -1)); setHistIdx(null); return; }
    if (!key.ctrl && !key.meta) { setInput((v) => v + inputStr); setHistIdx(null); }
  });

  // Single source of truth: package.json via version.ts — never hardcoded.
  const ver = props.version ?? readVersion();
  const rule = g('rule').repeat(Math.max(10, width - 2));
  // Single cost/context source: model-aware registry rates + window.
  const cost = estimateCost(status.model, status.usageInput, status.usageOutput);
  const totalTokens = status.usageInput + status.usageOutput;
  const ctxWindow = getModelInfo(status.model).contextWindow;
  const ctxPct = totalTokens > 0 ? Math.round((totalTokens / ctxWindow) * 100) : 0;
  // Narrow terminals: compact hints so the status bar never wraps mid-word.
  const baseHints = width < 90
    ? status.status === 'running' ? 'ctrl+c stop · enter queue' : 'enter send · / commands'
    : status.status === 'running' ? 'ctrl+c to stop  ·  enter to queue  ·  ctrl+o expand' : transcript.length === 0 ? 'shift+tab to cycle  ·  ↑/↓ for history  ·  / for commands' : 'enter to send  ·  shift+enter newline  ·  @ to attach';
  const hints = maxTop > 0 && isFullscreen ? `${baseHints}  ·  PgUp/Dn scroll` : baseHints;

  // I1 structural guard: the frame can never exceed terminal rows. Even if a
  // child mis-measures, the root clips — the input/status stay on screen and
  // Ink's cursor math can't corrupt into overlapping text.
  return (
    <Box flexDirection="column" width={width} height={isFullscreen ? height - 1 : undefined} overflow={isFullscreen ? 'hidden' : undefined}>
      <Header cwd={props.cwd} model={status.model} version={ver} width={width} />
      <Box flexDirection="row" flexGrow={isFullscreen ? 1 : 0} overflow={isFullscreen ? 'hidden' : undefined}>
        <Box flexDirection="column" flexGrow={1} overflow={isFullscreen ? 'hidden' : undefined} paddingX={0}>
          {tiny ? (
            <Text color={tokens.colors.warn as string}>⚠ terminal too small ({width}x{height}) — transcript hidden</Text>
          ) : null}
          {!tiny && grouped.length === 0 ? (
            <Text color={tokens.colors.dim as string}>Message Klyro...</Text>
          ) : !tiny ? visibleGrouped.map((item) => {
            if ((item as Group).verb) {
              const gr = item as Group;
              const isExpanded = expandedGroups.has(gr.id);
              const verbLine = (() => {
                if (gr.items.length === 1) { const it = gr.items[0]!; let p = ''; try { const a = JSON.parse(it.args) as Record<string, unknown>; p = (a.path as string) ?? (a.pattern as string) ?? (a.command as string)?.slice(0, 48) ?? ''; } catch { p = ''; } if (gr.verb === 'Read' && p) return `Read ${p.split('/').pop()}`; if (gr.verb === 'Searched' && p) return `Searched "${p}"`; if (gr.verb === 'Ran' && p) return `Ran ${p.split(' ')[0]}`; return `${gr.verb} ${p}`; }
                if (gr.verb === 'Read') return `Read ${gr.items.length} files`;
                if (gr.verb === 'Searched') return `Searched ${gr.items.length} patterns`;
                if (gr.verb === 'Ran') return `Ran ${gr.items.length} commands`;
                if (gr.verb === 'Edited') return `Edited ${gr.items.length} files`;
                return `${gr.verb} ${gr.items.length} items`;
              })();
              const right = gr.status === 'running' ? `${(elapsed / 1000).toFixed(1)}s` : gr.status === 'error' ? g('failure') : `${gr.totalMs}ms`;
              const marker = isExpanded ? g('expanded') : g('collapsed');
              const markerColor = gr.status === 'error' ? tokens.colors.err as string : gr.status === 'running' ? tokens.colors.warn as string : tokens.colors.ok as string;
              const running = gr.status === 'running';
              return (
                <Box key={gr.id} flexDirection="column" marginBottom={1}>
                  <Box>
                    <Text color={tokens.colors.guide as string}>  {g('guide')}   </Text>
                    {running ? <Text color={markerColor}><Spinner type="dots" /> </Text> : null}
                    <Text color={markerColor}>{marker} {verbLine}</Text>
                    <Text color={tokens.colors.dim as string}>  {right}</Text>
                  </Box>
                  {isExpanded ? (<>
                    {gr.items.slice(0, 12).map((it) => {
                      let friendly = '';
                      try { const a = JSON.parse(it.args) as Record<string, unknown>; const p = (a.path as string) ?? (a.pattern as string) ?? (a.command as string) ?? ''; const short = p ? String(p).split('/').pop()?.slice(0, 40) ?? p : ''; if (it.name === 'read_file' && short) friendly = `${short}`; else if (it.name === 'shell_exec' && p) friendly = `$ ${String(p).slice(0, 40)}`; else if (short) friendly = short; else friendly = it.args.slice(0, 40); } catch { friendly = it.args.slice(0, 40); }
                      return (<Box key={it.id} paddingLeft={4}><Text color={tokens.colors.guide as string}>{g('end')} </Text><Text color={tokens.colors.dim as string}>{friendly}</Text></Box>);
                    })}
                    {gr.items.length > 12 ? (
                      <Box paddingLeft={4}><Text color={tokens.colors.dim as string}>… {gr.items.length - 12} more</Text></Box>
                    ) : null}
                  </>) : null}
                </Box>
              );
            }
            const it = item as TranscriptItem;
            if (it.kind === 'text' && it.role === 'user') {
              return <Box key={it.id} marginBottom={1}><Text color={tokens.colors.accent as string} bold>{g('prompt')} </Text><Text wrap="wrap">{it.text}</Text></Box>;
            }
            if (it.kind === 'text') {
              // prose — render markdown, not raw **, with proper wrap and guide
              return (
                <Box key={it.id} flexDirection="column" marginBottom={1}>
                  <Box><Text color={tokens.colors.guide as string}>  {g('guide')}   </Text><Text color={tokens.colors.accent as string}>{g('agentBullet')} Klyro</Text></Box>
                  <Box paddingLeft={2} flexDirection="column">
                    <Box><Text color={tokens.colors.dim as string}>  {g('guide')}   </Text><Box flexGrow={1}><MarkdownText text={it.text} /></Box></Box>
                  </Box>
                </Box>
              );
            }
            // Ephemeral reasoning: light-white while working, removed on response.
            if (it.kind === 'thinking') return <Box key={it.id} paddingLeft={2} marginBottom={1}><Text wrap="wrap" color={tokens.colors.dim as string}>{it.text}</Text></Box>;
            if (it.kind === 'error') return <Box key={it.id} paddingLeft={2} marginBottom={1}><Text color={tokens.colors.err as string}>  {g('guide')}   {g('failure')} {it.message}</Text></Box>;
            if (it.kind === 'policy') return null;
            if (it.kind === 'file_changed') return <Box key={it.id} paddingLeft={2} marginBottom={1}><Text color={tokens.colors.dim as string}>  {g('guide')}   {g('editsBadge')} {it.path}  {it.op}</Text></Box>;
            if (it.kind === 'diff') return (
              <Box key={it.id} flexDirection="column" paddingLeft={2} marginBottom={1}>
                <Text bold color={tokens.colors.soft as string}>{it.summary ?? 'Diff'}</Text>
                {it.hunks.map((h, i) => (
                  <Box key={i} flexDirection="column" marginTop={0}>
                    <Text color={tokens.colors.soft as string}>{h.path}</Text>
                    {h.lines.map((l, j) => (
                      <Text key={j} wrap="wrap" color={l.kind === 'add' ? tokens.colors.ok as string : l.kind === 'remove' ? tokens.colors.err as string : tokens.colors.dim as string}>{l.kind === 'add' ? '+ ' : l.kind === 'remove' ? '- ' : '  '}{l.text}</Text>
                    ))}
                  </Box>
                ))}
              </Box>
            );
            return null;
          }) : null}
          {showThinking && status.status === 'running' && !streamingIdRef.current ? (
            <Box paddingLeft={2} marginBottom={1}><Text color={tokens.colors.guide as string}>  {g('guide')}   </Text><Text color={tokens.colors.accent as string}><Spinner type="dots" /> </Text><Text color={tokens.colors.dim as string}>Thinking... (esc to cancel)</Text><Text color={tokens.colors.dim as string}>  {(elapsed / 1000).toFixed(1)}s</Text></Box>
          ) : null}
          {showPlan && plan.length > 0 ? (
            <Box flexDirection="column" paddingLeft={2} marginTop={0} marginBottom={1}>
              <Box><Text color={tokens.colors.guide as string}>  {g('guide')}   </Text><Text bold>{g('todoPlan')} Plan  {plan.filter((p) => p.status === 'done').length}/{plan.length}</Text></Box>
              {plan.slice(0, 8).map((p, i) => (
                <Box key={p.id}><Text color={tokens.colors.guide as string}>  {g('guide')}   </Text><Text color={p.status === 'done' ? tokens.colors.ok as string : p.status === 'in_progress' ? tokens.colors.accent as string : tokens.colors.dim as string}>{p.status === 'done' ? g('todoDone') : p.status === 'in_progress' ? g('todoActive') : g('todoPending')} {i + 1}. {p.title}</Text></Box>
              ))}
            </Box>
          ) : null}
          {showQueued && queuedInputs.length > 0 ? (
            <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
              {queuedInputs.map((q, i) => (
                <Text key={i} color={tokens.colors.dim as string}>queued: {q.slice(0, 60)}{i === 0 ? '  esc to drop' : ''}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
        {isFullscreen ? (
          <Box flexDirection="column" width={1} marginLeft={1}>
            {Array.from({ length: trackH }).map((_, i) => (
              <Text key={i} color={i === thumbPos ? (tokens.colors.accent as string) : (tokens.colors.guide as string)}>{i === thumbPos ? '●' : '│'}</Text>
            ))}
          </Box>
        ) : null}
      </Box>
      {pinned && pendingNew > 0 ? (
        <Box justifyContent="flex-end" paddingX={1} flexShrink={0}>
          <Text backgroundColor={tokens.colors.accentSoft as string} color={tokens.colors.accent as string} bold>
            {' ↓ '}{pendingNew >= 1000 ? '999+ new' : `${pendingNew} new`}{' '}
          </Text>
        </Box>
      ) : null}
      {slashSuggest.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2} flexShrink={0}>
          {slashSuggest.map((s, i) => (
            <Text key={s.name} color={i === 0 ? (tokens.colors.accent as string) : (tokens.colors.dim as string)}>{i === 0 ? '▸' : ' '} /{s.name}  — {s.hint}</Text>
          ))}
          <Text color={tokens.colors.dim as string}>  tab to complete</Text>
        </Box>
      ) : null}
      <ApprovalModal bridge={bridge} />
      <Box flexDirection="column" flexShrink={0}>
        <Text color={tokens.colors.guide as string}>{g('rule').repeat(Math.max(10, width - 2))}</Text>
        <Box>
          <Text color={tokens.colors.accent as string} bold>{g('prompt')} </Text>
          <Text wrap="wrap">{input || <Text color={tokens.colors.dim as string}>Message Klyro...</Text> as unknown as string}|</Text>
        </Box>
        <Text color={tokens.colors.guide as string}>{g('rule').repeat(Math.max(10, width - 2))}</Text>
      </Box>
      <Box justifyContent="space-between" flexShrink={0}>
        <Text color={tokens.colors.dim as string}>{status.status === 'running' ? (<Text color={tokens.colors.accent as string}><Spinner type="dots" /> working  ·  </Text>) : null}{baseHints}{maxTop > 0 && isFullscreen ? '  ·  PgUp/Dn scroll' : ''}</Text>
        <Text color={tokens.colors.dim as string}>{maxTop > 0 && isFullscreen ? `⇅ ${topRow}/${maxTop} · ` : ''}{cost > 0 ? `$${cost.toFixed(2)} · ` : ''}{ctxPct}% ctx · {status.model}{status.status === 'running' ? ' ●' : ''}</Text>
      </Box>
    </Box>
  );
}
