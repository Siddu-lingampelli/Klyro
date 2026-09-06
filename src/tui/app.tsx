/**
 * Klyro TUI — opencode-clean — no clumsy words, correct wrap, markdown, scroll
 * Header 3 rows, guide │ at col2, ● Klyro accent, prose wrapped at word boundaries
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { StatusSnapshot } from './status.js';
import type { TranscriptItem } from './transcript.js';
import { TuiApprovalBridge } from './approval.js';
import type { PlanStep } from '../agent/runtime.js';
import { parse as parseSlash } from '../cli/slash/parser.js';
import { tokens, g } from './tokens.js';

export interface AppProps {
  initialModel: string;
  maxSteps: number;
  cwd: string;
  onPrompt: (text: string) => void | Promise<void>;
  onSlash: (cmd: import('../cli/slash/parser.js').SlashCommand) => void | Promise<void>;
  initialTranscript?: TranscriptItem[];
  initialStatus?: Partial<StatusSnapshot>;
  approvalBridge?: TuiApprovalBridge;
  onMounted?: (hooks: { append: (i: TranscriptItem) => void; appendDelta: (text: string) => void; updateStatus: (s: Partial<StatusSnapshot>) => void; updatePlan: (p: PlanStep[]) => void }) => void;
  version?: string;
  isFullscreen?: boolean;
}
let _id = 0;
function nextId(p: string): string { _id++; return `${p}-${_id}`; }

function Header({ cwd, model, version, width }: { cwd: string; model: string; version: string; width: number }) {
  const branch = (() => { try { const { execSync } = require('node:child_process') as typeof import('node:child_process'); return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore','pipe','ignore'] }).toString().trim(); } catch { return ''; } })();
  const showLinks = width >= 120;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold color={tokens.colors.accent}>KLYRO  v{version}</Text>
        {showLinks ? <Text color={tokens.colors.dim}>│  /help   /config   /clear   /exit</Text> : null}
      </Box>
      <Text color={tokens.colors.dim}>{model}[200k]  ·  API Usage Billing</Text>
      <Text color={tokens.colors.dim}>{cwd}{branch ? `  ·  ${branch}` : ''}</Text>
    </Box>
  );
}

type Verb = 'Read' | 'Listed' | 'Searched' | 'Ran' | 'Edited' | 'Created' | 'Checked git' | 'Fetched' | 'Searched web' | 'Called';
function verbForTool(name: string): Verb {
  if (name === 'read_file') return 'Read' as Verb;
  if (name === 'list_directory') return 'Listed' as Verb;
  if (name === 'grep' || name === 'glob' || name === 'find_files' || name === 'search_files' || name === 'recent_files') return 'Searched' as Verb;
  if (name === 'shell_exec') return 'Ran' as Verb;
  if (name.startsWith('git_')) return 'Checked git' as Verb;
  if (name === 'web_fetch') return 'Fetched' as Verb;
  if (name === 'web_search') return 'Searched web' as Verb;
  if (name === 'edit_file' || name === 'multi_edit' || name === 'apply_patch' || name === 'write_file') return 'Edited' as Verb;
  return 'Called' as Verb;
}
interface Group { id: string; verb: Verb; items: Extract<TranscriptItem, { kind: 'tool' }>[]; totalMs: number; status: 'running' | 'done' | 'error'; }
function groupTools(items: TranscriptItem[]): Array<TranscriptItem | Group> {
  const out: Array<TranscriptItem | Group> = [];
  let cur: Extract<TranscriptItem, { kind: 'tool' }>[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const byVerb = new Map<Verb, typeof cur>();
    for (const it of cur) { const v = verbForTool(it.name); if (!byVerb.has(v)) byVerb.set(v, []); byVerb.get(v)!.push(it); }
    for (const [verb, list] of byVerb) {
      const totalMs = list.reduce((s, x) => s + (x.latencyMs ?? 0), 0);
      const status = list.some((x) => x.isError || x.status === 'error') ? 'error' as const : list.some((x) => x.status === 'running') ? 'running' as const : 'done' as const;
      out.push({ id: nextId('g'), verb, items: list, totalMs, status });
    }
    cur = [];
  };
  for (const it of items) { if (it.kind === 'tool') cur.push(it as Extract<TranscriptItem, { kind: 'tool' }>); else { flush(); out.push(it); } }
  flush(); return out;
}

// Simple markdown: **bold** → bold, keep lists/tables, wrap at word boundaries
function MarkdownText({ text, dim, width }: { text: string; dim?: boolean; width?: number }) {
  // Split by **bold** segments
  const parts: React.ReactNode[] = [];
  let last = 0;
  const re = /\*\*(.+?)\*\*/g;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Text key={`t-${idx++}`} color={dim ? tokens.colors.dim as string : undefined} wrap="wrap">{text.slice(last, m.index)}</Text>);
    parts.push(<Text key={`b-${idx++}`} bold color={dim ? undefined : tokens.colors.soft as string} wrap="wrap">{m[1]}</Text>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<Text key={`t-${idx++}`} color={dim ? tokens.colors.dim as string : undefined} wrap="wrap">{text.slice(last)}</Text>);
  if (parts.length === 0) return <Text color={dim ? tokens.colors.dim as string : undefined} wrap="wrap">{text}</Text>;
  // Render as single line with bold segments — Ink will wrap the parent Box
  return <Text wrap="wrap">{parts}</Text>;
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
  const [scrollOffset, setScrollOffset] = useState(0);
  const streamingIdRef = useRef<string | null>(null);

  const width = stdout?.columns ?? 100;
  const height = stdout?.rows ?? 30;
  const isFullscreen = props.isFullscreen ?? false;
  const grouped = groupTools(transcript);
  const viewportH = Math.max(5, height - 10);
  const estLines = (s: string) => Math.max(1, Math.ceil(s.length / Math.max(20, width - 6)));
  const totalRows = grouped.reduce((sum, it) => {
    if ((it as Group).verb) return sum + 1 + (((it as Group).items.length > 1 && expandedGroups.has((it as Group).id)) ? (it as Group).items.length : 0);
    const t = it as TranscriptItem;
    if (t.kind === 'text') return sum + estLines(t.text) + 1;
    return sum + 2;
  }, 0) + (plan.length > 0 ? plan.length + 1 : 0) + 2;
  const maxOffset = Math.max(0, totalRows - viewportH);
  const isAtBottom = scrollOffset >= maxOffset;
  const trackH = viewportH;
  const thumbPos = maxOffset === 0 ? 0 : Math.round((scrollOffset / maxOffset) * (trackH - 1));
  const visibleGrouped = isFullscreen ? grouped.slice(scrollOffset, scrollOffset + viewportH) : grouped;

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
  useEffect(() => { if (isAtBottom) setScrollOffset(maxOffset); }, [transcript.length, plan.length, maxOffset, isAtBottom]);

  const append = useCallback((item: TranscriptItem) => { if (item.kind !== 'text' || item.role !== 'assistant') streamingIdRef.current = null; setTranscript((prev) => [...prev, item]); }, []);
  const appendDelta = useCallback((text: string) => {
    if (!text) return; const sid = streamingIdRef.current;
    if (sid) setTranscript((prev) => { const idx = prev.findIndex((x) => x.id === sid); if (idx === -1) return [...prev, { id: sid, kind: 'text', text, role: 'assistant' } as TranscriptItem]; const cur = prev[idx] as Extract<TranscriptItem, { kind: 'text' }>; const copy = [...prev]; copy[idx] = { ...cur, text: cur.text + text } as TranscriptItem; return copy; });
    else { const id = nextId('stream'); streamingIdRef.current = id; setTranscript((prev) => [...prev, { id, kind: 'text', text, role: 'assistant' } as TranscriptItem]); }
  }, []);
  useEffect(() => { if (status.status !== 'running') streamingIdRef.current = null; }, [status.status]);
  const updateStatus = useCallback((s: Partial<StatusSnapshot>) => setStatus((p) => ({ ...p, ...s })), []);
  const updatePlan = useCallback((p: PlanStep[]) => setPlan(p), []);
  const onMountedRef = useRef(props.onMounted);
  useEffect(() => { onMountedRef.current = props.onMounted; }, [props.onMounted]);
  useEffect(() => { onMountedRef.current?.({ append, appendDelta, updateStatus, updatePlan }); (globalThis as unknown as Record<string, unknown>).__klyroAppAppend = append; (globalThis as unknown as Record<string, unknown>).__klyroAppendDelta = appendDelta; (globalThis as unknown as Record<string, unknown>).__klyroAppStatus = updateStatus; (globalThis as unknown as Record<string, unknown>).__klyroAppPlan = updatePlan; return () => { delete (globalThis as unknown as Record<string, unknown>).__klyroAppAppend; delete (globalThis as unknown as Record<string, unknown>).__klyroAppendDelta; delete (globalThis as unknown as Record<string, unknown>).__klyroAppStatus; delete (globalThis as unknown as Record<string, unknown>).__klyroAppPlan; }; }, [append, appendDelta, updateStatus, updatePlan]);

  const toggleGroup = (id: string) => setExpandedGroups((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const scrollUp = (n = 3) => setScrollOffset((p) => Math.max(0, p - n));
  const scrollDown = (n = 3) => setScrollOffset((p) => Math.min(maxOffset, p + n));

  useInput((inputStr, key) => {
    if (key.escape && queuedInputs.length > 0) { setQueuedInputs((prev) => prev.slice(1)); return; }
    if (key.pageUp || (key.ctrl && inputStr === 'u')) { scrollUp(5); return; }
    if (key.pageDown || (key.ctrl && inputStr === 'd')) { scrollDown(5); return; }
    if (key.upArrow && (key.shift || key.ctrl)) { scrollUp(1); return; }
    if (key.downArrow && (key.shift || key.ctrl)) { scrollDown(1); return; }
    if (awaitingApproval) return;
    if (key.ctrl && inputStr === 'o') { const groups = grouped.filter((x): x is Group => typeof (x as Group).verb === 'string'); const last = groups[groups.length - 1]; if (last) toggleGroup(last.id); return; }
    if (status.status === 'running') {
      if (key.ctrl && inputStr === 'c') { void props.onSlash({ kind: 'quit' }); return; }
      if (key.return) { const v = input.trim(); if (!v) return; if (queuedInputs.length >= 3) return; setQueuedInputs((prev) => [...prev, v]); setInput(''); return; }
      if (key.backspace || key.delete) { setInput((v) => v.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta) setInput((v) => v + inputStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
      return;
    }
    if (key.return) { const v = input.trim(); if (!v) return; setInput(''); setTranscript((prev) => [...prev, { id: nextId('user'), kind: 'text', text: v, role: 'user' } as TranscriptItem]); streamingIdRef.current = null; const cmd = parseSlash(v); if (cmd.kind === 'prompt') void props.onPrompt(cmd.text); else void props.onSlash(cmd); return; }
    if (key.backspace || key.delete) { setInput((v) => v.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta) setInput((v) => v + inputStr);
  });

  const ver = props.version ?? '0.1.27';
  const rule = g('rule').repeat(Math.max(10, width - 2));
  const cost = (status.usageInput / 1000 * 0.003 + status.usageOutput / 1000 * 0.015);
  const totalTokens = status.usageInput + status.usageOutput;
  const ctxPct = totalTokens > 0 ? Math.round((totalTokens / 120_000) * 100) : 0;
  const baseHints = status.status === 'running' ? 'ctrl+c to stop  ·  enter to queue  ·  ctrl+o expand' : transcript.length === 0 ? 'shift+tab to cycle  ·  ↑↓ for history  ·  / for commands' : 'enter to send  ·  shift+enter newline  ·  @ to attach';
  const hints = maxOffset > 0 && isFullscreen ? `${baseHints}  ·  PgUp/Dn scroll` : baseHints;

  return (
    <Box flexDirection="column" width={width} height={isFullscreen ? height - 1 : undefined}>
      <Header cwd={props.cwd} model={status.model} version={ver} width={width} />
      <Box flexDirection="row" flexGrow={isFullscreen ? 1 : 0} overflow={isFullscreen ? 'hidden' : undefined}>
        <Box flexDirection="column" flexGrow={1} overflow={isFullscreen ? 'hidden' : undefined} paddingX={0}>
          {grouped.length === 0 ? (
            <Text color={tokens.colors.dim as string}>Message Klyro…</Text>
          ) : visibleGrouped.map((item) => {
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
              const right = gr.status === 'running' ? `${(elapsed / 1000).toFixed(1)}s` : gr.status === 'error' ? '✗' : `${gr.totalMs}ms`;
              const marker = isExpanded ? '▼' : '✓';
              const markerColor = gr.status === 'error' ? tokens.colors.err as string : gr.status === 'running' ? tokens.colors.warn as string : tokens.colors.ok as string;
              return (
                <Box key={gr.id} flexDirection="column" marginBottom={1}>
                  <Box>
                    <Text color={tokens.colors.guide}>  {g('guide')}   </Text>
                    <Text color={markerColor}>{marker} {verbLine}</Text>
                    <Text color={tokens.colors.dim}>  {right}</Text>
                  </Box>
                  {isExpanded ? gr.items.map((it) => {
                    let friendly = '';
                    try { const a = JSON.parse(it.args) as Record<string, unknown>; const p = (a.path as string) ?? (a.pattern as string) ?? (a.command as string) ?? ''; const short = p ? String(p).split('/').pop()?.slice(0, 40) ?? p : ''; if (it.name === 'read_file' && short) friendly = `${short}`; else if (it.name === 'shell_exec' && p) friendly = `$ ${String(p).slice(0, 40)}`; else if (short) friendly = short; else friendly = it.args.slice(0, 40); } catch { friendly = it.args.slice(0, 40); }
                    return (<Box key={it.id} paddingLeft={4}><Text color={tokens.colors.guide as string}>{g('end')} </Text><Text color={tokens.colors.dim as string}>{friendly}</Text></Box>);
                  }) : null}
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
            if (it.kind === 'error') return <Box key={it.id} paddingLeft={2} marginBottom={1}><Text color={tokens.colors.err as string}>  {g('guide')}   ✗ {it.message}</Text></Box>;
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
          })}
          {status.status === 'running' && !streamingIdRef.current ? (
            <Box paddingLeft={2} marginBottom={1}><Text color={tokens.colors.guide as string}>  {g('guide')}   </Text><Text color={tokens.colors.dim as string}>Thinking...</Text><Text color={tokens.colors.dim as string}>  {(elapsed / 1000).toFixed(1)}s</Text></Box>
          ) : null}
          {plan.length > 0 ? (
            <Box flexDirection="column" paddingLeft={2} marginTop={0} marginBottom={1}>
              <Box><Text color={tokens.colors.guide as string}>  {g('guide')}   </Text><Text bold>{g('todoPlan')} Plan  {plan.filter((p) => p.status === 'done').length}/{plan.length}</Text></Box>
              {plan.slice(0, 8).map((p) => (
                <Box key={p.id}><Text color={tokens.colors.guide as string}>  {g('guide')}   </Text><Text color={p.status === 'done' ? tokens.colors.ok as string : p.status === 'in_progress' ? tokens.colors.accent as string : tokens.colors.dim as string}>{p.status === 'done' ? g('todoDone') : p.status === 'in_progress' ? g('todoActive') : g('todoPending')} {p.title}</Text></Box>
              ))}
            </Box>
          ) : null}
          {queuedInputs.length > 0 ? (
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
      <Box flexDirection="column">
        <Text color={tokens.colors.guide as string}>{g('rule').repeat(Math.max(10, width - 2))}</Text>
        <Box>
          <Text color={tokens.colors.accent as string} bold>{g('prompt')} </Text>
          <Text wrap="wrap">{input || <Text color={tokens.colors.dim as string}>Message Klyro…</Text> as unknown as string}▏</Text>
        </Box>
        <Text color={tokens.colors.guide as string}>{g('rule').repeat(Math.max(10, width - 2))}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={tokens.colors.dim as string}>{baseHints}{maxOffset > 0 && isFullscreen ? '  ·  PgUp/Dn scroll' : ''}</Text>
        <Text color={tokens.colors.dim as string}>{cost > 0 ? `$${cost.toFixed(2)} · ` : ''}{ctxPct > 0 ? `${ctxPct}% ctx · ` : ''}{status.status === 'running' ? 'auto mode on ●' : ''}</Text>
      </Box>
    </Box>
  );
}
