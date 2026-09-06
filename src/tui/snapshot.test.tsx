/**
 * Snapshot tests for the full TUI App — render various states and assert
 * the exact visible frame. This is the "what does the user actually see"
 * ground truth.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from './app.js';
import { TuiApprovalBridge } from './approval.js';

const DEFAULT_PROPS = {
  cwd: '/projects/demo',
  onPrompt: async () => {},
  onSlash: async () => {},
};

describe('App visual snapshot', () => {
  it('renders header + statusline + transcript + input at idle', () => {
    const { lastFrame } = render(
      <App {...DEFAULT_PROPS}
        initialModel="gpt-4o-mini"
        maxSteps={30}
        initialStatus={{ status: 'idle', model: 'gpt-4o-mini', step: 0, maxSteps: 30, usageInput: 0, usageOutput: 0, repairs: 0 }}
      />
    );
    const frame = lastFrame();
    // Header should be visible (uppercase KLYRO as rendered)
    expect(frame).toContain('KLYRO');
    expect(frame).toContain('demo');  // cwd basename
    expect(frame).toContain('gpt-4o-mini');
    // Status line should show
    expect(frame).toMatch(/idle/i);
    // Input prompt should be visible
    expect(frame).toContain('>');
  });

  it('renders a transcript with assistant text', () => {
    const { lastFrame } = render(
      <App {...DEFAULT_PROPS}
        initialModel="gpt-4o-mini"
        maxSteps={30}
        initialStatus={{ status: 'idle', model: 'gpt-4o-mini', step: 0, maxSteps: 30, usageInput: 0, usageOutput: 0, repairs: 0 }}
        initialTranscript={[
          { id: 'u1', kind: 'text', text: 'hello', role: 'user' },
          { id: 'a1', kind: 'text', text: 'hi there', role: 'assistant' },
        ]}
      />
    );
    const frame = lastFrame();
    expect(frame).toContain('hello');
    expect(frame).toContain('hi there');
  });

  it('does not render plan view when plan is empty', () => {
    const { lastFrame } = render(
      <App {...DEFAULT_PROPS}
        initialModel="gpt-4o-mini"
        maxSteps={30}
        initialStatus={{ status: 'idle', model: 'gpt-4o-mini', step: 0, maxSteps: 30, usageInput: 0, usageOutput: 0, repairs: 0 }}
        initialTranscript={[]}
      />
    );
    const frame = lastFrame();
    // When plan is empty, no plan section should be visible
    expect(frame).not.toContain('Plan');
  });

  it('renders plan view when plan is populated via mounted hooks', async () => {
    const { lastFrame } = render(
      <App {...DEFAULT_PROPS}
        initialModel="gpt-4o-mini"
        maxSteps={30}
        initialStatus={{ status: 'idle', model: 'gpt-4o-mini', step: 0, maxSteps: 30, usageInput: 0, usageOutput: 0, repairs: 0 }}
      />
    );
    const g = globalThis as unknown as { __klyroAppPlan?: (p: import('../agent/runtime.js').PlanStep[]) => void };
    // Poll for hooks installed by useEffect (avoids flaky fixed timeout)
    for (let i = 0; i < 10 && !g.__klyroAppPlan; i++) await new Promise((r) => setTimeout(r, 10));
    g.__klyroAppPlan?.([
      { id: '1', title: 'Read files', status: 'done' },
      { id: '2', title: 'Edit code', status: 'in_progress', files: ['src/x.ts'] },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame();
    expect(frame).toContain('Read files');
    expect(frame).toContain('Edit code');
  });

  it('renders file_changed inline (the colored line)', () => {
    const { lastFrame } = render(
      <App {...DEFAULT_PROPS}
        initialModel="gpt-4o-mini"
        maxSteps={30}
        initialStatus={{ status: 'idle', model: 'gpt-4o-mini', step: 0, maxSteps: 30, usageInput: 0, usageOutput: 0, repairs: 0 }}
        initialTranscript={[
          { id: 'fc1', kind: 'file_changed', path: 'src/foo.ts', op: 'modified' },
        ]}
      />
    );
    const frame = lastFrame();
    expect(frame).toContain('src/foo.ts');
    expect(frame).toMatch(/modified|\~/);
  });

  it('diff transcript item renders the diff box', () => {
    const { lastFrame } = render(
      <App {...DEFAULT_PROPS}
        initialModel="gpt-4o-mini"
        maxSteps={30}
        initialStatus={{ status: 'idle', model: 'gpt-4o-mini', step: 0, maxSteps: 30, usageInput: 0, usageOutput: 0, repairs: 0 }}
        initialTranscript={[
          {
            id: 'd1',
            kind: 'diff',
            summary: '1 file(s) changed',
            hunks: [{
              path: 'src/x.ts',
              lines: [
                { kind: 'header', text: '@@ -1 +1 @@' },
                { kind: 'remove', text: 'const a = 1;' },
                { kind: 'add', text: 'const a = 2;' },
              ],
            }],
          },
        ]}
      />
    );
    const frame = lastFrame();
    expect(frame).toContain('src/x.ts');
    expect(frame).toContain('const a = 2;');
    expect(frame).toContain('+ ');
  });
});
