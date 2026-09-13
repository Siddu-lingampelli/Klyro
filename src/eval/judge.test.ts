import { describe, it, expect } from 'vitest';
import { runJudge } from './judge.js';
import type { ProviderAdapter, StreamEvent } from '../agent/provider-adapter.js';

function scriptedJudge(reply: string): ProviderAdapter {
  const events: StreamEvent[][] = [[
    { kind: 'message_start' },
    { kind: 'text_delta', text: reply },
    { kind: 'message_end', finishReason: 'stop' },
  ]];
  let i = 0;
  return {
    id: 'judge-mock',
    async *stream() {
      if (i < events.length) {
        for (const ev of events[i++]!) yield ev;
      }
    },
  };
}

describe('runJudge', () => {
  it('passes when all rubric criteria score 1', async () => {
    const v = await runJudge(
      scriptedJudge('{"scores": {"c1": 1, "c2": 1}, "notes": "good"}'),
      'judge',
      { task: 'say done', finalText: 'All done.', toolCalls: 0 },
      ['contains done', 'is short'],
    );
    expect(v.pass).toBe(true);
    expect(v.scores).toEqual({ c1: 1, c2: 1 });
  });

  it('fails when any criterion scores 0', async () => {
    const v = await runJudge(
      scriptedJudge('{"scores": {"c1": 0}, "notes": "missing"}'),
      'judge',
      { task: 'say done', finalText: 'Hello.', toolCalls: 0 },
      ['contains done'],
    );
    expect(v.pass).toBe(false);
  });

  it('fails (never silently passes) on unparsable output', async () => {
    const v = await runJudge(
      scriptedJudge('I think it is fine, trust me.'),
      'judge',
      { task: 'x', finalText: 'y', toolCalls: 0 },
      ['anything'],
    );
    expect(v.pass).toBe(false);
    expect(v.notes).toMatch(/unparsable/);
  });

  it('passes vacuously on an empty rubric', async () => {
    const v = await runJudge(scriptedJudge('{}'), 'judge', { task: 'x', finalText: 'y', toolCalls: 0 }, []);
    expect(v.pass).toBe(true);
  });
});
