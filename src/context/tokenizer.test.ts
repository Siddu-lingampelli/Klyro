import { describe, it, expect } from 'vitest';
import { totalTokens, withinBudget, compressTranscript } from './tokenizer.js';
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
