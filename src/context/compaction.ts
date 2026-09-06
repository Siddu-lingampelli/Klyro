/**
 * 8.3 — Auto-compaction: (a) elide → (b) summarize 60% with model.small → (c) keep last N verbatim
 * Trigger at compactAt (80%) or /compact [focus]. Validates summary mentions every checkpointed file else fallback.
 */
import type { Message } from '../agent/message.js';
import { compressTranscript } from './tokenizer.js';
import type { SessionStore } from '../persistence/store.js';

export interface CompactionResult { messages: Message[]; summary: string; dropped: number; method: 'elide' | 'summarize' | 'fallback' }

export async function compact(
  messages: Message[],
  opts: { system?: string; cap?: number; focus?: string; checkpointedFiles?: string[]; summarizeFn?: (prompt: string) => Promise<string> }
): Promise<CompactionResult> {
  const cap = opts.cap ?? 120_000;
  // (a) elide old tool results
  const elided = compressTranscript(opts.system, messages, { total: cap, reservedOutput: 16_000 });
  if (opts.checkpointedFiles && elided.dropped > 0) {
    // (b) try summarize oldest 60% using strict template (mock small model)
    const n = Math.floor(messages.length * 0.6);
    const oldest = messages.slice(0, n);
    const newest = messages.slice(n);
    const template = `Summarize the following ${oldest.length} messages, mentioning every file: ${opts.checkpointedFiles.join(', ')}.\nFocus: ${opts.focus ?? 'general'}\n\n` + oldest.map((m) => JSON.stringify(m.content).slice(0, 500)).join('\n');
    let summary = `Earlier in session: ${oldest.length} turns covering ${opts.checkpointedFiles.join(', ')}`;
    if (opts.summarizeFn) {
      try { summary = await opts.summarizeFn(template); } catch { /* fallback */ }
    }
    // validate: every checkpointed file mentioned
    const missing = opts.checkpointedFiles.filter((f) => !summary.includes(f.split('/').pop() ?? f));
    if (missing.length === 0) {
      // (c) keep last N verbatim + summary as first message
      const summaryMsg: Message = { role: 'user', content: [{ kind: 'text', text: summary } as any] };
      return { messages: [summaryMsg, ...newest], summary, dropped: elided.dropped, method: 'summarize' };
    }
    // retry once then fallback to elide
    if (opts.summarizeFn) {
      try {
        const retry = await opts.summarizeFn(template + '\nEnsure to mention: ' + missing.join(', '));
        if (missing.every((f) => retry.includes(f.split('/').pop() ?? f))) {
          const summaryMsg2: Message = { role: 'user', content: [{ kind: 'text', text: retry } as any] };
          return { messages: [summaryMsg2, ...newest], summary: retry, dropped: elided.dropped, method: 'summarize' };
        }
      } catch { /* fallback */ }
    }
  }
  return { messages: elided.messages, summary: elided.dropped > 0 ? `Elided ${elided.dropped} observations` : '', dropped: elided.dropped, method: elided.dropped > 0 ? 'elide' : 'fallback' };
}
