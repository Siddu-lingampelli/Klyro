import { describe, it, expect } from 'vitest';
import {
  totalTokens,
  withinBudget,
  compressTranscript,
  estimateTokens,
  calibrateEstimate,
  transcriptCharLength,
} from './tokenizer.js';
import type { Message } from '../agent/message.js';
import { text, toolUse, toolResult } from '../agent/message.js';

describe('tokenizer', () => {
  it('estimates tokens roughly as chars/4', () => {
    expect(totalTokens(undefined, [{ role: 'user', content: [text('hello world')] }])).toBeGreaterThan(0);
  });

  it('reports withinBudget.ok=false when over cap', () => {
    const big = 'x'.repeat(10_000);
    const check = withinBudget(undefined, [{ role: 'user', content: [text(big)] }], { total: 100, reservedOutput: 50 });
    expect(check.ok).toBe(false);
  });

  it('compressTranscript preserves first and last messages', () => {
    const messages: Message[] = [
      { role: 'user', content: [text('task')] },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: 'assistant' as const,
        content: [toolUse(`c${i}`, 'read_file', { path: `f${i}.txt` })],
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        role: 'tool' as const,
        content: [toolResult(`c${i}`, 'read_file', 'x'.repeat(500))],
      })),
      { role: 'assistant', content: [text('done')] },
    ];
    const { messages: out } = compressTranscript(undefined, messages, { total: 200, reservedOutput: 50 });
    expect(out.length).toBeLessThan(messages.length);
    // First user task preserved.
    expect((out[0].content[0] as { text: string }).text).toBe('task');
    // Last message preserved.
    expect((out[out.length - 1].content[0] as { text: string }).text).toBe('done');
  });

  it('Phase-3 drops keep tool_use/tool_result pairs intact', () => {
    const messages: Message[] = [{ role: 'user', content: [text('task')] }];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: 'assistant', content: [toolUse(`c${i}`, 'read_file', { path: 'f' })] });
      messages.push({ role: 'tool', content: [toolResult(`c${i}`, 'read_file', 'y'.repeat(300))] });
    }
    messages.push({ role: 'assistant', content: [text('done')] });
    const { messages: out } = compressTranscript(undefined, messages, { total: 150, reservedOutput: 20 });
    // Every remaining tool message must still have its assistant turn (no orphans).
    const useIds = new Set<string>();
    for (const m of out) {
      if (m.role === 'assistant') {
        for (const b of m.content) if (b.kind === 'tool_use') useIds.add(b.id);
      }
    }
    for (const m of out) {
      if (m.role !== 'tool') continue;
      for (const b of m.content) {
        if (b.kind === 'tool_result') expect(useIds.has(b.toolCallId)).toBe(true);
      }
    }
  });
});

describe('R3 — token calibration', () => {
  it('calibrateEstimate adjusts the chars/token ratio toward reported usage', () => {
    // A provider that reports 1 token per 2 chars (denser than chars/4):
    // 4000 chars / 2000 tokens → ratio 2.0. estimateTokens should follow.
    const before = estimateTokens('x'.repeat(4000));
    calibrateEstimate(4000, 2000);
    const after = estimateTokens('x'.repeat(4000));
    expect(after).toBeGreaterThan(0);
    // Ratio 2.0 → 4000/2 = 2000 tokens (vs 1000 before calibration).
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(2000);
  });

  it('clamps the ratio into [2.0, 6.0] chars per token', () => {
    // Dense tokenization (100 tokens per 100_000 chars → ratio 1000 chips
    // toward a small ratio) is clamped UP to the floor 2.0.
    calibrateEstimate(100_000, 1000); // ratio 100 → clamped to 6.0 (denser = fewer... see below)
    // Wait — 100_000 chars / 1000 tokens = 100 chars/token, meaning VERY
    // sparse tokenization (few tokens per char), so ratio clamps DOWN to 6.0.
    expect(estimateTokens('x'.repeat(6000))).toBe(Math.ceil(6000 / 6.0));
    // Dense tokenizer: 1000 chars / 100_000 tokens = 0.01 chars/token → too
    // many tokens per char → clamped UP to 2.0 (densest we trust).
    calibrateEstimate(1000, 100_000); // ratio 0.01 → clamped to 2.0
    expect(estimateTokens('x'.repeat(1000))).toBe(Math.ceil(1000 / 2.0));
  });

  it('ignores degenerate calibration inputs', () => {
    calibrateEstimate(0, 100);
    calibrateEstimate(100, 0);
    // No throw, still estimates something.
    expect(estimateTokens('abc')).toBeGreaterThan(0);
  });

  it('transcriptCharLength counts text, tool_use, and tool_result content', () => {
    const messages: Message[] = [
      { role: 'user', content: [text('task')] },
      { role: 'assistant', content: [toolUse('c1', 'read_file', { path: 'f.txt' })] },
      { role: 'tool', content: [toolResult('c1', 'read_file', 'out')] },
    ];
    const n = transcriptCharLength('sys', messages);
    expect(n).toBe('sys'.length + 'task'.length + 'read_file'.length + JSON.stringify({ path: 'f.txt' }).length + 'out'.length + 'read_file'.length);
    expect(n).toBeGreaterThan(0);
  });
});
