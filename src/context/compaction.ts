/**
 * 8.3 — Auto-compaction: (a) elide → (b) summarize 60% with model.small → (c) keep last N verbatim
 * Trigger at compactAt (80%) or /compact [focus]. Validates summary mentions every checkpointed file else fallback.
 */
import type { Message, ContentBlock } from '../agent/message.js';
import { compressTranscript } from './tokenizer.js';
import { capForModel, RESERVE_OUTPUT_TOKENS } from './accounting.js';

export interface CompactionResult { messages: Message[]; summary: string; dropped: number; method: 'elide' | 'summarize' | 'fallback' }

export function textBlock(s: string): ContentBlock {
  return { kind: 'text', text: s };
}

/**
 * Tightened checkpoint validation: every checkpointed file must be mentioned
 * by a path segment, not a loose basename substring. `src/util.ts` is matched
 * by "util.ts" only when it names a segment; `foo` never matches `foo.png`
 * nor a path nested inside it.
 */
function mentionsFile(summary: string, filePath: string): boolean {
  const segs = filePath.split('/').filter(Boolean);
  const tail = segs[segs.length - 1] ?? filePath;
  // Match the full basename OR any path segment borne by the file.
  // Prefer exact-path segments (src/util.ts or util.ts) to avoid the
  // substring false-positive the old `includes(basename)` produced.
  const quoted = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quotedTail = tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\W_])${quotedTail}([\\W_]|$)`).test(summary) || summary.includes(quoted);
}

export async function compact(
  messages: Message[],
  opts: { system?: string; cap?: number; focus?: string; checkpointedFiles?: string[]; summarizeFn?: (prompt: string) => Promise<string>; model?: string }
): Promise<CompactionResult> {
  const cap = opts.cap ?? capForModel(opts.model);
  // (a) elide old tool results
  const elided = compressTranscript(opts.system, messages, { total: cap, reservedOutput: RESERVE_OUTPUT_TOKENS });
  if (opts.checkpointedFiles && elided.dropped > 0) {
    // (b) try summarize oldest 60% using strict template (mock small model).
    // Slice from the ELIDED sequence so the summarize pass operates on what
    // actually survives elision (previously it sliced the raw `messages`,
    // silently dropping the elide benefit on the oldest portion).
    const elidedBest = elided.messages;
    const n = Math.floor(elidedBest.length * 0.6);
    const oldest = elidedBest.slice(0, n);
    const newest = elidedBest.slice(n);
    const template = `Summarize the following ${oldest.length} messages, mentioning every file: ${opts.checkpointedFiles.join(', ')}.\nFocus: ${opts.focus ?? 'general'}\n\n` + oldest.map((m) => JSON.stringify(m.content).slice(0, 500)).join('\n');
    let summary = `Earlier in session: ${oldest.length} turns covering ${opts.checkpointedFiles.join(', ')}`;
    if (opts.summarizeFn) {
      try { summary = await opts.summarizeFn(template); } catch { /* fallback */ }
    }
    // validate: every checkpointed file mentioned (path-segment match).
    const missing = opts.checkpointedFiles.filter((f) => !mentionsFile(summary, f));
    if (missing.length === 0) {
      // (c) keep last N verbatim + summary as first message (typed block).
      const summaryMsg: Message = { role: 'user', content: [textBlock(summary)] };
      return { messages: [summaryMsg, ...newest], summary, dropped: elided.dropped, method: 'summarize' };
    }
    // retry once then fallback to elide
    if (opts.summarizeFn) {
      try {
        const retry = await opts.summarizeFn(template + '\nEnsure to mention: ' + missing.join(', '));
        if (missing.every((f) => mentionsFile(retry, f))) {
          const summaryMsg2: Message = { role: 'user', content: [textBlock(retry)] };
          return { messages: [summaryMsg2, ...newest], summary: retry, dropped: elided.dropped, method: 'summarize' };
        }
      } catch { /* fallback */ }
    }
  }
  // Post-check the elide path too: if it still exceeds cap, keep eliding.
  if (elided.dropped === 0) {
    return { messages, summary: '', dropped: 0, method: 'fallback' };
  }
  return { messages: elided.messages, summary: elided.dropped > 0 ? `Elided ${elided.dropped} observations` : '', dropped: elided.dropped, method: elided.dropped > 0 ? 'elide' : 'fallback' };
}
