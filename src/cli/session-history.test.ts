import { describe, it, expect } from 'vitest';
import {
  shouldUseSimpleChat,
  looksLikeUrl,
  appendTurn,
  adoptTranscript,
  trimHistory,
  summaryAnchor,
  userMessage,
  assistantMessage,
  MAX_HISTORY_MESSAGES,
} from './session-history.js';
import type { Message } from '../agent/message.js';

describe('shouldUseSimpleChat', () => {
  it('keeps short chit-chat on the fast path', () => {
    expect(shouldUseSimpleChat('hello')).toBe(true);
    expect(shouldUseSimpleChat('what models are there')).toBe(true);
  });

  it('routes task words to the full loop', () => {
    expect(shouldUseSimpleChat('fix the login bug now please')).toBe(false);
  });

  it('forces the full loop for any URL so web_fetch can engage', () => {
    expect(shouldUseSimpleChat('https://llm7.io/models')).toBe(false);
    expect(shouldUseSimpleChat('check www.example.com/docs please')).toBe(false);
    expect(looksLikeUrl('see https://a.b/c')).toBe(true);
    expect(looksLikeUrl('just words')).toBe(false);
  });
});

describe('appendTurn', () => {
  it('accumulates user/assistant pairs so turn 2 sees turn 1', () => {
    let h: Message[] = [];
    h = appendTurn(h, 'https://llm7.io/models', 'catalogue of models');
    h = appendTurn(h, 'what models are there', '...');
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(h)).toContain('llm7.io');
  });

  it('caps runaway history pair-wise', () => {
    let h: Message[] = [];
    for (let i = 0; i < MAX_HISTORY_MESSAGES + 10; i++) {
      h = appendTurn(h, `q${i}`, `a${i}`);
    }
    expect(h.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    expect(h[0]?.role).toBe('user');
  });
});

describe('adoptTranscript', () => {
  it('keeps tool_use/tool_result pairs intact when trimming', () => {
    const big = 'x'.repeat(70_000);
    const history: Message[] = [
      userMessage('old task'),
      { role: 'assistant', content: [{ kind: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
      { role: 'tool', content: [{ kind: 'tool_result', toolCallId: 't1', name: 'read_file', output: big }] },
      userMessage('recent question'),
      assistantMessage('recent answer'),
    ];
    const out = adoptTranscript(history);
    // No orphaned tool_result may survive the cut.
    const uses = new Set(
      out.flatMap((m) => m.content.filter((b) => b.kind === 'tool_use').map((b) => (b as { id: string }).id)),
    );
    for (const m of out) {
      for (const b of m.content) {
        if (b.kind === 'tool_result') expect(uses.has(b.toolCallId)).toBe(true);
      }
    }
    expect(out[out.length - 1]).toEqual(assistantMessage('recent answer'));
  });

  it('passes short transcripts through untouched', () => {
    const h = [userMessage('a'), assistantMessage('b')];
    expect(adoptTranscript(h)).toEqual(h);
  });

  it('skips cuts that would orphan a tool_result', () => {
    const history: Message[] = [
      userMessage('a'),
      { role: 'assistant', content: [{ kind: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
    ];
    for (let i = 0; i < 29; i++) {
      history.push(userMessage(`q${i}`), assistantMessage(`a${i}`));
    }
    // 63 messages total: every fitting user-boundary cut drops the tool_use
    // but keeps its result, so only the trailing orphan-free pair survives.
    history.push(
      { role: 'tool', content: [{ kind: 'tool_result', toolCallId: 't1', name: 'read_file', output: 'x' }] },
      userMessage('final q'),
      assistantMessage('final a'),
    );
    expect(trimHistory(history)).toEqual([userMessage('final q'), assistantMessage('final a')]);
  });
});

describe('summaryAnchor', () => {
  it('seeds follow-up resolution after compact', () => {
    const h = summaryAnchor('We discussed llm7 models.');
    expect(h).toHaveLength(2);
    expect(JSON.stringify(h)).toContain('llm7');
  });
});

describe('trimHistory', () => {
  it('falls back to the last text pair when nothing valid fits', () => {
    const huge: Message = {
      role: 'tool',
      content: [{ kind: 'tool_result', toolCallId: 'missing', name: 'x', output: 'y'.repeat(70_000) }],
    };
    const out = trimHistory([userMessage('q'), huge, assistantMessage('a')]);
    expect(out.length).toBeLessThanOrEqual(2);
    expect(out[out.length - 1]?.role).toBe('assistant');
  });
});
