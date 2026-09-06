import { describe, it, expect } from 'vitest';
import { httpChatAdapter } from './provider-adapter.js';
import type { CallRequest } from './provider-adapter.js';

function sseFetch(body: string): typeof fetch {
  return (async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
}

const baseReq: CallRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
  tools: [],
};

describe('httpChatAdapter thinking channel', () => {
  it('yields thinking_delta for reasoning_content without touching text', async () => {
    const body =
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"let me think"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const adapter = httpChatAdapter({ baseURL: 'https://x.example', apiKey: '', fetchImpl: sseFetch(body) });
    const kinds: Array<{ kind: string; text?: string }> = [];
    for await (const ev of adapter.stream(baseReq)) {
      kinds.push({ kind: ev.kind, text: (ev as { text?: string }).text });
    }
    expect(kinds).toContainEqual({ kind: 'thinking_delta', text: 'let me think' });
    expect(kinds).toContainEqual({ kind: 'text_delta', text: 'answer' });
  });

  it('emits no thinking events when the provider sends none', async () => {
    const body =
      'data: {"choices":[{"index":0,"delta":{"content":"plain"},"finish_reason":null}]}\n\n' +
      'data: [DONE]\n\n';
    const adapter = httpChatAdapter({ baseURL: 'https://x.example', apiKey: '', fetchImpl: sseFetch(body) });
    const kinds: string[] = [];
    for await (const ev of adapter.stream(baseReq)) kinds.push(ev.kind);
    expect(kinds).not.toContain('thinking_delta');
    expect(kinds).toContain('text_delta');
  });
});
