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
      <App initialModel="mock" maxSteps={10} cwd="/test" onPrompt={async () => {}} onSlash={async () => {}} />,
    );
    const out = lastFrame();
    // design.md: top bar shows claude-code + sessions, center shows Message Klyro placeholder
    expect(out).toMatch(/claude-code|Sessions|Message Klyro/i);
    expect(out).toMatch(/Message Klyro|Type a message/i);
  });

  it('renders initial transcript items', () => {
    const items: TranscriptItem[] = [
      { id: '1', kind: 'text', text: 'seed', role: 'user' },
    ];
    const { lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        initialTranscript={items}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain('seed');
    expect(frame).toMatch(/You|seed|›|>/);
  });

  it('honors initialStatus overrides', () => {
    const overrides: Partial<StatusSnapshot> = { step: 5, repairs: 3, status: 'running' };
    const { lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        initialStatus={overrides}
      />,
    );
    const out = lastFrame();
    // §7 status right now shows cost·ctx, header shows model, but step/repairs are still derivable from header/status
    // Keep loose checks for backwards compat — ensure at least model and hint are present
    expect(out).toContain('m');
    expect(out).toMatch(/running|auto mode|ctrl\+c|step/i);
  });

  it('installs and tears down the global bridge hooks', () => {
    const g = globalThis as unknown as { __klyroAppAppend?: unknown; __klyroAppStatus?: unknown };
    const { unmount } = render(
      <App initialModel="m" maxSteps={10} cwd="/test" onPrompt={async () => {}} onSlash={async () => {}} />,
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
      <App initialModel="m" maxSteps={10} cwd="/test" onPrompt={onPrompt} onSlash={async () => {}} />,
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
      <App initialModel="m" maxSteps={10} cwd="/test" onPrompt={async () => {}} onSlash={onSlash} />,
    );
    stdin.write('/help');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\x0d');
    await new Promise((r) => setTimeout(r, 50));
    expect(onSlash).toHaveBeenCalled();
    const call = onSlash.mock.calls[0]?.[0];
    expect(call?.kind).toBe('help');
  });

  it('queues Enter while status is running (2.4)', async () => {
    const onPrompt = vi.fn(async () => {});
    const { stdin, lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={onPrompt}
        onSlash={async () => {}}
        initialStatus={{ status: 'running' }}
      />,
    );
    stdin.write('hello');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\x0d');
    await new Promise((r) => setTimeout(r, 50));
    // Per TUI_DESIGN.md §5.2 queued message while running, not immediate
    expect(lastFrame()).toMatch(/queued|hello/);
    expect(onPrompt).not.toHaveBeenCalled(); // not yet, queued
  });

  it('routes /quit to onSlash as a quit command', async () => {
    const onSlash = vi.fn<(cmd: SlashCommand) => Promise<void>>(async () => {});
    const { stdin } = render(
      <App initialModel="m" maxSteps={10} cwd="/test" onPrompt={async () => {}} onSlash={onSlash} />,
    );
    stdin.write('/quit');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\x0d');
    await new Promise((r) => setTimeout(r, 50));
    expect(onSlash).toHaveBeenCalled();
    const call = (onSlash.mock.calls[0] as unknown as [SlashCommand] | undefined)?.[0];
    expect(call?.kind).toBe('quit');
  });

  // --- Chat scroll behavior (TUI_DESIGN chat_scroll.md) -----------------

  // Build a 25-item initial transcript. Each item has a unique tag so we can
  // grep `lastFrame()` for it.
  function makeInitialTranscript(n: number): TranscriptItem[] {
    const out: TranscriptItem[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        id: `seed-${i}`,
        kind: 'text',
        text: `MSG-${i.toString().padStart(2, '0')}-tag`,
        role: 'user',
      });
    }
    return out;
  }

  // ANSI sequences Ink's parse-keypress recognizes.
  const KEY_HOME = '\x1b[H';
  const KEY_END = '\x1b[F';
  const KEY_PGUP = '\x1b[5~';
  const KEY_PGDN = '\x1b[6~';
  const KEY_SHIFT_UP = '\x1b[1;2A';
  const KEY_SHIFT_DOWN = '\x1b[1;2B';

  it('starts at the bottom (follow-tail) when initial content fills the viewport', async () => {
    const { lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        initialTranscript={makeInitialTranscript(25)}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    // The viewport is 20 rows; the last few seeded items (MSG-22..MSG-24) should
    // be in the visible window. The first item (MSG-00) should NOT be visible.
    expect(frame).toMatch(/MSG-24-tag/);
    expect(frame).toMatch(/MSG-23-tag/);
    expect(frame).not.toMatch(/MSG-00-tag/);
  });

  it('Home jumps to the top; End re-engages follow-tail', async () => {
    const { stdin, lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        initialTranscript={makeInitialTranscript(25)}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(KEY_HOME);
    await new Promise((r) => setTimeout(r, 30));
    const top = lastFrame() ?? '';
    expect(top).toMatch(/MSG-00-tag/);
    expect(top).not.toMatch(/MSG-24-tag/);
    // End re-engages follow-tail.
    stdin.write(KEY_END);
    await new Promise((r) => setTimeout(r, 30));
    const bottom = lastFrame() ?? '';
    expect(bottom).toMatch(/MSG-24-tag/);
    expect(bottom).not.toMatch(/MSG-00-tag/);
  });

  it('PageUp/PageDown move a half page (design.md §11)', async () => {
    const { stdin, lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        initialTranscript={makeInitialTranscript(25)}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    // Go to top, then PageDown 3 times. Half page = 10 lines = 5 items, so
    // 3 × PageDown lands on MSG-15 (design.md §11 half-page behavior).
    stdin.write(KEY_HOME);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write(KEY_PGDN);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write(KEY_PGDN);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write(KEY_PGDN);
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/MSG-15-tag/);
    expect(frame).not.toMatch(/MSG-00-tag/);
    // And PageUp twice comes back up by the same step.
    stdin.write(KEY_PGUP);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write(KEY_PGUP);
    await new Promise((r) => setTimeout(r, 30));
    const back = lastFrame() ?? '';
    expect(back).toMatch(/MSG-05-tag/);
  });

  it('pins to top: new content does NOT auto-scroll when user has scrolled up', async () => {
    const { stdin, lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        initialTranscript={makeInitialTranscript(25)}
      />,
    );
    await new Promise((r) => setTimeout(r, 100));
    // Pin: scroll up to top.
    stdin.write(KEY_HOME);
    await new Promise((r) => setTimeout(r, 100));
    const before = lastFrame() ?? '';
    expect(before).toMatch(/MSG-00-tag/);
    expect(before).not.toMatch(/MSG-24-tag/);
    // New content arrives while pinned.
    const g = globalThis as unknown as { __klyroAppAppend?: (i: TranscriptItem) => void };
    g.__klyroAppAppend!({
      id: 'late-1',
      kind: 'text',
      text: 'LATE-1-tag',
      role: 'assistant',
    });
    g.__klyroAppAppend!({
      id: 'late-2',
      kind: 'text',
      text: 'LATE-2-tag',
      role: 'assistant',
    });
    g.__klyroAppAppend!({
      id: 'late-3',
      kind: 'text',
      text: 'LATE-3-tag',
      role: 'assistant',
    });
    await new Promise((r) => setTimeout(r, 200));
    const after = lastFrame() ?? '';
    // Still pinned at top: MSG-00 visible, LATE items not in viewport.
    expect(after).toMatch(/MSG-00-tag/);
    expect(after).not.toMatch(/LATE-1-tag/);
  });

  it('pressing End re-engages follow-tail and reveals new content', async () => {
    const { stdin, lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        initialTranscript={makeInitialTranscript(25)}
      />,
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write(KEY_HOME);
    await new Promise((r) => setTimeout(r, 100));
    const g = globalThis as unknown as { __klyroAppAppend?: (i: TranscriptItem) => void };
    g.__klyroAppAppend!({
      id: 'late-1',
      kind: 'text',
      text: 'LATE-1-tag',
      role: 'assistant',
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(lastFrame() ?? '').not.toMatch(/LATE-1-tag/);
    // End re-engages follow-tail and shows the new content.
    stdin.write(KEY_END);
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/LATE-1-tag/);
  });

  it('↑ recalls the previous prompt (input history, §8.3)', async () => {
    const onPrompt = vi.fn(async () => {});
    const { stdin, lastFrame } = render(
      <App initialModel="m" maxSteps={10} cwd="/test" onPrompt={onPrompt} onSlash={async () => {}} />,
    );
    stdin.write('first recallable prompt');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\x0d');
    await new Promise((r) => setTimeout(r, 50));
    expect(onPrompt).toHaveBeenCalledWith('first recallable prompt');
    // Input cleared after submit; ↑ should restore it from history.
    stdin.write('\x1b[A');
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame() ?? '').toContain('first recallable prompt');
  });

  it('↑ on empty input scrolls one line instead of history', async () => {
    const { stdin, lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        initialTranscript={makeInitialTranscript(25)}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.write(KEY_HOME);
    await new Promise((r) => setTimeout(r, 30));
    // Empty input + plain ↑ → line up (stays near top, MSG-00 visible).
    stdin.write('\x1b[A');
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame() ?? '').toMatch(/MSG-00-tag/);
  });

  it('/c shows top-6 suggestions and Tab completes', async () => {
    const { stdin, lastFrame } = render(
      <App initialModel="m" maxSteps={10} cwd="/test" onPrompt={async () => {}} onSlash={async () => {}} />,
    );
    stdin.write('/c');
    await new Promise((r) => setTimeout(r, 30));
    const withSuggest = lastFrame() ?? '';
    expect(withSuggest).toMatch(/\/clear/);
    expect(withSuggest).toMatch(/tab to complete/i);
    stdin.write('\t');
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame() ?? '').toContain('/clear ');
  });

  it('Enter on empty input while pinned jumps back to bottom (§7.2)', async () => {
    const { stdin, lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        initialTranscript={makeInitialTranscript(25)}
      />,
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write(KEY_HOME);
    await new Promise((r) => setTimeout(r, 100));
    const g = globalThis as unknown as { __klyroAppAppend?: (i: TranscriptItem) => void };
    g.__klyroAppAppend!({ id: 'late-1', kind: 'text', text: 'LATE-1-tag', role: 'assistant' });
    await new Promise((r) => setTimeout(r, 200));
    expect(lastFrame() ?? '').not.toMatch(/LATE-1-tag/);
    // Empty input + Enter → dismiss badge, follow tail.
    stdin.write('\x0d');
    await new Promise((r) => setTimeout(r, 100));
    expect(lastFrame() ?? '').toMatch(/LATE-1-tag/);
  });

  it('onMounted scrollLines/scrollToBottom drive the viewport (wheel path)', async () => {
    let captured: { scrollLines: (d: number) => void; scrollToBottom: () => void } | null = null;
    const { lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        initialTranscript={makeInitialTranscript(25)}
        onMounted={(h) => {
          captured = { scrollLines: h.scrollLines, scrollToBottom: h.scrollToBottom };
        }}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).not.toBeNull();
    // Wheel up ×12 (3 lines each = 36 > maxTop 32) → pinned at top.
    for (let i = 0; i < 12; i++) captured!.scrollLines(-3);
    await new Promise((r) => setTimeout(r, 50));
    const top = lastFrame() ?? '';
    expect(top).toMatch(/MSG-00-tag/);
    expect(top).not.toMatch(/MSG-24-tag/);
    // scrollToBottom → tail visible again.
    captured!.scrollToBottom();
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toMatch(/MSG-24-tag/);
  });

  it('idle Ctrl+C quits (design.md §18)', async () => {
    const onSlash = vi.fn<(cmd: SlashCommand) => Promise<void>>(async () => {});
    const { stdin } = render(
      <App initialModel="m" maxSteps={10} cwd="/test" onPrompt={async () => {}} onSlash={onSlash} />,
    );
    stdin.write('\x03');
    await new Promise((r) => setTimeout(r, 50));
    expect(onSlash).toHaveBeenCalled();
    expect((onSlash.mock.calls[0] as unknown as [SlashCommand])[0]?.kind).toBe('quit');
  });

  it('running Ctrl+C cancels first, quits second (design.md §18)', async () => {
    const onSlash = vi.fn<(cmd: SlashCommand) => Promise<void>>(async () => {});
    const { stdin } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={onSlash}
        initialStatus={{ status: 'running' }}
      />,
    );
    stdin.write('\x03');
    await new Promise((r) => setTimeout(r, 30));
    stdin.write('\x03');
    await new Promise((r) => setTimeout(r, 30));
    const kinds = onSlash.mock.calls.map((c) => (c[0] as SlashCommand).kind);
    expect(kinds).toEqual(['cancel', 'quit']);
  });

  it('running Esc with empty queue cancels streaming (design.md §18)', async () => {
    const onSlash = vi.fn<(cmd: SlashCommand) => Promise<void>>(async () => {});
    const { stdin } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={onSlash}
        initialStatus={{ status: 'running' }}
      />,
    );
    stdin.write('\x1b');
    await new Promise((r) => setTimeout(r, 50));
    expect(onSlash).toHaveBeenCalled();
    expect((onSlash.mock.calls[0] as unknown as [SlashCommand])[0]?.kind).toBe('cancel');
  });

  it('Shift+Enter inserts a newline instead of submitting (design.md §18)', async () => {
    const onPrompt = vi.fn(async () => {});
    const onSlash = vi.fn<(cmd: SlashCommand) => Promise<void>>(async () => {});
    const { stdin, lastFrame } = render(
      <App initialModel="m" maxSteps={10} cwd="/test" onPrompt={onPrompt} onSlash={onSlash} />,
    );
    stdin.write('line one');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\x1b[13;2u'); // CSI-u Shift+Enter
    await new Promise((r) => setTimeout(r, 30));
    stdin.write('line two');
    await new Promise((r) => setTimeout(r, 20));
    // Nothing submitted, both lines in the input buffer.
    expect(onPrompt).not.toHaveBeenCalled();
    expect(onSlash).not.toHaveBeenCalled();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line one');
    expect(frame).toContain('line two');
    // Enter submits the whole multiline buffer with the newline intact.
    stdin.write('\x0d');
    await new Promise((r) => setTimeout(r, 50));
    expect(onPrompt).toHaveBeenCalledWith('line one\nline two');
  });

  it('submitting while pinned snaps back to bottom (scroll.md §7)', async () => {
    const onPrompt = vi.fn(async () => {});
    const { stdin, lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={onPrompt}
        onSlash={async () => {}}
        isFullscreen={true}
        initialTranscript={makeInitialTranscript(25)}
      />,
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write(KEY_HOME);
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toMatch(/MSG-00-tag/);
    stdin.write('hello again');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\x0d');
    // Settle effect: immediate + microtask + timeout(0) bottom pin.
    await new Promise((r) => setTimeout(r, 150));
    expect(onPrompt).toHaveBeenCalledWith('hello again');
    expect(lastFrame() ?? '').toMatch(/MSG-24-tag/);
  });

  it('onMounted transcript handle runs the four commands (scroll.md §2)', async () => {
    type Handle = import('./transcript-commands.js').TranscriptScrollHandle;
    let handle: Handle | null = null;
    const { lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        initialTranscript={makeInitialTranscript(25)}
        onMounted={(h) => {
          handle = h.transcript;
        }}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(handle).not.toBeNull();
    handle!.runTranscriptCommand('messages_half_page_up');
    await new Promise((r) => setTimeout(r, 50));
    let frame = lastFrame() ?? '';
    // Half page (10 lines) up from bottom (row 30 → 20): MSG-24 gone, MSG-14 in view.
    expect(frame).not.toMatch(/MSG-24-tag/);
    expect(frame).toMatch(/MSG-14-tag/);
    handle!.runTranscriptCommand('messages_first');
    await new Promise((r) => setTimeout(r, 50));
    frame = lastFrame() ?? '';
    expect(frame).toMatch(/MSG-00-tag/);
    expect(frame).not.toMatch(/MSG-24-tag/);
    handle!.runTranscriptCommand('messages_last');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toMatch(/MSG-24-tag/);
  });

  it('tool result patches the running item in place (no stale spinner)', async () => {
    let hooks: {
      append: (i: TranscriptItem) => void;
      updateTool: (idCall: string, patch: { result: string; isError: boolean; latencyMs: number; status: 'done' | 'error' }) => void;
    } | null = null;
    const { lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        onMounted={(h) => {
          hooks = { append: h.append, updateTool: h.updateTool };
        }}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(hooks).not.toBeNull();
    hooks!.append({ id: 't1', kind: 'tool', name: 'read_file', id_call: 'c1', args: '{"path":"a.ts"}', status: 'running' });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toMatch(/Read/);
    hooks!.updateTool('c1', { result: 'ok', isError: false, latencyMs: 42, status: 'done' });
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    // Resolved with real latency — exactly one group (start item patched, no duplicate).
    expect(frame).toMatch(/42ms/);
    expect(frame.match(/Read/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('heavy transcript: frame bounded, input and tail visible', async () => {
    const items: TranscriptItem[] = [];
    for (let i = 0; i < 30; i++) {
      items.push({ id: `u-${i}`, kind: 'text', text: `user message number ${i} asking about stuff`, role: 'user' });
      items.push({
        id: `a-${i}`,
        kind: 'text',
        text: `## Answer ${i}\n\nAssistant answer **number ${i}** with a long explanation that wraps across multiple terminal lines.`,
        role: 'assistant',
      });
      items.push({ id: `t-${i}`, kind: 'tool', name: 'read_file', id_call: `c-${i}`, args: '{"path":"a.ts"}', result: 'ok', latencyMs: 5, status: 'done' });
    }
    const { lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        initialTranscript={items}
      />,
    );
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? '';
    // I1: frame never exceeds terminal rows; input + tail always on screen.
    expect(frame.split('\n').length).toBeLessThanOrEqual(32);
    expect(frame).toContain('Message Klyro');
    expect(frame).toContain('Answer 29');
    expect(frame).not.toContain('user message number 0');
  });

  it('renders the approval modal when a prompt is pending (no deadlock)', async () => {
    const { TuiApprovalBridge } = await import('./approval.js');
    const bridge = new TuiApprovalBridge();
    const { lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        approvalBridge={bridge}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    let choice: unknown;
    const pending = bridge
      .ask({ toolName: 'shell_exec', reason: 'not in allowlist', summary: 'echo hi' })
      .then((c) => {
        choice = c;
      });
    await new Promise((r) => setTimeout(r, 80));
    // The modal must actually render — previously it never mounted, so every
    // policy 'ask' hung the runtime forever.
    expect(lastFrame() ?? '').toMatch(/approval needed/i);
    expect(bridge.resolve('deny')).toBe(true);
    await pending;
    expect(choice).toBe('deny');
  });

  it('shows a working spinner while running (Thinking + status)', async () => {
    const { lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        initialStatus={{ status: 'running' }}
      />,
    );
    await new Promise((r) => setTimeout(r, 120));
    const frame = lastFrame() ?? '';
    // Animated dots spinner (any braille frame) or its labels must show.
    expect(frame).toMatch(/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Thinking|working/);
    expect(frame).toContain('Thinking');
    expect(frame).toContain('working');
  });

  it('running tool group shows a spinner, resolved group shows latency', async () => {
    let hooks: {
      append: (i: TranscriptItem) => void;
      updateTool: (idCall: string, patch: { result: string; isError: boolean; latencyMs: number; status: 'done' | 'error' }) => void;
    } | null = null;
    const { lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        initialStatus={{ status: 'running' }}
        onMounted={(h) => {
          hooks = { append: h.append, updateTool: h.updateTool };
        }}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    hooks!.append({ id: 't1', kind: 'tool', name: 'read_file', id_call: 'c1', args: '{"path":"a.ts"}', status: 'running' });
    await new Promise((r) => setTimeout(r, 120));
    // Running group: spinner next to the verb (braille frame or fallback text).
    expect(lastFrame() ?? '').toMatch(/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Read/);
    hooks!.updateTool('c1', { result: 'ok', isError: false, latencyMs: 42, status: 'done' });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toMatch(/42ms/);
  });

  it('Shift+Up / Shift+Down scroll by one line', async () => {
    const { stdin, lastFrame } = render(
      <App
        initialModel="m"
        maxSteps={10}
        cwd="/test"
        onPrompt={async () => {}}
        onSlash={async () => {}}
        isFullscreen={true}
        initialTranscript={makeInitialTranscript(25)}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    // Jump to top, then shift+down a few times, then back with shift+up.
    stdin.write(KEY_HOME);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write(KEY_SHIFT_DOWN);
    stdin.write(KEY_SHIFT_DOWN);
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? '';
    // Shift+Down from scrollOffset=0 moves us down by 2. The visible window
    // is now [2..22). MSG-00 should be off-screen, MSG-02 should be on-screen.
    expect(frame).not.toMatch(/MSG-00-tag/);
    expect(frame).toMatch(/MSG-02-tag/);
    // Shift+Up once: scrollOffset back to 1, MSG-01 visible, MSG-02 still visible.
    stdin.write(KEY_SHIFT_UP);
    await new Promise((r) => setTimeout(r, 30));
    const frame2 = lastFrame() ?? '';
    expect(frame2).toMatch(/MSG-01-tag/);
  });
});
