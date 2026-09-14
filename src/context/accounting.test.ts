import { describe, it, expect } from 'vitest';
import { accounting, capForModel } from './accounting.js';

describe('capForModel', () => {
  it('keeps the legacy ceiling when no model is given', () => {
    expect(capForModel(undefined)).toBe(120_000);
  });

  it('sizes to the model window minus reserve', () => {
    // gpt-4o: 128k window, 8k unified reserve → 120k (legacy ceiling)
    expect(capForModel('gpt-4o')).toBe(120_000);
    // claude-3-5-sonnet: 200k window → clamped to legacy 120k ceiling
    expect(capForModel('claude-3-5-sonnet-20240620')).toBe(120_000);
  });

  it('collapses for tiny local windows instead of overflowing them', () => {
    // llama3.2: 8k window, 8k unified reserve → 4k usable floor, not 120k
    expect(capForModel('llama3.2')).toBe(4_000);
  });

  it('sizes unknown models from the registry fallback window', () => {
    // Mystery models fall back to a 100k window → 100k − 8k reserve.
    expect(capForModel('mystery-model-9000')).toBe(92_000);
  });
});

describe('accounting', () => {
  it('uses the window-aware cap by default', () => {
    const a = accounting(undefined, [], { model: 'gpt-4o' });
    expect(a.cap).toBe(120_000);
    expect(a.reserveOutput).toBe(8000);
    const explicit = accounting(undefined, [], { model: 'gpt-4o', cap: 50_000 });
    expect(explicit.cap).toBe(50_000);
  });
});
