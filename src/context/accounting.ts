/**
 * 8.1 — Accounting & stable assembly
 * Live token estimate, ctx%, compactAt, reserveOutput, toolResultMax
 */
import { estimateTokens, totalTokens } from './tokenizer.js';
import type { Message } from '../agent/message.js';

export interface ContextAccounting {
  used: number;
  cap: number;
  pct: number;
  reserveOutput: number;
  compactAt: number;
  toolResultMax: number;
}

export function accounting(system: string | undefined, messages: Message[], opts: { cap?: number; reserveOutput?: number; toolResultMax?: number; compactAt?: number } = {}): ContextAccounting {
  const cap = opts.cap ?? 120_000;
  const reserveOutput = opts.reserveOutput ?? 16_000;
  const toolResultMax = opts.toolResultMax ?? 2000;
  const compactAt = opts.compactAt ?? 0.8;
  const used = totalTokens(system, messages);
  const pct = Math.round((used / cap) * 100);
  return { used, cap, pct, reserveOutput, compactAt, toolResultMax };
}

export function contextMeter(pct: number): string {
  const filled = Math.round((pct / 100) * 20);
  return `${'▰'.repeat(filled)}${'▱'.repeat(20 - filled)}`;
}
