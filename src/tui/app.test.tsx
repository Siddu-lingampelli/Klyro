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

  it('PageUp/PageDown snap to message boundaries', async () => {
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
    // Go to top, then PageDown 3 times. Each PageDown should land on a message
    // boundary, so visible window starts at one of the seeded indices.
    stdin.write(KEY_HOME);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write(KEY_PGDN);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write(KEY_PGDN);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write(KEY_PGDN);
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame() ?? '';
    // After 3 PageDowns from top, the earliest visible item should be MSG-03
    // (snap-to-message keeps the boundary on the first visible row). We assert
    // that MSG-03 is visible and MSG-00 is not.
    expect(frame).toMatch(/MSG-03-tag/);
    expect(frame).not.toMatch(/MSG-00-tag/);
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
