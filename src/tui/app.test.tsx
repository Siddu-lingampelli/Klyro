import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from './app.js';
import type { TranscriptItem } from './transcript.js';
import type { StatusSnapshot } from './status.js';
import type { SlashCommand } from '../cli/slash/parser.js';

describe('App', () => {
  it('shows the empty-state hint and the status line', () => {
    const { lastFrame } = render(
      <App initialModel="mock" maxSteps={10} onPrompt={async () => {}} onSlash={async () => {}} />,
    );
    const out = lastFrame();
    expect(out).toContain('mock');
    expect(out).toMatch(/Type a prompt/);
  });

  it('renders initial transcript items', () => {
    const items: TranscriptItem[] = [
      { id: '1', kind: 'text', text: 'seed', role: 'user' },
    ];
    const { lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        onPrompt={async () => {}}
        onSlash={async () => {}}
        initialTranscript={items}
      />,
    );
    expect(lastFrame()).toContain('> seed');
  });

  it('honors initialStatus overrides', () => {
    const overrides: Partial<StatusSnapshot> = { step: 5, repairs: 3, status: 'running' };
    const { lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        onPrompt={async () => {}}
        onSlash={async () => {}}
        initialStatus={overrides}
      />,
    );
    const out = lastFrame();
    expect(out).toContain('5');
    expect(out).toContain('10');
    expect(out).toContain('3');
    expect(out).toContain('running');
  });

  it('installs and tears down the global bridge hooks', () => {
    const g = globalThis as unknown as { __klyroAppAppend?: unknown; __klyroAppStatus?: unknown };
    const { unmount } = render(
      <App initialModel="m" maxSteps={10} onPrompt={async () => {}} onSlash={async () => {}} />,
    );
    expect(g.__klyroAppAppend).toBeTypeOf('function');
    expect(g.__klyroAppStatus).toBeTypeOf('function');
    unmount();
    expect(g.__klyroAppAppend).toBeUndefined();
    expect(g.__klyroAppStatus).toBeUndefined();
  });

  it('submits a non-slash prompt via onPrompt', async () => {
    const onPrompt = vi.fn(async () => {});
    const { stdin } = render(
      <App initialModel="m" maxSteps={10} onPrompt={onPrompt} onSlash={async () => {}} />,
    );
    stdin.write('hello world');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\x0d');
    await new Promise((r) => setTimeout(r, 50));
    expect(onPrompt).toHaveBeenCalledWith('hello world');
  });

  it('routes a slash command to onSlash', async () => {
    const onSlash = vi.fn<(cmd: SlashCommand) => Promise<void>>(async () => {});
    const { stdin } = render(
      <App initialModel="m" maxSteps={10} onPrompt={async () => {}} onSlash={onSlash} />,
    );
    stdin.write('/help');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\x0d');
    await new Promise((r) => setTimeout(r, 50));
    expect(onSlash).toHaveBeenCalled();
    const call = onSlash.mock.calls[0]?.[0];
    expect(call?.kind).toBe('help');
  });

  it('ignores Enter while status is running', async () => {
    const onPrompt = vi.fn(async () => {});
    const { stdin } = render(
      <App
        initialModel="m"
        maxSteps={10}
        onPrompt={onPrompt}
        onSlash={async () => {}}
        initialStatus={{ status: 'running' }}
      />,
    );
    stdin.write('hello');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\x0d');
    await new Promise((r) => setTimeout(r, 50));
    expect(onPrompt).not.toHaveBeenCalled();
  });

  it('routes /quit to onSlash as a quit command', async () => {
    const onSlash = vi.fn<(cmd: SlashCommand) => Promise<void>>(async () => {});
    const { stdin } = render(
      <App initialModel="m" maxSteps={10} onPrompt={async () => {}} onSlash={onSlash} />,
    );
    stdin.write('/quit');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\x0d');
    await new Promise((r) => setTimeout(r, 50));
    expect(onSlash).toHaveBeenCalled();
    const call = (onSlash.mock.calls[0] as unknown as [SlashCommand] | undefined)?.[0];
    expect(call?.kind).toBe('quit');
  });
});
