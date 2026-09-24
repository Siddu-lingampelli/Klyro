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
import { loadCustomCommands, listCompletableFiles } from '../cli/slash/custom.js';
import { loadMcpServers } from '../mcp/config.js';
import { tokens, g } from './tokens.js';
import {
  initialScroll,
  scrollReducer,
  resolveTopRow,
  maxTopFor,
  badgeLabel,
  type ScrollState,
  type ScrollAction,
  type ScrollCtx,
} from './scroll-model.js';
import { buildIndex, itemAtRow, MeasureCache, type BlockDesc } from './measure.js';
import { renderMarkdownLines } from './markdown.js';
import { redact } from '../policy/secret-redactor.js';
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
  onMounted?: (hooks: { append: (i: TranscriptItem) => void; appendDelta: (text: string) => void; updateStatus: (s: Partial<StatusSnapshot>) => void; updatePlan: (p: PlanStep[]) => void; clearTranscript: () => void; scrollLines: (delta: number) => void; scrollToBottom: () => void; scrollHalfPage: (dir: -1 | 1) => void; scrollToTop: () => void; transcript: TranscriptScrollHandle; updateTool: (idCall: string, patch: ToolResultPatch) => void; appendThinkingDelta: (text: string) => void; clearThinking: () => void; pasteText: (text: string) => void; setVimMode: (mode: 'insert' | 'normal') => void }) => void;
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

// Input line with an explicit block cursor for vim normal mode.
// Same single-<Text> invariant as MarkdownText: nested inline parts only,
// so the row-direction parent never lays siblings out as columns.
function InputWithCursor({ input, cursor }: { input: string; cursor: number | null }) {
  const dimColor = tokens.colors.dim as string;
  if (!input) {
    return (
      <Text wrap="wrap">
        <Text color={dimColor}>Message Klyro...</Text>|
      </Text>
    );
  }
  const safe = redact(input);
  if (cursor === null) {
    return <Text wrap="wrap">{safe}|</Text>;
  }
  const pos = Math.max(0, Math.min(cursor, safe.length));
  const before = safe.slice(0, pos);
  const ch = safe.slice(pos, pos + 1) || ' ';
  const after = safe.slice(pos + 1);
  return (
    <Text wrap="wrap">
      {before}
      <Text inverse>{ch}</Text>
      {after}
    </Text>
  );
}

