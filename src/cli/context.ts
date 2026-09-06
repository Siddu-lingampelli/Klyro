/**
 * 8.5 — /context inspector + compaction notice UI + context meter
 */
import { accounting, contextMeter } from '../context/accounting.js';
import { totalTokens, estimateTokens } from '../context/tokenizer.js';
import type { Message } from '../agent/message.js';

export function renderContextBreakdown(system: string | undefined, messages: Message[]): string {
  const acc = accounting(system, messages);
  const byCat = new Map<string, number>();
  byCat.set('system prompt', system ? estimateTokens(system) : 0);
  // estimate tools/map/KLYRO as part of system already
  let msgTokens = 0;
  for (const m of messages) msgTokens += totalTokens(undefined, [m]);
  byCat.set('messages', msgTokens);
  const largest = [...messages].map((m) => ({ m, t: totalTokens(undefined, [m]) })).sort((a, b) => b.t - a.t).slice(0, 3);
  const lines: string[] = [];
  lines.push(`context  ${acc.pct}%  ${contextMeter(acc.pct)}  ${acc.used.toLocaleString()} / ${acc.cap.toLocaleString()}        compact at ${Math.round(acc.compactAt * 100)}%`);
  lines.push(`  reserve ${acc.reserveOutput.toLocaleString()} output`);
  lines.push('');
  for (const [k, v] of byCat) lines.push(`${k.padEnd(24)} ${v.toLocaleString().padStart(7)}  ${Math.round((v / acc.cap) * 100)}%`);
  lines.push(`  largest  ${largest.map((l) => `${(l.m.content[0] as { text?: string })?.text?.slice(0, 30) ?? l.m.role} ${l.t}`).join('\n           ')}`);
  lines.push(`  reserved for output              ${acc.reserveOutput.toLocaleString().padStart(7)}    ${Math.round((acc.reserveOutput / acc.cap) * 100)}%`);
  return lines.join('\n');
}
