/**
 * Klyro TUI — design.md Claude Code-like — White & Orange #FF6B1A — 3 columns
 * Top bar + Sidebar 28 + Chat flex + Inspector 36 + Prompt — per plan 1-10
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
  initialModel: string; maxSteps: number; cwd: string;
  onPrompt: (text: string) => void | Promise<void>;
  onSlash: (cmd: import('../cli/slash/parser.js').SlashCommand) => void | Promise<void>;
  initialTranscript?: TranscriptItem[]; initialStatus?: Partial<StatusSnapshot>;
  approvalBridge?: TuiApprovalBridge;
  onMounted?: (hooks: { append: (i: TranscriptItem) => void; appendDelta: (text: string) => void; updateStatus: (s: Partial<StatusSnapshot>) => void; updatePlan: (p: PlanStep[]) => void }) => void;
  version?: string; isFullscreen?: boolean;
}
let _id = 0; function nextId(p: string): string { _id++; return `${p}-${_id}`; }

// Top bar §3
function TopBar({ width, cwd, model }: { width: number; cwd: string; model: string }) {
  const branch = (() => { try { const { execSync } = require('node:child_process') as typeof import('node:child_process'); return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore','pipe','ignore'] }).toString().trim(); } catch { return 'main'; } })();
  const showFull = width >= 120;
  return (
    <Box width={width} justifyContent="space-between" borderStyle="single" borderColor={tokens.colors.border} paddingX={1}>
      <Box>
        <Text color={tokens.colors.orange} bold>{g('logoBar')} claude-code</Text>
        <Text color={tokens.colors.fgDim}> │ {branch} │</Text>
        <Text color={tokens.colors.orange}> ◉ 3 sessions </Text>
        <Text color={tokens.colors.fgDim}>│ ⌘ palette │ ? help</Text>
      </Box>
      <Box>
        {showFull ? <Text color={tokens.colors.orange}>●●● ●●  </Text> : null}
        <Text color={tokens.colors.fgDim}>⊞ ▢</Text>
      </Box>
    </Box>
  );
}

// Sidebar §4
function Sidebar({ width }: { width: number }) {
  if (width < 60) return null;
  const w = Math.min(28, Math.floor(width * 0.22));
  return (
    <Box flexDirection="column" width={w} borderStyle="single" borderColor={tokens.colors.border} paddingX={1} marginRight={1}>
      <Text bold color={tokens.colors.fg}>▾ Sessions</Text>
      <Text color={tokens.colors.orange}>◉ Build auth flow     <Text color={tokens.colors.fgDim}>2m</Text></Text>
      <Text color={tokens.colors.fgDim}>○ Refactor parser    12m</Text>
      <Text color={tokens.colors.fgDim}>○ Fix bug #42        1h</Text>
      <Box marginTop={1}><Text bold color={tokens.colors.fg}>▸ Files</Text></Box>
      <Text color={tokens.colors.fgDim}>▸ Agents</Text>
      <Text color={tokens.colors.fgDim}>▸ MCP</Text>
      <Text color={tokens.colors.fgDim}>▸ Hooks</Text>
      <Box marginTop={1}><Text color={tokens.colors.orange}>[+ new]</Text></Box>
    </Box>
  );
}

// Inspector §6
function Inspector({ width }: { width: number }) {
  if (width < 80) return null;
  const w = 36;
  return (
    <Box flexDirection="column" width={w} borderStyle="single" borderColor={tokens.colors.border} paddingX={1} marginLeft={1}>
      <Text bold color={tokens.colors.fg}>Inspector · Tools</Text>
      <Text color={tokens.colors.success}>✓ edit_file   src/routes.rs</Text>
      <Text color={tokens.colors.fgDim}>  +12 / -3     0.3s</Text>
      <Text>─────────────────────────</Text>
      <Text color={tokens.colors.success}>✓ read_file   Cargo.toml</Text>
      <Text color={tokens.colors.fgDim}>  890 bytes    0.1s</Text>
      <Text>─────────────────────────</Text>
      <Text color={tokens.colors.warning}>⏳ bash       cargo test</Text>
      <Text color={tokens.colors.fgDim}>  running...    2.1s</Text>
    </Box>
  );
}

// Chat bubbles §5.1-5.4
function MarkdownText({ text }: { text: string }) {
  // minimal: **bold** → bold, keep rest
  const parts: React.ReactNode[] = [];
  let last = 0; const re = /\*\*(.+?)\*\*/g; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Text key={`t-${i++}`} wrap="wrap">{text.slice(last, m.index)}</Text>);
    parts.push(<Text key={`b-${i++}`} bold wrap="wrap">{m[1]}</Text>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<Text key={`t-${i++}`} wrap="wrap">{text.slice(last)}</Text>);
  return <Text wrap="wrap">{parts.length ? parts : text}</Text>;
}

