/**
 * 8.1 — Accounting & stable assembly
 * Live token estimate, ctx%, compactAt, reserveOutput, toolResultMax
 */
import { estimateTokens, totalTokens } from './tokenizer.js';
import { getModelInfo } from '../providers/model-info.js';
import type { Message } from '../agent/message.js';

export interface ContextAccounting {
  used: number;
  cap: number;
  pct: number;
  reserveOutput: number;
  compactAt: number;
  toolResultMax: number;
}

/**
 * Single output-reserve used by every budget in the harness (displayed
 * accounting, runtime enforcement, compaction elide). One constant so the
 * meter and the enforcer can never disagree.
 */
export const RESERVE_OUTPUT_TOKENS = 8000;

export function accounting(system: string | undefined, messages: Message[], opts: { cap?: number; reserveOutput?: number; toolResultMax?: number; compactAt?: number; model?: string } = {}): ContextAccounting {
  const reserveOutput = opts.reserveOutput ?? RESERVE_OUTPUT_TOKENS;
  // Window-aware default: the legacy 120k ceiling overflows small-window
  // models (e.g. 8k local models) and wastes large ones — size to the model.
  const cap = opts.cap ?? capForModel(opts.model, reserveOutput);
  const toolResultMax = opts.toolResultMax ?? 2000;
  const compactAt = opts.compactAt ?? 0.8;
  const used = totalTokens(system, messages);
  const pct = Math.round((used / cap) * 100);
  return { used, cap, pct, reserveOutput, compactAt, toolResultMax };
}

/**
 * Input-token budget for a model: its context window minus the output
 * reserve, clamped to the legacy 120k ceiling and a 4k usable floor so
 * tiny windows still function. Unknown models use the registry fallback
 * window (100k); a missing model name keeps the legacy 120k.
 */
export function capForModel(model: string | undefined, reserveOutput = RESERVE_OUTPUT_TOKENS): number {
  if (!model) return 120_000;
  const window = getModelInfo(model).contextWindow;
  if (!Number.isFinite(window) || window <= 0) return 120_000;
  return Math.max(4_000, Math.min(120_000, Math.floor(window - reserveOutput)));
}

export function contextMeter(pct: number): string {
  const filled = Math.round((pct / 100) * 20);
  return `${'▰'.repeat(filled)}${'▱'.repeat(20 - filled)}`;
}
