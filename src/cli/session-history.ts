/**
 * Cross-turn conversation memory for the interactive TUI REPL.
 *
 * Root cause it fixes: every TUI prompt previously started a brand-new
 * `run()` with only the current message, so "what models are there" asked
 * after pasting a URL could never resolve what "models" referred to.
 * These helpers keep a bounded `Message[]` across turns and feed it back
 * as `initialTranscript` (full runs) or message history (simple chat).
 *
 * Bounds keep cost predictable: at most MAX_HISTORY_MESSAGES messages and
 * MAX_HISTORY_CHARS of content. Trimming cuts only at user-message
 * boundaries and never orphans a `tool_result` from its `tool_use`
 * (providers reject dangling tool blocks).
 */

import type { Message } from '../agent/message.js';

export const MAX_HISTORY_MESSAGES = 60;
export const MAX_HISTORY_CHARS = 60_000;

/** True when the text references a web URL (needs tools — never simple chat). */
export function looksLikeUrl(text: string): boolean {
  return /https?:\/\/|www\./i.test(text);
}

/**
 * Fast-path gate: short chit-chat skips tools. Extracted (was inline in
 * repl.ts) so the URL carve-out is unit-tested: any URL forces the full
 * agent loop where web_fetch + approval can engage.
 */
export function shouldUseSimpleChat(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  if (looksLikeUrl(t)) return false;
  const words = t.split(/\s+/).length;
  const lower = t.toLowerCase();
  return words <= 5 && !lower.includes('fix') && !lower.includes('add') && !lower.includes('create');
}

export function userMessage(text: string): Message {
  return { role: 'user', content: [{ kind: 'text', text }] };
}

export function assistantMessage(text: string): Message {
  return { role: 'assistant', content: [{ kind: 'text', text }] };
}

/** Plain-text projection of a message (tool blocks count JSON-encoded). */
export function messageText(m: Message): string {
  return m.content
    .map((b) => {
      if (b.kind === 'text') return b.text;
      if (b.kind === 'tool_use') return `[tool_use ${b.name}]`;
      return `[tool_result ${b.name}]`;
    })
    .join('\n');
}

function messageChars(m: Message): number {
  let n = m.role.length;
  for (const b of m.content) {
    n += b.kind === 'text' ? b.text.length : JSON.stringify(b).length;
  }
  return n;
}

function fitsBudget(msgs: Message[]): boolean {
  if (msgs.length > MAX_HISTORY_MESSAGES) return false;
  let n = 0;
  for (const m of msgs) {
    n += messageChars(m);
    if (n > MAX_HISTORY_CHARS) return false;
  }
  return true;
}

function hasOrphanToolResult(msgs: Message[]): boolean {
  const uses = new Set<string>();
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.kind === 'tool_use') uses.add(b.id);
    }
  }
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.kind === 'tool_result' && !uses.has(b.toolCallId)) return true;
    }
  }
  return false;
}

/**
 * Trim to budget, cutting only at user-message boundaries with no orphaned
 * tool_result. Falls back to the last user/assistant text pair when no
 * valid cut fits (e.g. one giant tool result).
 */
export function trimHistory(history: Message[]): Message[] {
  if (fitsBudget(history)) return [...history];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (!m || m.role !== 'user') continue;
    const rest = history.slice(i);
    if (fitsBudget(rest) && !hasOrphanToolResult(rest)) return [...rest];
  }
  let lastUser: Message | undefined;
  let lastAssistant: Message | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) continue;
    if (!lastUser && m.role === 'user') lastUser = m;
    if (!lastAssistant && m.role === 'assistant') lastAssistant = m;
    if (lastUser && lastAssistant) break;
  }
  const tail: Message[] = [];
  if (lastUser) tail.push(userMessage(messageText(lastUser)));
  if (lastAssistant) tail.push(assistantMessage(messageText(lastAssistant)));
  return tail;
}

/** Record a completed simple-chat turn. */
export function appendTurn(history: Message[], userText: string, assistantText: string): Message[] {
  return trimHistory([...history, userMessage(userText), assistantMessage(assistantText)]);
}

/** Adopt a full run's transcript (already includes prior history + task). */
export function adoptTranscript(transcript: Message[]): Message[] {
  return trimHistory(transcript);
}

/**
 * Seed history after /compact: earlier turns are replaced by the retained
 * summary so follow-ups still resolve ("the models we discussed").
 */
export function summaryAnchor(summary: string): Message[] {
  return [
    userMessage('[context compacted — earlier history replaced by the summary below; resolve follow-up references against it]'),
    assistantMessage(summary),
  ];
}