// design.md §23/§24 — terminal Markdown via tui/markdown.ts: headings,
// **bold**, *italic*, `code`, fences, links, lists. Ink wraps the text.
//
// CRITICAL: this must return a SINGLE <Text> with inline nested parts.
// A fragment of sibling <Text>s inside the row-direction parent Box lays
// out as side-by-side COLUMNS (garbled transcript) instead of lines.
function MarkdownText({ text, dim, width }: { text: string; dim?: boolean; width?: number }) {
  void width;
  // Display boundary: scrub secret shapes before painting the screen.
  // Execution data is untouched — this only affects rendered output.
  const lines = useMemo(() => renderMarkdownLines(redact(text)), [text]);
  const dimColor = tokens.colors.dim as string;
  const softColor = tokens.colors.soft as string;
  return (
    <Text wrap="wrap" color={dim ? dimColor : undefined}>
      {lines.map((l, i) => (
        <React.Fragment key={i}>
          {i > 0 ? '\n' : null}
          {l.parts.map((p, j) => {
            // R4: syntax-highlight color wins; otherwise dim for code/comment,
            // soft for bold, plain otherwise. file:line links surface as a
            // distinct accent (href is carried for tooling/terminal emit).
            // Inside dimmed (thinking) blocks the dim tone always wins.
            let color: string | undefined;
            if (dim) color = p.dim ? dimColor : undefined;
            else if (p.color) color = p.color;
            else if (p.href) color = tokens.colors.info;
            else if (p.dim) color = dimColor;
            else if (p.code) color = softColor;
            else if (p.bold) color = softColor;
            return (
              <Text key={j} bold={p.bold || undefined} color={color}>
                {p.text}
              </Text>
            );
          })}
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
  const pinned = state.anchor.mode === 'pinned' && (!resolved.atBottom || maxTop === 0);
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
  // Ctrl+R reverse-i-search over input history (1.4): {query, saved, idx}
  // with idx into newest-first matches (-1 = query only, nothing chosen).
  const [histSearch, setHistSearch] = useState<{ query: string; saved: string; idx: number } | null>(null);
  const searchMatches = useCallback((q: string): string[] => {
    const query = q.toLowerCase();
    const matches = (query === '' ? history : history.filter((h) => h.toLowerCase().includes(query)));
    return matches.slice().reverse();
  }, [history]);
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
  // Double-Esc convention: the first Esc while running only arms (with a
  // status hint); a second Esc within 1500ms cancels the stream. Single-Esc
  // immediate cancel was too easy to hit by accident next to Shift+Enter.
  const escArmedAt = useRef(0);
  const [escArmed, setEscArmed] = useState(false);
  const escArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmEsc = useCallback(() => {
    escArmedAt.current = 0;
    setEscArmed(false);
    if (escArmTimer.current) { clearTimeout(escArmTimer.current); escArmTimer.current = null; }
  }, []);
  // Minimal vim input mode (/vim toggles live via directHooks.setVimMode).
  // Normal mode: h/l/0/$ move, x deletes, i/a enter insert, j/k scroll a
  // line; every other printable key is swallowed (never typed). The cursor
  // is an explicit index (null = end); rendering clamps it.
  const [vimMode, setVimMode] = useState<'insert' | 'normal'>('insert');
  const [vimCursor, setVimCursor] = useState<number | null>(null);
  // Count prefix (3h) and pending operator (d for dd) — refs, not state:
  // they never render on their own, only through the next command.
  const vimCountRef = useRef(0);
  const vimPendingOp = useRef<'d' | null>(null);
  const setVimModeLive = useCallback((m: 'insert' | 'normal') => {
    setVimMode(m);
    vimCountRef.current = 0;
    vimPendingOp.current = null;
    if (m === 'insert') setVimCursor(null);
  }, []);
  // Cursor-aware editing: mirrors for synchronous use inside key handlers.
  const inputRef = useRef('');
  const vimCursorRef = useRef<number | null>(null);
  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => { vimCursorRef.current = vimCursor; }, [vimCursor]);
  const clampCursor = (v: string, c: number | null): number =>
    c === null ? v.length : Math.max(0, Math.min(c, v.length));
  const insertAtCursor = useCallback((text: string) => {
    const t = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!t) return;
    const v = inputRef.current;
    const pos = clampCursor(v, vimCursorRef.current);
    const nv = v.slice(0, pos) + t + v.slice(pos);
    setInput(nv);
    setVimCursor(pos + t.length >= nv.length ? null : pos + t.length);
    setHistIdx(null);
  }, []);
  const deleteBeforeCursor = useCallback(() => {
    const v = inputRef.current;
    const pos = clampCursor(v, vimCursorRef.current);
    if (pos === 0) return;
    const nv = v.slice(0, pos - 1) + v.slice(pos);
    setInput(nv);
    setVimCursor(pos - 1 >= nv.length ? null : pos - 1);
    setHistIdx(null);
  }, []);
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

  // Streaming render throttle: per-token setState copies the whole
  // transcript array AND the growing string (O(n²) over long streams).
  // Deltas accumulate in refs (the truth) and flush to state at most
  // every STREAM_FLUSH_MS, plus on turn end / new items. Renders stay
  // live (≤64ms stale) while array+string copies stay bounded.
  // Declared early: queued-input and key handlers below call resetStream.
  const STREAM_FLUSH_MS = 64;
  const streamTextRef = useRef('');
  const streamFlushAt = useRef(0);
  const streamTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingTextRef = useRef('');
  const thinkingFlushAt = useRef(0);
  const thinkingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Declared before the flush callbacks that capture it.
  const thinkingIdRef = useRef<string | null>(null);
  const flushStream = useCallback(() => {
    const sid = streamingIdRef.current;
    if (streamTimer.current) { clearTimeout(streamTimer.current); streamTimer.current = null; }
    if (!sid) return;
    const text = streamTextRef.current;
    streamFlushAt.current = Date.now();
    setTranscript((prev) => {
      const idx = prev.findIndex((x) => x.id === sid);
      if (idx === -1) return [...prev, { id: sid, kind: 'text', text, role: 'assistant' } as TranscriptItem];
      const cur = prev[idx] as Extract<TranscriptItem, { kind: 'text' }>;
      if (cur.text === text) return prev;
      const copy = [...prev]; copy[idx] = { ...cur, text } as TranscriptItem; return copy;
    });
  }, []);
  const flushThinking = useCallback(() => {
    const tid = thinkingIdRef.current;
    if (thinkingTimer.current) { clearTimeout(thinkingTimer.current); thinkingTimer.current = null; }
    if (!tid) return;
    const text = thinkingTextRef.current;
    thinkingFlushAt.current = Date.now();
    setTranscript((prev) => {
      const idx = prev.findIndex((x) => x.id === tid);
      if (idx === -1) return [...prev, { id: tid, kind: 'thinking', text } as TranscriptItem];
      const cur = prev[idx] as Extract<TranscriptItem, { kind: 'thinking' }>;
      if (cur.text === text) return prev;
      const copy = [...prev]; copy[idx] = { ...cur, text } as TranscriptItem; return copy;
    });
  }, []);
  const resetStream = useCallback(() => {
    streamingIdRef.current = null; streamTextRef.current = '';
    if (streamTimer.current) { clearTimeout(streamTimer.current); streamTimer.current = null; }
  }, []);
  const resetThinking = useCallback(() => {
    thinkingIdRef.current = null; thinkingTextRef.current = '';
    if (thinkingTimer.current) { clearTimeout(thinkingTimer.current); thinkingTimer.current = null; }
  }, []);
  // Flush pending tail before unmount so no trailing delta is lost.
  // (React may drop post-unmount setStates; the turn-end effect above is
  // the primary guarantee — this covers paths that unmount mid-stream.)
  useEffect(() => () => {
    flushStream();
    flushThinking();
    if (streamTimer.current) clearTimeout(streamTimer.current);
    if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
  }, [flushStream, flushThinking]);

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
  }, [grouped, plan, status.status, queuedInputs.length, expandedGroups, width]);

  const blockKeys = useMemo(() => blocks.map((b) => b.key), [blocks]);
  const blockHeights = useMemo(
    () => blocks.map((b) => cache.heightFor(b.key, b.desc, width)),
    [blocks, width, cache],
  );

  const scroll = useChatScroll({ keys: blockKeys, heights: blockHeights, viewportH, width });
  const { topRow, maxTop, pinned, pendingNew, commands, atBottom } = scroll;
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
      resetStream();
      const cmd = parseSlash(toSend.trim());
      if (cmd.kind === 'prompt') void props.onPrompt(cmd.text); else void props.onSlash(cmd);
    }
  }, [queuedInputs, status.status, awaitingApproval, resetStream]);
  useEffect(() => { if (status.status !== 'running') return; const start = Date.now() - elapsed; const t = setInterval(() => setElapsed(Date.now() - start), 1000); return () => clearInterval(t); }, [status.status, elapsed]);

  const append = useCallback((item: TranscriptItem) => {
    if (item.kind !== 'text' || item.role !== 'assistant') { flushStream(); resetStream(); }
    setTranscript((prev) => [...prev, item]);
  }, [flushStream, resetStream]);
  const appendDelta = useCallback((text: string) => {
    if (!text) return;
    if (!streamingIdRef.current) {
      const id = nextId('stream'); streamingIdRef.current = id;
      streamTextRef.current = ''; streamFlushAt.current = 0;
    }
    streamTextRef.current += text;
    const now = Date.now();
    if (now - streamFlushAt.current >= STREAM_FLUSH_MS) flushStream();
    else if (!streamTimer.current) streamTimer.current = setTimeout(flushStream, STREAM_FLUSH_MS - (now - streamFlushAt.current));
  }, [flushStream]);
  // Ephemeral reasoning display: merges into one transient item (never in
  // context/persistence); removed when the turn's answer completes.
  const appendThinkingDelta = useCallback((text: string) => {
    if (!text) return;
    if (!thinkingIdRef.current) {
      const id = nextId('thinking'); thinkingIdRef.current = id;
      thinkingTextRef.current = ''; thinkingFlushAt.current = 0;
    }
    thinkingTextRef.current += text;
    const now = Date.now();
    if (now - thinkingFlushAt.current >= STREAM_FLUSH_MS) flushThinking();
    else if (!thinkingTimer.current) thinkingTimer.current = setTimeout(flushThinking, STREAM_FLUSH_MS - (now - thinkingFlushAt.current));
  }, [flushThinking]);
  const clearThinking = useCallback(() => {
    resetThinking();
    setTranscript((prev) => (prev.some((x) => x.kind === 'thinking') ? prev.filter((x) => x.kind !== 'thinking') : prev));
  }, [resetThinking]);
  useEffect(() => {
    if (status.status !== 'running') {
      // Turn end: flush any throttled tail first so the final text is
      // complete, then drop the transient thinking block as before.
      flushStream(); resetStream();
      resetThinking();
      disarmEsc();
      // Runs that end without final_text (abort/cancel/error) must not leave
      // stale thinking blocks behind — only the response may remain.
      setTranscript((prev) => (prev.some((x) => x.kind === 'thinking') ? prev.filter((x) => x.kind !== 'thinking') : prev));
    }
  }, [status.status, flushStream, resetStream, resetThinking, disarmEsc]);
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
    resetStream();
    resetThinking();
    setTranscript([]);
    setPlan([]);
    // Fresh content → fresh scroll (a pruned anchor would otherwise stick to
    // the bottom with a stale newSinceUnstick badge count).
    scrollCmdsRef.current.reset();
  }, [resetStream, resetThinking]);
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
  // Bracketed-paste bulk insert: one atomic input append (no per-char
  // autocomplete/history side effects) with newline normalization.
  const pasteText = useCallback((text: string) => {
    insertAtCursor(text);
  }, [insertAtCursor]);
  useEffect(() => { onMountedRef.current?.({ append, appendDelta, updateStatus, updatePlan, clearTranscript, scrollLines, scrollToBottom, scrollHalfPage, scrollToTop, transcript: transcriptHandle, updateTool, appendThinkingDelta, clearThinking, pasteText, setVimMode: setVimModeLive }); (globalThis as unknown as Record<string, unknown>).__klyroAppAppend = append; (globalThis as unknown as Record<string, unknown>).__klyroAppendDelta = appendDelta; (globalThis as unknown as Record<string, unknown>).__klyroAppStatus = updateStatus; (globalThis as unknown as Record<string, unknown>).__klyroAppPlan = updatePlan; (globalThis as unknown as Record<string, unknown>).__klyroAppendThinking = appendThinkingDelta; (globalThis as unknown as Record<string, unknown>).__klyroClearThinking = clearThinking; return () => { delete (globalThis as unknown as Record<string, unknown>).__klyroAppAppend; delete (globalThis as unknown as Record<string, unknown>).__klyroAppendDelta; delete (globalThis as unknown as Record<string, unknown>).__klyroAppStatus; delete (globalThis as unknown as Record<string, unknown>).__klyroAppPlan; delete (globalThis as unknown as Record<string, unknown>).__klyroAppendThinking; delete (globalThis as unknown as Record<string, unknown>).__klyroClearThinking; }; }, [append, appendDelta, updateStatus, updatePlan, clearTranscript, scrollLines, scrollToBottom, scrollHalfPage, scrollToTop, transcriptHandle, updateTool, appendThinkingDelta, clearThinking, pasteText, setVimModeLive]);

  const toggleGroup = (id: string) => setExpandedGroups((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // `/` autocomplete — fuzzy top 6 over builtins + custom command files
  // while completing a command name (no space yet)
  const customCmds = useMemo(() => {
    try {
      return loadCustomCommands(props.cwd).map((c) => ({ name: c.name, hint: c.description || 'custom command' }));
    } catch {
      return [];
    }
  }, [props.cwd]);
  // MCP prompt stems: `/mcp__<server>__` completes server names so prompt
  // commands are discoverable; full prompt names need a live connection
  // (see `klyro mcp prompts`), so the stem carries that hint.
  const mcpStems = useMemo(() => {
    if (!input.startsWith('/mcp__')) return [];
    try {
      return Object.keys(loadMcpServers(props.cwd).servers).map((s) => ({ name: `mcp__${s}__`, hint: 'mcp server — run `mcp prompts <server>` for names' }));
    } catch {
      return [];
    }
  }, [props.cwd, input]);
  const slashSuggest = input.startsWith('/') && !input.slice(1).includes(' ') && !awaitingApproval
    ? suggestCommands(input, 6, [...customCmds, ...mcpStems])
    : [];
  // `@` file completion — fuzzy over the workspace file index while typing
  // a mention token (no space yet). Directories carry trailing `/`.
  const fileIndex = useMemo(() => {
    try {
      return listCompletableFiles(props.cwd);
    } catch {
      return [];
    }
  }, [props.cwd]);
  // @-completion now matches a mention at ANY position (mid-line included),
// not just a whole-input `^@token`. Complete-at-cursor semantics: the token
// ends at the end of input (Tab-completion surface). `foo bar @ut` completes
// just like a bare `@ut` did.
  const atToken = /(?:^|\s)@(\S*)$/.exec(input);
  const pathSuggest = atToken && !awaitingApproval
    ? suggestCommands(`/${atToken[1] ?? ''}`, 6, fileIndex.map((f) => ({ name: f, hint: 'file' }))).map((d) => ({ ...d, name: `@${d.name}` }))
    : [];

  useInput((inputStr, key) => {
    if (key.escape && queuedInputs.length > 0) { setQueuedInputs((prev) => prev.slice(1)); disarmEsc(); return; }
    // Tab completes the top slash or @-path suggestion
    if ((key.tab || inputStr === '\t') && slashSuggest.length > 0) {
      const top = slashSuggest[0]!;
      setInput(`/${top.name} `);
      setVimCursor(null);
      return;
    }
    if ((key.tab || inputStr === '\t') && pathSuggest.length > 0) {
      const top = pathSuggest[0]!;
      // Mid-line @: splice the completed filename into the mention token,
      // preserving the message prefix (`look at @ut` → `look at @util.ts`).
      const m = /(?:^|\s)@(\S*)$/.exec(input);
      if (m && m[1] !== undefined) {
        setInput(input.slice(0, input.length - m[1].length) + top.name.slice(1) + ' ');
      } else {
        setInput(`${top.name} `);
      }
      setVimCursor(null);
      return;
    }
    // Ctrl+R reverse-i-search over input history (1.4). While active, typing
    // filters newest-first, ↑/↓ (or repeated Ctrl+R) cycle matches, Enter
    // accepts into the buffer, Esc/Ctrl+C restores the saved input.
    if (histSearch && !awaitingApproval) {
      // idx into newest-first matches; -1 shows the raw query text.
      const applyQuery = (query: string, idx: number): void => {
        const m = searchMatches(query);
        const i = m.length === 0 ? -1 : Math.max(-1, Math.min(idx, m.length - 1));
        setHistSearch({ query, saved: histSearch.saved, idx: i });
        setInput(i === -1 ? query : (m[i] ?? query));
        setVimCursor(null);
      };
      if (key.escape || (key.ctrl && inputStr === 'c')) {
        setInput(histSearch.saved);
        setHistIdx(null);
        setHistSearch(null);
        setVimCursor(null);
        return;
      }
      if (key.return) { setHistSearch(null); setHistIdx(null); setVimCursor(null); return; }
      if ((key.upArrow && !key.shift && !key.ctrl) || (key.ctrl && (inputStr === 'p' || inputStr === 'r'))) {
        applyQuery(histSearch.query, histSearch.idx + 1); // older (clamped)
        return;
      }
      if ((key.downArrow && !key.shift && !key.ctrl) || (key.ctrl && inputStr === 'n')) {
        applyQuery(histSearch.query, histSearch.idx - 1); // newer, -1 → query
        return;
      }
      if (key.backspace || key.delete) {
        applyQuery(histSearch.query.slice(0, -1), 0);
        return;
      }
      if (!key.ctrl && !key.meta && inputStr) { applyQuery(histSearch.query + inputStr, 0); return; }
      return;
    }
    if (key.ctrl && inputStr === 'r' && !awaitingApproval && vimMode === 'insert') {
      setHistSearch({ query: '', saved: input, idx: -1 });
      setInput('');
      setHistIdx(null);
      setVimCursor(null);
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
      if (inputStr === ' ' && pinned && pendingNew > 0) { commands.jumpBottom(); return; } // Space → jump to unread tail
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
      insertAtCursor('\n');
      setHistIdx(null);
      return;
    }
    // Vim normal mode: motion/editing keys act on the input buffer instead
    // of typing. Return/arrows/tab/ctrl fall through to the shared logic
    // below; every other printable key is swallowed. Supports counts
    // (3h/2x), word motions (w/b), line ops (dd/D) — no operators/visual.
    if (vimMode === 'normal' && !awaitingApproval) {
      // Legacy Shift+Enter partner: an Esc that just switched modes followed
      // by Return within 75ms still means newline, not submit.
      if (key.return && input.trim() !== '' && Date.now() - escReturnAt.current < 75) {
        insertAtCursor('\n');
        setVimMode('insert');
        return;
      }
      const cur = vimCursor === null ? input.length : Math.max(0, Math.min(vimCursor, input.length));
      const move = (d: number): boolean => { setVimCursor(Math.max(0, Math.min(cur + d, input.length))); return true; };
      const isWord = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
      const wordFwd = (pos: number, n: number): number => {
        let p = pos;
        for (let k = 0; k < n && p < input.length; k++) {
          while (p < input.length && isWord(input[p]!)) p++;
          while (p < input.length && !isWord(input[p]!)) p++;
        }
        return Math.min(p, input.length);
      };
      const wordBack = (pos: number, n: number): number => {
        let p = pos;
        for (let k = 0; k < n && p > 0; k++) {
          while (p > 0 && !isWord(input[p - 1]!)) p--;
          while (p > 0 && isWord(input[p - 1]!)) p--;
        }
        return Math.max(0, p);
      };
      const takeCount = (): number => {
        const n = vimCountRef.current <= 1 ? 1 : vimCountRef.current;
        vimCountRef.current = 0;
        return n;
      };
      if (!key.ctrl && !key.meta && !key.return && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        // Pending `d` operator: second `d` deletes the current line.
        if (vimPendingOp.current === 'd') {
          vimPendingOp.current = null;
          if (inputStr === 'd') {
            const start = input.lastIndexOf('\n', cur - 1) + 1;
            const nl = input.indexOf('\n', cur);
            const end = nl === -1 ? input.length : nl + 1;
            setInput(input.slice(0, start) + input.slice(end));
            setVimCursor(Math.min(start, Math.max(0, input.slice(0, start).length)));
            setHistIdx(null);
            vimCountRef.current = 0;
            return;
          }
          // Only dd is supported — anything else cancels the operator.
          vimCountRef.current = 0;
        }
        if (inputStr === 'i') { setVimMode('insert'); setVimCursor(null); vimCountRef.current = 0; return; }
        if (inputStr === 'a') { setVimCursor(Math.min(cur + 1, input.length)); setVimMode('insert'); vimCountRef.current = 0; return; }
        if (/^[1-9]$/.test(inputStr)) { vimCountRef.current = vimCountRef.current * 10 + Number(inputStr); return; }
        if (inputStr === 'h') { const n = takeCount(); move(-n); return; }
        if (inputStr === 'l') { const n = takeCount(); move(n); return; }
        if (inputStr === '0' && vimCountRef.current === 0) { setVimCursor(0); return; }
        if (inputStr === '0') { const n = takeCount(); move(-n); return; }
        if (inputStr === '$') { takeCount(); setVimCursor(input.length); return; }
        if (inputStr === 'x') { const n = takeCount(); if (cur < input.length) setInput(input.slice(0, cur) + input.slice(cur + n)); setHistIdx(null); return; }
        if (inputStr === 'w') { const n = takeCount(); setVimCursor(wordFwd(cur, n)); return; }
        if (inputStr === 'b') { const n = takeCount(); setVimCursor(wordBack(cur, n)); return; }
        if (inputStr === 'd') { vimPendingOp.current = 'd'; vimCountRef.current = 0; return; }
        if (inputStr === 'D') {
          // Delete to end of current line (keep the newline).
          const nl = input.indexOf('\n', cur);
          const end = nl === -1 ? input.length : nl;
          setInput(input.slice(0, cur) + input.slice(end));
          setHistIdx(null);
          vimCountRef.current = 0;
          return;
        }
        if (inputStr === 'j') { if (isFullscreen && maxTop > 0) commands.lineDown(); vimCountRef.current = 0; return; }
        if (inputStr === 'k') { if (isFullscreen && maxTop > 0) commands.lineUp(); vimCountRef.current = 0; return; }
        if (key.backspace || key.delete) { move(-1); vimCountRef.current = 0; return; }
        if (key.escape) { vimCountRef.current = 0; vimPendingOp.current = null; return; } // already normal
        if (inputStr) { vimCountRef.current = 0; vimPendingOp.current = null; return; } // swallow everything else printable
      } else if (key.backspace || key.delete) {
        move(-1);
        return;
      }
    }
    // Ctrl+L (1.4): clear the input buffer if typing, else jump to the live
    // tail. Never touches the transcript — use /clear for that.
    if (key.ctrl && inputStr === 'l') {
      if (input.trim() !== '') { setInput(''); setVimCursor(null); setHistIdx(null); }
      else if (isFullscreen && maxTop > 0) { commands.jumpBottom(); }
      return;
    }
    if (status.status === 'running') {
      // design.md §18: first Ctrl+C cancels the run, second quits.
      if (key.ctrl && inputStr === 'c') {        if (!ctrlCArmed.current) {
          ctrlCArmed.current = true;
          void props.onSlash({ kind: 'cancel' });
        } else {
          void props.onSlash({ kind: 'quit' });
        }
        return;
      }
      // Esc no longer cancels on first press: with a queued item it drops
      // one; otherwise the first Esc arms and the second (≤1500ms) cancels.
      if (key.escape) {
        if (queuedInputs.length > 0) { setQueuedInputs((prev) => prev.slice(1)); disarmEsc(); return; }
        const t = Date.now();
        if (t - escArmedAt.current < 1500) {
          disarmEsc();
          void props.onSlash({ kind: 'cancel' });
        } else {
          escArmedAt.current = t;
          setEscArmed(true);
          if (escArmTimer.current) clearTimeout(escArmTimer.current);
          escArmTimer.current = setTimeout(disarmEsc, 1500);
        }
        return;
      }
      // Enter on empty input dismisses the badge (jump to bottom, §7.2)
      if (key.return) { const v = input.trim(); if (!v) { if (pinned) commands.jumpBottom(); return; } if (queuedInputs.length >= 3) return; setQueuedInputs((prev) => [...prev, v]); setInput(''); setVimCursor(null); pushHistory(v); setSubmitKey((k) => k + 1); return; }
      if (key.backspace || key.delete) { deleteBeforeCursor(); return; }
      if (!key.ctrl && !key.meta) insertAtCursor(inputStr);
      return;
    }
    // design.md §18: idle Ctrl+C exits.
    if (key.ctrl && inputStr === 'c') { void props.onSlash({ kind: 'quit' }); return; }
    // ↑/↓ are history keys, always (§8.3): ↑ browses older prompts
    // newest-first (empty history → no-op), ↓ browses back newer. Neither
    // ever scrolls the transcript — scrolling is PgUp/PgDn, Ctrl+U/D/B/F,
    // Shift+↑/↓, Home/End, Space, or the wheel. Ctrl+P /
    // Ctrl+N are escape-free aliases for the same history moves.
    const wantHistPrev = (key.upArrow && !key.shift && !key.ctrl) || (key.ctrl && inputStr === 'p');
    const wantHistNext = (key.downArrow && !key.shift && !key.ctrl) || (key.ctrl && inputStr === 'n');
    if (wantHistPrev) {
      if (history.length > 0) {
        const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(next);
        setInput(history[next] ?? '');
        setVimCursor(null);
      }
      return;
    }
    if (wantHistNext) {
      if (histIdx !== null) {
        const next = histIdx + 1;
        if (next >= history.length) { setHistIdx(null); setInput(''); }
        else { setHistIdx(next); setInput(history[next] ?? ''); }
        setVimCursor(null);
      }
      return;
    }
    // Enter on empty input dismisses the badge (jump to bottom, §7.2)
    if (key.return) { const v = input.trim(); if (!v) { if (pinned) commands.jumpBottom(); return; } setInput(''); setVimCursor(null); setHistIdx(null); pushHistory(v); setTranscript((prev) => [...prev, { id: nextId('user'), kind: 'text', text: v, role: 'user' } as TranscriptItem]); resetStream(); setSubmitKey((k) => k + 1); const cmd = parseSlash(v); if (cmd.kind === 'prompt') void props.onPrompt(cmd.text); else void props.onSlash(cmd); return; }
    if (key.backspace || key.delete) { deleteBeforeCursor(); return; }
    if (!key.ctrl && !key.meta) { insertAtCursor(inputStr); }
    // Idle Esc enters vim normal mode (vimLive parity for keyboard-only users).
    if (key.escape && vimMode === 'insert') { setVimMode('normal'); setVimCursor(inputRef.current.length); return; }
  });

  // Single source of truth: package.json via version.ts — never hardcoded.
  const ver = props.version ?? readVersion();
  // Single cost/context source: model-aware registry rates + window.
  const cost = estimateCost(status.model, status.usageInput, status.usageOutput);
  const totalTokens = status.usageInput + status.usageOutput;
  const ctxWindow = getModelInfo(status.model).contextWindow;
  const ctxPct = totalTokens > 0 ? Math.round((totalTokens / ctxWindow) * 100) : 0;
  // Narrow terminals: compact hints so the status bar never wraps mid-word.
  // An armed first-Esc surfaces here so the operator knows the second cancels.
  const baseHints = histSearch !== null
    ? `reverse-i-search \`${histSearch.query}\` · type to filter · ↑/↓ cycle · enter accept · esc cancel`
    : escArmed && status.status === 'running'
    ? 'press esc again to cancel'
    : width < 90
      ? status.status === 'running' ? 'ctrl+c stop · enter queue' : 'enter send · / commands'
      : status.status === 'running' ? 'ctrl+c to stop  ·  enter to queue  ·  ctrl+o expand' : transcript.length === 0 ? 'shift+tab to cycle  ·  ↑/↓ for history  ·  / for commands' : 'enter to send  ·  shift+enter newline  ·  @ to attach';

  // I1 structural guard:

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
                    <Text color={markerColor}>{marker} {redact(verbLine)}</Text>
                    <Text color={tokens.colors.dim as string}>  {right}</Text>
                  </Box>
                  {isExpanded ? (<>
                    {gr.items.slice(0, 12).map((it) => {
                      let friendly = '';
                      try { const a = JSON.parse(it.args) as Record<string, unknown>; const p = (a.path as string) ?? (a.pattern as string) ?? (a.command as string) ?? ''; const short = p ? String(p).split('/').pop()?.slice(0, 40) ?? p : ''; if (it.name === 'read_file' && short) friendly = `${short}`; else if (it.name === 'shell_exec' && p) friendly = `$ ${String(p).slice(0, 40)}`; else if (short) friendly = short; else friendly = it.args.slice(0, 40); } catch { friendly = it.args.slice(0, 40); }
                      return (<Box key={it.id} paddingLeft={4}><Text color={tokens.colors.guide as string}>{g('end')} </Text><Text color={tokens.colors.dim as string}>{redact(friendly)}</Text></Box>);
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
              return <Box key={it.id} marginBottom={1}><Text color={tokens.colors.accent as string} bold>{g('prompt')} </Text><Text wrap="wrap">{redact(it.text)}</Text></Box>;
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
            if (it.kind === 'thinking') return <Box key={it.id} paddingLeft={2} marginBottom={1}><Text wrap="wrap" color={tokens.colors.dim as string}>{redact(it.text)}</Text></Box>;
            if (it.kind === 'error') return <Box key={it.id} paddingLeft={2} marginBottom={1}><Text color={tokens.colors.err as string}>  {g('guide')}   {g('failure')} {redact(it.message)}</Text></Box>;
            if (it.kind === 'policy') return null;
            if (it.kind === 'file_changed') return <Box key={it.id} paddingLeft={2} marginBottom={1}><Text color={tokens.colors.dim as string}>  {g('guide')}   {g('editsBadge')} {redact(it.path)}  {it.op}</Text></Box>;
            if (it.kind === 'diff') return (
              <Box key={it.id} flexDirection="column" paddingLeft={2} marginBottom={1}>
                <Text bold color={tokens.colors.soft as string}>{it.summary ?? 'Diff'}</Text>
                {it.hunks.map((h, i) => (
                  <Box key={i} flexDirection="column" marginTop={0}>
                    <Text color={tokens.colors.soft as string}>{h.path}</Text>
                    {h.lines.map((l, j) => (
                      <Text key={j} wrap="wrap" color={l.kind === 'add' ? tokens.colors.ok as string : l.kind === 'remove' ? tokens.colors.err as string : tokens.colors.dim as string}>{l.kind === 'add' ? '+ ' : l.kind === 'remove' ? '- ' : '  '}{redact(l.text)}</Text>
                    ))}
                  </Box>
                ))}
              </Box>
            );
            return null;
          }) : null}
          {showThinking && status.status === 'running' && !streamingIdRef.current ? (
            <Box paddingLeft={2} marginBottom={1}><Text color={tokens.colors.guide as string}>  {g('guide')}   </Text><Text color={tokens.colors.accent as string}><Spinner type="dots" /> </Text><Text color={tokens.colors.dim as string}>Thinking... (esc ×2 to cancel)</Text><Text color={tokens.colors.dim as string}>  {(elapsed / 1000).toFixed(1)}s</Text></Box>
          ) : null}
          {showPlan && plan.length > 0 ? (
            <Box flexDirection="column" paddingLeft={2} marginTop={0} marginBottom={1}>
              <Box><Text color={tokens.colors.guide as string}>  {g('guide')}   </Text><Text bold>{g('todoPlan')} Plan  {plan.filter((p) => p.status === 'done').length}/{plan.length}</Text></Box>
              {plan.slice(0, 8).map((p, i) => (
                <Box key={p.id}><Text color={tokens.colors.guide as string}>  {g('guide')}   </Text><Text color={p.status === 'done' ? tokens.colors.ok as string : p.status === 'in_progress' ? tokens.colors.accent as string : tokens.colors.dim as string}>{p.status === 'done' ? g('todoDone') : p.status === 'in_progress' ? g('todoActive') : g('todoPending')} {i + 1}. {redact(p.title)}</Text></Box>
              ))}
            </Box>
          ) : null}
          {showQueued && queuedInputs.length > 0 ? (
            <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
              {queuedInputs.map((q, i) => (
                <Text key={i} color={tokens.colors.dim as string}>queued: {redact(q.slice(0, 60))}{i === 0 ? '  esc to drop' : ''}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
        {isFullscreen && !atBottom ? (
          <Box flexDirection="column" width={1} marginLeft={1}>
            {Array.from({ length: trackH }).map((_, i) => (
              <Text key={i} color={i === thumbPos ? (tokens.colors.accent as string) : (tokens.colors.guide as string)}>{i === thumbPos ? '●' : '│'}</Text>
            ))}
          </Box>
        ) : null}
      </Box>
      {pinned && badgeLabel(atBottom, pendingNew, status.status !== 'running') ? (
        <Box justifyContent="center" flexShrink={0}>
          <Text backgroundColor={tokens.colors.accentSoft as string} color={tokens.colors.accent as string} bold>
            {' '}{badgeLabel(atBottom, pendingNew, status.status !== 'running')}{' '}
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
      {slashSuggest.length === 0 && pathSuggest.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2} flexShrink={0}>
          {pathSuggest.map((s, i) => (
            <Text key={s.name} color={i === 0 ? (tokens.colors.accent as string) : (tokens.colors.dim as string)}>{i === 0 ? '▸' : ' '} {s.name}</Text>
          ))}
          <Text color={tokens.colors.dim as string}>  tab to complete</Text>
        </Box>
      ) : null}
      <ApprovalModal bridge={bridge} />
      <Box flexDirection="column" flexShrink={0}>
        <Text color={tokens.colors.guide as string}>{g('rule').repeat(Math.max(10, width - 2))}</Text>
        <Box>
          <Text color={tokens.colors.accent as string} bold>{g('prompt')} </Text>
          {vimMode === 'normal' ? <Text color={tokens.colors.warn as string} bold>--NORMAL-- </Text> : null}
          <InputWithCursor input={input} cursor={vimCursor} />
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
