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

type Hooks = {
  __klyroAppAppend?: (i: TranscriptItem) => void;
  __klyroAppendDelta?: (t: string) => void;
  __klyroAppStatus?: (s: Record<string, unknown>) => void;
};
const g = globalThis as unknown as Hooks;
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
    const { lastFrame } = render(<App {...PROPS} isFullscreen={true} />);
    await tick(50);
    const frame = lastFrame() ?? '';
    // eslint-disable-next-line no-console
    console.log(`[diag] frame rows=${rowsOf(frame)} cols~${(frame.split('\n')[0] ?? '').length}`);
    expect(rowsOf(frame)).toBeLessThanOrEqual(32);
  });

  it('follow-tail: streamed long answer stays visible, frame stays bounded', async () => {
    const { lastFrame } = render(
      <App {...PROPS} isFullscreen={true} initialTranscript={seed(5)} />,
    );
    await tick(50);
    g.__klyroAppStatus!({ status: 'running' });
    const chunk = 'STREAMCHUNK lorem ipsum dolor sit amet. ';
    for (let i = 0; i < 12; i++) {
      g.__klyroAppendDelta!(`${chunk}#${i} `);
      await tick(40);
      const frame = lastFrame() ?? '';
      expect(rowsOf(frame)).toBeLessThanOrEqual(32);
      // latest streamed chunk must be visible (follow-tail)
      expect(frame).toContain(`#${i}`);
    }
  });

  it('freeze: pinned top survives streaming, badge counts, End restores', async () => {
    const { stdin, lastFrame } = render(
      <App {...PROPS} isFullscreen={true} initialTranscript={seed(40)} />,
    );
    await tick(100);
    stdin.write('\x1b[H'); // Home → top
    await tick(50);
    const top = lastFrame() ?? '';
    expect(top).toContain('MSG-00-tag');
    g.__klyroAppStatus!({ status: 'running' });
    for (let i = 0; i < 5; i++) {
      g.__klyroAppendDelta!(`late chunk number ${i} with filler words here. `);
      await tick(40);
    }
    const frozen = lastFrame() ?? '';
    expect(frozen).toContain('MSG-00-tag'); // viewport did not yank down
    expect(frozen).toMatch(/↓ \d+ new/); // badge visible
    expect(rowsOf(frozen)).toBeLessThanOrEqual(32);
    stdin.write('\x1b[F'); // End → follow
    await tick(50);
    expect(lastFrame() ?? '').toContain('number 4');
  });

  it('wrapped long item: pin mid-item, stream, same first line stays', async () => {
    const long = Array.from({ length: 10 }, (_, i) => `WRAPLINE-${i} ` + 'x'.repeat(180)).join('\n');
    const items: TranscriptItem[] = [
      { id: 'w1', kind: 'text', text: long, role: 'assistant' },
      ...seed(30),
    ];
    const { stdin, lastFrame } = render(
      <App {...PROPS} isFullscreen={true} initialTranscript={items} />,
    );
    await tick(100);
    stdin.write('\x1b[H');
    await tick(50);
    const before = (lastFrame() ?? '').split('\n').slice(0, 3).join('\n');
    g.__klyroAppStatus!({ status: 'running' });
    for (let i = 0; i < 5; i++) {
      g.__klyroAppendDelta!(`more streamed text ${i} ` + 'y'.repeat(120));
      await tick(40);
    }
    const after = (lastFrame() ?? '').split('\n').slice(0, 3).join('\n');
    expect(after).toBe(before); // anchor stability at line granularity
  });
});
