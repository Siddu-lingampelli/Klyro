import { describe, it, expect } from 'vitest';
import { capTranscript, TRANSCRIPT_ITEM_CAP } from './app.js';
import type { TranscriptItem } from './transcript.js';

function item(id: number, kind: 'text' | 'tool', role = 'assistant'): TranscriptItem {
  return kind === 'text'
    ? { id: `u${id}`, kind: 'text', text: `t${id}`, role: role as 'user' | 'assistant' }
    : { id: `t${id}`, kind: 'tool', name: 'shell_exec', id_call: `c${id}`, args: '', result: 'ok', isError: false, latencyMs: 1, status: 'done' };
}

describe('capTranscript', () => {
  it('leaves short transcripts alone', () => {
    const prev = [item(1, 'text', 'user'), item(2, 'tool')];
    expect(capTranscript(prev)).toBe(prev);
  });

  it('bounds long transcripts, dropping oldest non-user items first', () => {
    const prev: TranscriptItem[] = [];
    for (let i = 0; i < TRANSCRIPT_ITEM_CAP + 100; i++) {
      prev.push(i % 2 === 0 ? item(i, 'text', 'user') : item(i, 'tool'));
    }
    const next = capTranscript(prev);
    expect(next.length).toBe(TRANSCRIPT_ITEM_CAP);
    // Every user prompt survives; only tool rows were shed.
    expect(next.filter((x) => x.kind === 'text').length).toBe(Math.ceil((TRANSCRIPT_ITEM_CAP + 100) / 2));
  });

  it('drops oldest-first when everything is user text', () => {
    const prev: TranscriptItem[] = [];
    for (let i = 0; i < TRANSCRIPT_ITEM_CAP + 10; i++) prev.push(item(i, 'text', 'user'));
    const next = capTranscript(prev);
    expect(next.length).toBe(TRANSCRIPT_ITEM_CAP);
    expect(next[0]).toEqual(item(10, 'text', 'user'));
  });
});
