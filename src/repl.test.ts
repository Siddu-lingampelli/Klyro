import { describe, it, expect } from 'vitest';
import { trimHistory, splitContinuedLine, type Turn } from './repl.js';
import { estimateTokens } from './context/tokenizer.js';

function pair(n: number, size: number): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}-` + 'x'.repeat(size) });
  }
  return out;
}

describe('legacy trimHistory (token-budgeted)', () => {
  it('keeps history under the turn cap in pairs', () => {
    const h = pair(50, 10);
    trimHistory(h);
    expect(h.length).toBeLessThanOrEqual(40);
    expect(h.length % 2).toBe(0);
  });

  it('trims by token budget, not raw chars', () => {
    // CJK text: few chars, many tokens under chars/4 only if… use long ASCII
    // history that exceeds the 80k-char (~20k-token) budget.
    const h = pair(10, 20_000);
    const before = estimateTokens(h.map((t) => t.content).join('\n'));
    expect(before).toBeGreaterThan(20_000);
    trimHistory(h);
    const after = estimateTokens(h.map((t) => t.content).join('\n'));
    expect(after).toBeLessThanOrEqual(20_000);
    expect(h.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves small histories alone', () => {
    const h = pair(4, 10);
    trimHistory(h);
    expect(h).toHaveLength(4);
  });
});

describe('splitContinuedLine (1.4 trailing-backslash continuation)', () => {
  it('completes plain lines immediately', () => {
    expect(splitContinuedLine('', 'hello')).toEqual({ pending: '', complete: 'hello' });
  });

  it('continues on an odd trailing run, stripping one backslash', () => {
    expect(splitContinuedLine('', 'first \\')).toEqual({ pending: 'first \n', complete: undefined });
    expect(splitContinuedLine('first \n', 'second')).toEqual({ pending: '', complete: 'first \nsecond' });
  });

  it('treats even trailing runs as literal backslashes', () => {
    expect(splitContinuedLine('', 'path\\\\')).toEqual({ pending: '', complete: 'path\\\\' });
  });
});
