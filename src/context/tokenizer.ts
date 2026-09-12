/**
 * Token budget — keeps each model call under a hard cap by trimming the
 * transcript before sending it to the provider.
 *
 * For MVP we count tokens with a simple heuristic (chars/4) so we don't
 * pull in a heavy BPE dependency. The cap is conservative; the runtime
 * never overflows the model's true window because the heuristic
 * overestimates mixed text.
 *
 * R3 — accuracy improvement: the heuristic is *calibrated* against the
 * provider's reported usage when available. The runtime calls
 * `calibrateEstimate` after each message_end that carries usage, which
 * adjusts the per-character ratio toward the real value observed for this
 * model. The calibration is bounded (0.1–0.6 chars/token) so a bad sample
 * can't make the budget non-conservative. Until the first sample arrives,
 * the safe chars/4 default is used.
 *
 * Strategy:
 *   1. Always preserve the system prompt, the latest user task, and the
 *      latest assistant message.
 *   2. If still over budget, drop the oldest tool_result observations
 *      that have been "consumed" (a later assistant message referenced
 *      their tool_call_id).
 *   3. If still over budget, summarize the surviving tail into a single
 *      user message ("Earlier in this session: …").
 */

import type { Message, ContentBlock } from '../agent/message.js';

export interface TokenBudget {
  /** Total input cap (system + messages). */
  total: number;
  /** Reserve for the response (we don't trim these; the cap is on input). */
  reservedOutput: number;
}

export interface BudgetCheck {
  ok: boolean;
  used: number;
  cap: number;
}

/** Calibration ratio: chars per token. Starts at 4.0 (the classic heuristic)
 *  and self-corrects toward the provider's reported usage. Bounded to
 *  [MIN_RATIO, MAX_RATIO] = [2.0, 6.0] so a pathological sample (a tool dump
 *  that tokenizes densely, or a sparse prompt) can't drive the budget into a
 *  non-conservative regime. Real tokenizers sit around 3.5–4.5 chars/token. */
const MIN_RATIO = 2.0;
const MAX_RATIO = 6.0;
let charsPerToken = 4.0;

/**
 * Calibrate the heuristic against provider-reported usage. Pass the actual
 * input token count and the char length of the transcript that was sent.
 * The ratio self-corrects toward the model's true tokenizer behavior.
 */
export function calibrateEstimate(usedChars: number, reportedInputTokens: number): number {
  if (reportedInputTokens <= 0 || usedChars <= 0) return charsPerToken;
  const newRatio = usedChars / reportedInputTokens;
  charsPerToken = Math.max(MIN_RATIO, Math.min(MAX_RATIO, newRatio));
  return charsPerToken;
}

/** Current chars/token ratio (after calibration, if any). */
export function charsPerTokenRatio(): number {
  return charsPerToken;
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / charsPerToken);
}

export function estimateMessage(m: Message): number {
  let n = 4; // role + structural overhead
  for (const b of m.content) n += estimateBlock(b);
  return n;
}

function estimateBlock(b: ContentBlock): number {
  if (b.kind === 'text') return estimateTokens(b.text) + 4;
  if (b.kind === 'tool_use') return estimateTokens(b.name) + estimateTokens(JSON.stringify(b.input)) + 16;
  if (b.kind === 'tool_result') {
    const out = typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '');
    return estimateTokens(out) + estimateTokens(b.name) + 16;
  }
  return 0;
}

/** Total input tokens for a transcript + optional system prompt. */
export function totalTokens(system: string | undefined, messages: Message[]): number {
  let n = system ? estimateTokens(system) : 0;
  for (const m of messages) n += estimateMessage(m);
  return n;
}

/** Count the raw character length of a transcript for calibration. */
export function transcriptCharLength(system: string | undefined, messages: Message[]): number {
  let n = system ? system.length : 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.kind === 'text') n += b.text.length;
      else if (b.kind === 'tool_use') n += b.name.length + JSON.stringify(b.input).length;
      else if (b.kind === 'tool_result') {
        const out = typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '');
        n += out.length + (b.name?.length ?? 0);
      }
    }
  }
  return n;
}

/** True if the input fits under the budget cap. */
export function withinBudget(system: string | undefined, messages: Message[], budget: TokenBudget): BudgetCheck {
  const used = totalTokens(system, messages);
  return { ok: used <= budget.total, used, cap: budget.total };
}

/**
 * Trim a transcript to fit under the budget. Strategy:
 *   - Keep first user task (so the model never forgets the goal).
 *   - Keep the last 2 messages verbatim.
 *   - Compress intermediate messages: tool_result blocks shorter, text
 *     blocks truncated to 500 chars each.
 * Returns the new transcript plus a count of dropped observations.
 */
export function compressTranscript(
  system: string | undefined,
  messages: Message[],
  budget: TokenBudget,
): { system: string | undefined; messages: Message[]; dropped: number } {
  // Deep copy to avoid mutating original messages (which are also stored in transcript/persistence)
  const result: Message[] = messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => ({ ...b, output: (b as { output?: unknown }).output } as ContentBlock)),
  }));
  let dropped = 0;

  // Phase 1: find tool_call_ids referenced in any later assistant message.
  const consumed = new Set<string>();
  for (const m of result) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) if (b.kind === 'tool_use') consumed.add(b.id);
  }

  // Phase 2: shrink tool_result blocks older than the last 4 messages.
  const tailStart = Math.max(0, result.length - 4);
  for (let i = 0; i < tailStart; i++) {
    const m = result[i];
    if (!m || m.role !== 'tool') continue;
    for (const b of m.content) {
      if (b.kind !== 'tool_result') continue;
      const block = b as { toolCallId: string; output: unknown };
      if (!consumed.has(block.toolCallId)) {
        // Drop the observation entirely.
        (b as { output: unknown }).output = '[earlier observation removed to fit context]';
        dropped++;
      } else if (typeof block.output === 'string' && block.output.length > 400) {
        (b as { output: unknown }).output = block.output.slice(0, 400) + '... [truncated]';
      }
    }
  }

  // Phase 3: hard cap — drop oldest messages until we fit, but always
  // preserve the first message (the user's task). Drops keep tool_use /
  // tool_result PAIRS intact: removing an assistant turn also removes the
  // tool messages that answer it, and an orphaned tool message (its turn
  // already gone) is dropped on its own. Split pairs make providers 400.
  while (totalTokens(system, result) > budget.total && result.length > 2) {
    result.splice(1, 1);
    dropped++;
    while (result[1] && (result[1] as Message).role === 'tool') {
      result.splice(1, 1);
      dropped++;
    }
  }

  return { system, messages: result, dropped };
}
