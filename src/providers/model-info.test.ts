import { describe, it, expect } from 'vitest';
import { estimateCost } from './model-info.js';

describe('estimateCost cache awareness', () => {
  it('ignores cache counters for non-Anthropic models', () => {
    const base = estimateCost('gpt-4o', 1000, 500);
    expect(estimateCost('gpt-4o', 1000, 500, { read: 1_000_000, write: 1_000_000 })).toBe(base);
  });

  it('bills Anthropic cacheRead at 0.1x and cacheWrite at 1.25x input', () => {
    const m = 'claude-opus-4-5';
    const base = estimateCost(m, 1000, 0);
    const readDelta = estimateCost(m, 1000, 0, { read: 1000 }) - base;
    const writeDelta = estimateCost(m, 1000, 0, { write: 1000 }) - base;
    expect(readDelta).toBeCloseTo(base * 0.1, 10);
    expect(writeDelta).toBeCloseTo(base * 1.25, 10);
    // Local models stay $0 with any counters.
    expect(estimateCost('ollama/llama3', 1000, 500, { read: 999, write: 999 })).toBe(0);
  });

  it('defaults missing counters to zero', () => {
    expect(estimateCost('claude-opus-4-5', 1000, 500)).toBe(
      estimateCost('claude-opus-4-5', 1000, 500, {}),
    );
  });
});
