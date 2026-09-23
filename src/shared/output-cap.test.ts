import { describe, expect, it } from 'vitest';
import { cappedOutput } from './output-cap.js';

describe('cappedOutput', () => {
  it('collects everything under the cap and reports no truncation', () => {
    const sink = cappedOutput(1024);
    sink.push(Buffer.from('hello '));
    sink.push(Buffer.from('world'));
    expect(sink.text()).toBe('hello world');
    expect(sink.truncated).toBe(false);
  });

  it('stops at the cap and flags truncation', () => {
    const sink = cappedOutput(8);
    sink.push(Buffer.from('12345'));
    sink.push(Buffer.from('6789ABC')); // 12 bytes total → 3 dropped
    expect(sink.text()).toBe('12345678');
    expect(sink.truncated).toBe(true);
  });

  it('keeps draining without storing after the cap (no unbounded growth)', () => {
    const sink = cappedOutput(4);
    sink.push(Buffer.from('abcd'));
    expect(sink.truncated).toBe(false); // exactly full, nothing dropped yet
    for (let i = 0; i < 1000; i++) sink.push(Buffer.from('x'.repeat(4096)));
    expect(sink.text()).toBe('abcd');
    expect(sink.truncated).toBe(true);
  });

  it('never returns more characters than the byte cap', () => {
    const sink = cappedOutput(8);
    sink.push(Buffer.from('éééééééééé', 'utf-8')); // 20 bytes, 10 chars
    expect(sink.text().length).toBeLessThanOrEqual(8);
    expect(sink.truncated).toBe(true);
  });

  it('handles an empty run', () => {
    const sink = cappedOutput(16);
    expect(sink.text()).toBe('');
    expect(sink.truncated).toBe(false);
  });
});