type Verb = 'Read' | 'Listed' | 'Searched' | 'Ran' | 'Edited' | 'Created' | 'Checked git' | 'Fetched' | 'Searched web' | 'Called';
function verbForTool(n: string): Verb {
  if (n === 'read_file') return 'Read' as Verb;
  if (n === 'list_directory') return 'Listed' as Verb;
  if (n === 'grep' || n === 'glob' || n.includes('search')) return 'Searched' as Verb;
  if (n === 'shell_exec') return 'Ran' as Verb;
  if (n.startsWith('git_')) return 'Checked git' as Verb;
  if (n === 'edit_file' || n.includes('edit') || n.includes('write')) return 'Edited' as Verb;
  return 'Called' as Verb;
}
interface Group { id: string; verb: Verb; items: Extract<TranscriptItem, { kind: 'tool' }>[]; totalMs: number; status: 'running'|'done'|'error'; }
function groupTools(items: TranscriptItem[]): Array<TranscriptItem | Group> {
  const out: Array<TranscriptItem | Group> = []; let cur: Extract<TranscriptItem, { kind: 'tool' }>[] = [];
  const flush = () => {
    if (!cur.length) return;
    const byVerb = new Map<Verb, typeof cur>();
    for (const it of cur) { const v = verbForTool(it.name); if (!byVerb.has(v)) byVerb.set(v, []); byVerb.get(v)!.push(it); }
    for (const [verb, list] of byVerb) {
      const totalMs = list.reduce((s, x) => s + (x.latencyMs ?? 0), 0);
      const status = list.some(x=>x.isError||x.status==='error')?'error' as const:list.some(x=>x.status==='running')?'running' as const:'done' as const;
      out.push({ id: nextId('g'), verb, items: list, totalMs, status });
    }
    cur = [];
  };
  for (const it of items) { if (it.kind==='tool') cur.push(it as any); else { flush(); out.push(it); } }
  flush(); return out;
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
  const streamingIdRef = useRef<string|null>(null);
  const width = stdout?.columns ?? 120;
  const height = stdout?.rows ?? 30;
  const isFullscreen = props.isFullscreen ?? false;
  const grouped = groupTools(transcript);
  const viewportH = Math.max(5, height - 10);
  const totalRows = grouped.reduce((s,it) => s + ((it as Group).verb ? 1 + ((it as Group).items.length>1 && expandedGroups.has((it as Group).id) ? (it as Group).items.length : 0) : 2), 0) + (plan.length?1:0) + 2;
  const maxOffset = Math.max(0, totalRows - viewportH);
  const trackH = viewportH;
  const thumbPos = maxOffset===0?0:Math.round(scrollOffset/maxOffset*(trackH-1));
  const visibleGrouped = isFullscreen ? grouped.slice(scrollOffset, scrollOffset+viewportH) : grouped;
  const placeholder = 'Message Klyro…';

  useEffect(()=>bridge.subscribe(p=>setAwaitingApproval(p!==null)),[bridge]);
  useEffect(()=>{ if(queuedInputs.length>0 && status.status!=='running' && !awaitingApproval){ const toSend=queuedInputs[0]!; setQueuedInputs(p=>p.slice(1)); setTranscript(p=>[...p,{id:nextId('user'),kind:'text',text:toSend,role:'user'} as TranscriptItem]); streamingIdRef.current=null; const cmd=parseSlash(toSend.trim()); if(cmd.kind==='prompt') void props.onPrompt(cmd.text); else void props.onSlash(cmd); } },[queuedInputs,status.status,awaitingApproval]);
  useEffect(()=>{ if(status.status!=='running') return; const start=Date.now()-elapsed; const t=setInterval(()=>setElapsed(Date.now()-start),1000); return()=>clearInterval(t); },[status.status,elapsed]);
  useEffect(()=>{ if(scrollOffset>=maxOffset) setScrollOffset(maxOffset); },[transcript.length,plan.length,maxOffset]);
  const append=useCallback((item:TranscriptItem)=>{ if(item.kind!=='text'||item.role!=='assistant') streamingIdRef.current=null; setTranscript(p=>[...p,item]); },[]);
  const appendDelta=useCallback((text:string)=>{ if(!text) return; const sid=streamingIdRef.current; if(sid) setTranscript(p=>{ const idx=p.findIndex(x=>x.id===sid); if(idx===-1) return [...p,{id:sid,kind:'text',text,role:'assistant'} as TranscriptItem]; const cur=p[idx] as Extract<TranscriptItem,{kind:'text'}>; const copy=[...p]; copy[idx]={...cur,text:cur.text+text} as TranscriptItem; return copy; }); else { const id=nextId('stream'); streamingIdRef.current=id; setTranscript(p=>[...p,{id,kind:'text',text,role:'assistant'} as TranscriptItem]); } },[]);
  useEffect(()=>{ if(status.status!=='running') streamingIdRef.current=null; },[status.status]);
  const updateStatus=useCallback((s:Partial<StatusSnapshot>)=>setStatus(p=>({...p,...s})),[]);
  const updatePlan=useCallback((p:PlanStep[])=>setPlan(p),[]);
  const onMountedRef=useRef(props.onMounted); useEffect(()=>{onMountedRef.current=props.onMounted},[props.onMounted]);
  useEffect(()=>{ onMountedRef.current?.({append,appendDelta,updateStatus,updatePlan}); (globalThis as any).__klyroAppAppend=append; (globalThis as any).__klyroAppendDelta=appendDelta; (globalThis as any).__klyroAppStatus=updateStatus; (globalThis as any).__klyroAppPlan=updatePlan; return()=>{ delete (globalThis as any).__klyroAppAppend; delete (globalThis as any).__klyroAppendDelta; delete (globalThis as any).__klyroAppStatus; delete (globalThis as any).__klyroAppPlan; }; },[append,appendDelta,updateStatus,updatePlan]);
  const toggleGroup=(id:string)=>setExpandedGroups(p=>{ const n=new Set(p); if(n.has(id)) n.delete(id); else n.add(id); return n; });
  const scrollUp=(n=3)=>setScrollOffset(p=>Math.max(0,p-n)); const scrollDown=(n=3)=>setScrollOffset(p=>Math.min(maxOffset,p+n));

  useInput((inputStr,key)=>{
    if(key.escape && queuedInputs.length>0){ setQueuedInputs(p=>p.slice(1)); return; }
    if(key.pageUp || (key.ctrl && inputStr==='u')){ scrollUp(5); return; }
    if(key.pageDown || (key.ctrl && inputStr==='d')){ scrollDown(5); return; }
    if(key.upArrow && (key.shift||key.ctrl)){ scrollUp(1); return; }
    if(key.downArrow && (key.shift||key.ctrl)){ scrollDown(1); return; }
    if(awaitingApproval) return;
    if(key.ctrl && inputStr==='o'){ const groups=grouped.filter((x):x is Group=>typeof (x as Group).verb==='string'); const last=groups[groups.length-1]; if(last) toggleGroup(last.id); return; }
    if(status.status==='running'){
      if(key.ctrl && inputStr==='c'){ void props.onSlash({kind:'quit'}); return; }
      if(key.return){ const v=input.trim(); if(!v) return; if(queuedInputs.length>=3) return; setQueuedInputs(p=>[...p,v]); setInput(''); return; }
      if(key.backspace||key.delete){ setInput(v=>v.slice(0,-1)); return; }
      if(!key.ctrl&&!key.meta) setInput(v=>v+inputStr.replace(/\r\n/g,'\n').replace(/\r/g,'\n'));
      return;
    }
    if(key.return){ const v=input.trim(); if(!v) return; setInput(''); setTranscript(p=>[...p,{id:nextId('user'),kind:'text',text:v,role:'user'} as TranscriptItem]); streamingIdRef.current=null; const cmd=parseSlash(v); if(cmd.kind==='prompt') void props.onPrompt(cmd.text); else void props.onSlash(cmd); return; }
    if(key.backspace||key.delete){ setInput(v=>v.slice(0,-1)); return; }
    if(!key.ctrl&&!key.meta) setInput(v=>v+inputStr);
  });

  const ver=props.version ?? '0.1.36';
  const rule='─'.repeat(Math.max(10,width-2));
  const cost=(status.usageInput/1000*0.003+status.usageOutput/1000*0.015);
  const ctxPct=status.usageInput+status.usageOutput>0?Math.round((status.usageInput+status.usageOutput)/120_000*100):0;
  const hints= maxOffset>0 && isFullscreen ? 'PgUp/Dn scroll  ·  ' : '' + (status.status==='running' ? 'ctrl+c to stop  ·  enter to queue  ·  ctrl+o expand' : transcript.length===0 ? 'shift+tab to cycle  ·  ↑↓ for history  ·  / for commands' : 'enter to send  ·  shift+enter newline  ·  @ to attach');

  return (
    <Box flexDirection="column" width={width} height={isFullscreen?height-1:undefined}>
      <TopBar width={width} cwd={props.cwd} model={status.model} />
      <Box flexDirection="row" flexGrow={isFullscreen?1:0} overflow={isFullscreen?'hidden':undefined}>
        <Sidebar width={width} />
        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor={tokens.colors.border} paddingX={1} overflow={isFullscreen?'hidden':undefined}>
          {grouped.length===0 ? <Text color={tokens.colors.fgDim}>Message Klyro…</Text> : visibleGrouped.map(item=>{
            if((item as Group).verb){
              const gr=item as Group; const isExpanded=expandedGroups.has(gr.id);
              const verbLine=(()=>{ if(gr.items.length===1){ const it=gr.items[0]!; let p=''; try{ const a=JSON.parse(it.args) as Record<string,unknown>; p=(a.path as string)??(a.pattern as string)??(a.command as string)?.slice(0,48)??''; }catch{} if(gr.verb==='Read'&&p) return `Read ${p.split('/').pop()}`; if(gr.verb==='Searched'&&p) return `Searched "${p}"`; if(gr.verb==='Ran'&&p) return `Ran ${p.split(' ')[0]}`; return `${gr.verb} ${p}`; } if(gr.verb==='Read') return `Read ${gr.items.length} files`; if(gr.verb==='Searched') return `Searched ${gr.items.length} patterns`; if(gr.verb==='Ran') return `Ran ${gr.items.length} commands`; return `${gr.verb} ${gr.items.length} items`; })();
              const right=gr.status==='running'?`${(elapsed/1000).toFixed(1)}s`:gr.status==='error'?'✗':`${gr.totalMs}ms`;
              const marker=isExpanded?'▼':'✓'; const markerColor=gr.status==='error'?tokens.colors.danger:gr.status==='running'?tokens.colors.orange:tokens.colors.success;
              return (
                <Box key={gr.id} flexDirection="column" marginBottom={1} borderStyle="single" borderColor={tokens.colors.border} paddingX={1}>
                  <Box justifyContent="space-between">
                    <Text color={markerColor}>{marker} {verbLine}</Text>
                    <Text color={tokens.colors.fgDim}>{right}</Text>
                  </Box>
                  {isExpanded?gr.items.map(it=>{
                    let friendly=''; try{ const a=JSON.parse(it.args) as Record<string,unknown>; const p=(a.path as string)??''; friendly=p ? p.split('/').pop()??p : it.args.slice(0,40);}catch{friendly=it.args.slice(0,40)}
                    return <Box key={it.id} paddingLeft={1}><Text color={tokens.colors.fgDim}>└ {friendly}</Text></Box>;
                  }):null}
                </Box>
              );
            }
            const it=item as TranscriptItem;
            if(it.kind==='text' && it.role==='user'){
              return <Box key={it.id} flexDirection="column" marginBottom={1} borderStyle="single" borderColor={tokens.colors.border} paddingX={1}><Text color={tokens.colors.fgMuted}>You</Text><Text wrap="wrap">{it.text}</Text></Box>;
            }
            if(it.kind==='text'){
              return (
                <Box key={it.id} flexDirection="column" marginBottom={1} borderStyle="single" borderColor={tokens.colors.orangeSoft} paddingX={1} borderLeftColor={tokens.colors.orange}>
                  <Box><Text bold color={tokens.colors.orange}>Claude</Text><Text color={tokens.colors.fgDim}> · {status.model} {status.status==='running'&&!streamingIdRef.current ? '◯ thinking' : ''}</Text></Box>
                  <Box marginTop={1}><MarkdownText text={it.text} /></Box>
                </Box>
              );
            }
            if(it.kind==='error') return <Box key={it.id} borderStyle="single" borderColor={tokens.colors.danger} paddingX={1} marginBottom={1}><Text color={tokens.colors.danger}>✗ {it.message}</Text></Box>;
            if(it.kind==='policy') return null;
            if(it.kind==='file_changed') return <Box key={it.id} borderStyle="single" borderColor={tokens.colors.border} paddingX={1} marginBottom={1}><Text color={tokens.colors.fgDim}>✎ {it.path}  {it.op}</Text></Box>;
            if(it.kind==='diff') return <Box key={it.id} borderStyle="single" borderColor={tokens.colors.border} paddingX={1} marginBottom={1}><Text bold>{it.summary}</Text>{it.hunks.map((h,i)=><Box key={i} flexDirection="column"><Text color={tokens.colors.fg}>{h.path}</Text>{h.lines.map((l,j)=><Text key={j} wrap="wrap" color={l.kind==='add'?tokens.colors.success:l.kind==='remove'?tokens.colors.danger:tokens.colors.fgDim}>{l.kind==='add'?"+ ":l.kind==='remove'?"- ":"  "}{l.text}</Text>)}</Box>)}</Box>;
            return null;
          })}
          {status.status==='running'&&!streamingIdRef.current ? <Box borderStyle="single" borderColor={tokens.colors.orangeSoft} paddingX={1} marginBottom={1}><Text color={tokens.colors.orange}>◯ thinking {(elapsed/1000).toFixed(1)}s</Text></Box> : null}
          {plan.length>0 ? <Box flexDirection="column" borderStyle="single" borderColor={tokens.colors.border} paddingX={1} marginBottom={1}><Text bold>◇ Plan {plan.filter(p=>p.status==='done').length}/{plan.length}</Text>{plan.slice(0,8).map(p=><Text key={p.id} color={p.status==='done'?tokens.colors.success:p.status==='in_progress'?tokens.colors.orange:tokens.colors.fgDim}>{p.status==='done'?'✓':p.status==='in_progress'?'●':'○'} {p.title}</Text>)}</Box> : null}
          {queuedInputs.length>0 ? <Box flexDirection="column" paddingX={1} marginBottom={1}>{queuedInputs.map((q,i)=><Text key={i} color={tokens.colors.fgDim}>queued: {q.slice(0,60)}{i===0?'  esc to drop':''}</Text>)}</Box> : null}
        </Box>
        <Inspector width={width} />
        {isFullscreen ? <Box flexDirection="column" width={1} marginLeft={1}>{Array.from({length:trackH}).map((_,i)=><Text key={i} color={i===thumbPos?tokens.colors.orange:tokens.colors.border}>{i===thumbPos?'●':'│'}</Text>)}</Box> : null}
      </Box>
      <Box flexDirection="column" borderStyle="single" borderColor={tokens.colors.border} paddingX={1}>
        <Box><Text color={tokens.colors.orange}>▌ </Text><Text wrap="wrap">{input || <Text color={tokens.colors.fgDim}>Type a message…  ⏎ send  ⇧⏎ newline  /</Text> as unknown as string}▏</Text></Box>
      </Box>
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={tokens.colors.fgDim}>{hints}</Text>
        <Text color={tokens.colors.fgDim}>{cost>0?`$${cost.toFixed(2)} · `:''}{ctxPct>0?`${ctxPct}% `:' '}<Text color={tokens.colors.orange}>●●● ●●</Text></Text>
      </Box>
    </Box>
  );
}
