/**
 * scroll.md diagnostic: realistic session flow — seed history, stream a long
 * answer in chunks (like provider deltas), scroll mid-stream, stream more.
 * Asserts the chat-flow invariants the user actually sees:
 *   - follow-tail: latest streamed text visible while at bottom
 *   - freeze: pinned viewport doesn't move while streaming
 *   - badge counts new lines
 *   - frame never exceeds terminal rows (I1)
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from './app.js';
import type { TranscriptItem } from './transcript.js';

const PROPS = {
  initialModel: 'm',
  maxSteps: 10,
  cwd: '/test',
  onPrompt: async () => {},
  onSlash: async () => {},
} as const;

type TestHooks = {
  append?: (i: TranscriptItem) => void;
  appendDelta?: (t: string) => void;
  updateStatus?: (s: Record<string, unknown>) => void;
};
let testHooks: TestHooks = {};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const rowsOf = (frame: string) => frame.split('\n').length;

function seed(n: number): TranscriptItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `seed-${i}`,
    kind: 'text',
    text: `MSG-${i.toString().padStart(2, '0')}-tag`,
    role: 'user',
  })) as TranscriptItem[];
}

describe('scroll flow diagnostics', () => {
  it('reports terminal geometry (debug aid)', async () => {
    const { lastFrame } = render(<App {...PROPS} isFullscreen={true} onMounted={(h) => { testHooks = h as unknown as TestHooks; }} />);
    await tick(50);
    const frame = lastFrame() ?? '';
    console.log(`[diag] frame rows=${rowsOf(frame)} cols~${(frame.split('\n')[0] ?? '').length}`);
    expect(rowsOf(frame)).toBeLessThanOrEqual(32);
  });

  it('follow-tail: streamed long answer stays visible, frame stays bounded', async () => {
    const { lastFrame } = render(
      <App {...PROPS} isFullscreen={true} initialTranscript={seed(5)} onMounted={(h) => { testHooks = h as unknown as TestHooks; }} />,
    );
    await tick(50);
    testHooks.updateStatus!({ status: 'running' });
    const chunk = 'STREAMCHUNK lorem ipsum dolor sit amet. ';
    for (let i = 0; i < 12; i++) {
      testHooks.appendDelta!(`${chunk}#${i} `);
      // Tick longer than the 64ms streaming render throttle so the flush
      // has landed before asserting visibility (follow-tail, not latency).
      await tick(90);
      const frame = lastFrame() ?? '';
      expect(rowsOf(frame)).toBeLessThanOrEqual(32);
      // latest streamed chunk must be visible (follow-tail)
      expect(frame).toContain(`#${i}`);
    }
  });

  it('freeze: pinned top survives streaming, badge counts, End restores', async () => {
    const { stdin, lastFrame } = render(
      <App {...PROPS} isFullscreen={true} initialTranscript={seed(40)} onMounted={(h) => { testHooks = h as unknown as TestHooks; }} />,
    );
    await tick(100);
    stdin.write('\x1b[H'); // Home → top
    await tick(50);
    const top = lastFrame() ?? '';
    expect(top).toContain('MSG-00-tag');
    testHooks.updateStatus!({ status: 'running' });
    for (let i = 0; i < 5; i++) {
      testHooks.appendDelta!(`late chunk number ${i} with filler words here. `);
      await tick(40);
    }
    const frozen = lastFrame() ?? '';
    expect(frozen).toContain('MSG-00-tag'); // viewport did not yank down
    expect(frozen).toMatch(/↓ \d+ unread/); // badge visible
    expect(rowsOf(frozen)).toBeLessThanOrEqual(32);
    stdin.write('\x1b[F'); // End → follow
    // Poll, don't sleep once: the tail flush (64ms throttle) plus React
    // commit land on their own schedule and fixed 50ms sleeps flake
    // under parallel-suite load.
    let tail = '';
    for (let i = 0; i < 80; i++) {
      await tick(50);
      tail = lastFrame() ?? '';
      if (tail.includes('number 4')) break;
    }
    expect(tail).toContain('number 4');
  });

  it('wrapped long item: pin mid-item, stream, same first line stays', async () => {
    // Heavy string measurement + React flush under full-suite parallel load;
    // the default 10s testTimeout flaked — extend for this one.
    const long = Array.from({ length: 10 }, (_, i) => `WRAPLINE-${i} ` + 'x'.repeat(180)).join('\n');
    const items: TranscriptItem[] = [
      { id: 'w1', kind: 'text', text: long, role: 'assistant' },
      ...seed(30),
    ];
    const { stdin, lastFrame } = render(
      <App {...PROPS} isFullscreen={true} initialTranscript={items} onMounted={(h) => { testHooks = h as unknown as TestHooks; }} />,
    );
    await tick(100);
    stdin.write('\x1b[H');
    await tick(50);
    const before = (lastFrame() ?? '').split('\n').slice(0, 3).join('\n');
    testHooks.updateStatus!({ status: 'running' });
    for (let i = 0; i < 5; i++) {
      testHooks.appendDelta!(`more streamed text ${i} ` + 'y'.repeat(120));
      await tick(40);
    }
    const after = (lastFrame() ?? '').split('\n').slice(0, 3).join('\n');
    expect(after).toBe(before); // anchor stability at line granularity
  }, 30_000);

  it('a single answer taller than the viewport still scrolls (rowShift)', async () => {
    // Regression: virtualization sliced whole groups, so one giant text
    // group pinned the view to its head — follow-tail showed stale rows
    // while ⇅ advanced, and PgUp/End moved nothing visible.
    const { stdin, lastFrame } = render(<App {...PROPS} isFullscreen={true} onMounted={(h) => { testHooks = h as unknown as TestHooks; }} />);
    await tick(100);
    testHooks.updateStatus!({ status: 'running' });
    for (let i = 0; i < 40; i++) {
      testHooks.appendDelta!(`G-${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod `);
      await tick(90);
    }
    // Follow-tail: newest chunk visible, oldest scrolled away.
    const filled = lastFrame() ?? '';
    expect(filled).toContain('G-39');
    expect(filled).not.toContain('G-0 ');
    // PageUp: tail leaves, middle appears.
    stdin.write('\x1b[5~');
    await tick(100);
    const up = lastFrame() ?? '';
    expect(up).not.toContain('G-39');
    expect(up).toContain('G-10');
    // Home: all the way up. End: back to the live tail.
    stdin.write('\x1b[H');
    await tick(100);
    const top = lastFrame() ?? '';
    expect(top).toContain('G-0 ');
    expect(top).not.toContain('G-39');
    stdin.write('\x1b[F');
    await tick(100);
    expect(lastFrame() ?? '').toContain('G-39');
  }, 30_000);
});
