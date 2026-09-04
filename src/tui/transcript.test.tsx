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

  it('renders a done tool call as a card with name, summary, and result', () => {
    const items: TranscriptItem[] = [
      {
        id: 't1', kind: 'tool', name: 'read_file', id_call: 'c1',
        args: '{"path":"src/foo.ts"}', result: 'content', isError: false, latencyMs: 12,
        status: 'done',
      },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    const out = lastFrame();
    expect(out).toContain('read_file');
    expect(out).toContain('src/foo.ts');
    expect(out).toContain('content');
    expect(out).toMatch(/12ms/);
  });

  it('renders a running tool with a spinner and no result', () => {
    const items: TranscriptItem[] = [
      {
        id: 't1', kind: 'tool', name: 'shell_exec', id_call: 'c1',
        args: '{"command":"npm test"}',
        status: 'running',
      },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    const out = lastFrame();
    expect(out).toContain('shell_exec');
    expect(out).toContain('npm test');
    expect(out).toMatch(/running/);
  });

  it('renders an errored tool with a red border and error glyph', () => {
    const items: TranscriptItem[] = [
      {
        id: 't1', kind: 'tool', name: 'shell_exec', id_call: 'c1',
        args: '{"command":"exit 1"}', result: 'command failed', isError: true, latencyMs: 5,
        status: 'error',
      },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    const out = lastFrame();
    expect(out).toContain('shell_exec');
    expect(out).toContain('command failed');
    expect(out).toMatch(/error/);
  });

  it('renders policy decisions with allow/deny colors', () => {
    const items: TranscriptItem[] = [
      { id: 'p1', kind: 'policy', name: 'shell_exec', action: 'deny', reason: 'destructive' },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    const out = lastFrame();
    expect(out).toContain('deny');
    expect(out).toContain('shell_exec');
    expect(out).toContain('destructive');
  });

  it('renders file_changed items with op glyph', () => {
    const items: TranscriptItem[] = [
      { id: 'f1', kind: 'file_changed', path: 'src/x.ts', op: 'created' },
      { id: 'f2', kind: 'file_changed', path: 'src/y.ts', op: 'deleted' },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    const out = lastFrame();
    expect(out).toContain('+ created');
    expect(out).toContain('src/x.ts');
    expect(out).toContain('- deleted');
    expect(out).toContain('src/y.ts');
  });

  it('renders error items', () => {
    const items: TranscriptItem[] = [
      { id: 'e1', kind: 'error', message: 'something broke' },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    expect(lastFrame()).toContain('something broke');
  });

  it('summarizes a shell_exec with just the command', () => {
    const items: TranscriptItem[] = [
      {
        id: 't1', kind: 'tool', name: 'shell_exec', id_call: 'c1',
        args: '{"command":"ls -la"}',
        status: 'running',
      },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    expect(lastFrame()).toContain('ls -la');
  });

  it('summarizes a search with the query in quotes', () => {
    const items: TranscriptItem[] = [
      {
        id: 't1', kind: 'tool', name: 'grep', id_call: 'c1',
        args: '{"query":"authenticate"}',
        status: 'done', result: '12 matches',
      },
    ];
    const { lastFrame } = render(<Transcript items={items} />);
    expect(lastFrame()).toContain('"authenticate"');
  });
});
