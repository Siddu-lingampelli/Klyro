/**
 * 8.1 — Stable assembly order: identity → tools → env+map+KLYRO.md → summary → messages → reminders
 * Cache-friendly: deterministic serialization for prompt caching (turn 5+ cache-read ≥80%).
 */
import type { Message } from '../agent/message.js';

export interface AssemblyParts {
  identity: string;
  tools: string;
  envMap: string;
  summary?: string;
  messages: Message[];
  reminders?: string;
}

export function assemble(parts: AssemblyParts): { system: string; messages: Message[] } {
  const segs: string[] = [];
  if (parts.identity) segs.push(parts.identity);
  if (parts.tools) segs.push(parts.tools);
  if (parts.envMap) segs.push(parts.envMap);
  if (parts.summary) segs.push(parts.summary);
  // reminders are injected into last user turn per spec
  const messages = [...parts.messages];
  if (parts.reminders && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      const text = last.content.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('\n');
      messages[messages.length - 1] = { ...last, content: [{ kind: 'text', text: text + '\n\n' + parts.reminders } as any] };
    }
  }
  return { system: segs.join('\n\n'), messages };
}
