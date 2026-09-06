import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { StatusLine, type StatusSnapshot } from './status.js';

describe('StatusLine', () => {
  it('renders model, step, repairs, and token usage', () => {
    const snapshot: StatusSnapshot = {
      model: 'gpt-4o-mini',
      step: 3,
      maxSteps: 30,
      usageInput: 4096,
      usageOutput: 1024,
      repairs: 1,
      status: 'running',
    };
    const { lastFrame } = render(<StatusLine snapshot={snapshot} />);
    const out = lastFrame();
    expect(out).toContain('gpt-4o-mini');
    expect(out).toContain('3');
    expect(out).toContain('30');
    expect(out).toContain('repairs');
    expect(out).toContain('running');
  });

  it('renders different status colors for done / error / aborted', () => {
    for (const status of ['done', 'error', 'aborted', 'idle'] as const) {
      const { lastFrame } = render(
        <StatusLine snapshot={{
          model: 'm', step: 1, maxSteps: 10, usageInput: 0, usageOutput: 0, repairs: 0, status,
        }} />,
      );
      const out = lastFrame();
      expect(out).toContain(status);
    }
  });

  it('formats usage in KiB', () => {
    const { lastFrame } = render(
      <StatusLine snapshot={{
        model: 'm', step: 1, maxSteps: 10, usageInput: 2048, usageOutput: 0, repairs: 0, status: 'idle',
      }} />,
    );
    expect(lastFrame()).toContain('2.0K');
  });
});
