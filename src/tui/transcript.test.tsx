import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Transcript, type TranscriptItem } from './transcript.js';

describe('Transcript', () => {
  it('shows the empty-state hint when no items', () => {
    const { lastFrame } = render(<Transcript items={[]} />);
    expect(lastFrame()).toMatch(/Type a prompt/);
  });

  it('renders user text with the > prefix', () => {
    const items: TranscriptItem[] = [
      { id: '1', kind: 'text', text: 'hello', role: 'user' },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    expect(lastFrame()).toContain('> hello');
  });

  it('renders assistant text without prefix', () => {
    const items: TranscriptItem[] = [
      { id: '1', kind: 'text', text: 'world', role: 'assistant' },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    expect(lastFrame()).toContain('world');
    expect(lastFrame()).not.toContain('> world');
  });

  it('renders a tool call block with header and result', () => {
    const items: TranscriptItem[] = [
      {
        id: 't1', kind: 'tool', name: 'read_file', id_call: 'c1',
        args: '{"path":"x"}', result: 'content', isError: false, latencyMs: 12,
      },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    const out = lastFrame();
    expect(out).toContain('[tool]');
    expect(out).toContain('read_file');
    expect(out).toContain('(12ms)');
    expect(out).toContain('content');
  });

  it('collapses long tool args/results when collapsed=true', () => {
    const items: TranscriptItem[] = [
      {
        id: 't1', kind: 'tool', name: 'shell_exec', id_call: 'c1',
        args: 'x'.repeat(500), result: 'y'.repeat(500), isError: false, latencyMs: 5,
        collapsed: true,
      },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    const out = lastFrame();
    expect(out).toContain('collapsed');
    expect(out).toContain('500');
    expect(out).not.toContain('x'.repeat(50));
  });

  it('renders policy decisions with the right color cue', () => {
    const items: TranscriptItem[] = [
      { id: 'p1', kind: 'policy', name: 'shell_exec', action: 'deny', reason: 'r' },
      { id: 'p2', kind: 'policy', name: 'shell_exec', action: 'allow' },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    const out = lastFrame();
    expect(out).toContain('deny');
    expect(out).toContain('allow');
    expect(out).toContain('shell_exec');
  });

  it('renders error items', () => {
    const items: TranscriptItem[] = [
      { id: 'e1', kind: 'error', message: 'oops' },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    expect(lastFrame()).toContain('[error] oops');
  });
});
