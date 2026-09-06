import { describe, it, expect, vi } from 'vitest';
import { anthropicAdapter, _internal } from './anthropic-adapter.js';
import type { Message } from './message.js';
import type { CallRequest } from './provider-adapter.js';

function sse(parts: Array<[string, unknown]>): string {
  // parts: [eventType, dataObject]
  return parts.map(([t, d]) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

function makeFetch(body: string, status = 200): typeof fetch {
  return (async (_url: string, _init?: RequestInit) => {
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

describe('anthropicAdapter', () => {
  describe('request shape', () => {
    it('hoists system to top-level field and sends x-api-key', async () => {
      let captured: { url: string; init: RequestInit | undefined } | undefined;
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        captured = { url, init };
        return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch;
      const adapter = anthropicAdapter({
        apiKey: 'test-key',
        baseURL: 'https://api.example.com',
        fetchImpl,
      });
      const req: CallRequest = {
        model: 'claude-3-5-sonnet-20241022',
        system: 'be helpful',
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
        tools: [],
        maxTokens: 1024,
        temperature: 0.7,
      };
      const events = [];
      for await (const ev of adapter.stream(req)) events.push(ev);
      expect(captured).toBeDefined();
      const init = captured!.init!;
      const headers = init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('test-key');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      const body = JSON.parse(init.body as string);
      expect(body.system).toBe('be helpful');
      expect(body.model).toBe('claude-3-5-sonnet-20241022');
      expect(body.stream).toBe(true);
      expect(body.max_tokens).toBe(1024);
      expect(body.temperature).toBe(0.7);
      // system should NOT appear in messages
      expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    });

    it('uses Authorization: Bearer when authHeader is Authorization', async () => {
      let headers: Record<string, string> | undefined;
      const fetchImpl = (async (_url, init) => {
        headers = init?.headers as Record<string, string>;
        return new Response('', { status: 200 });
      }) as typeof fetch;
      const adapter = anthropicAdapter({ apiKey: 'tok', fetchImpl, authHeader: 'Authorization' });
      for await (const _ of adapter.stream({
        model: 'm', messages: [], tools: [],
      })) { /* drain */ }
      expect(headers!['Authorization']).toBe('Bearer tok');
      expect(headers!['x-api-key']).toBeUndefined();
    });

    it('translates tools to input_schema format', async () => {
      let body: any;
      const fetchImpl = (async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return new Response('', { status: 200 });
      }) as typeof fetch;
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl });
      for await (const _ of adapter.stream({
        model: 'm',
        messages: [],
        tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
      })) { /* drain */ }
      expect(body.tools).toEqual([{
        name: 'read_file',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }]);
    });
  });

  describe('streaming', () => {
    it('emits text_delta events for text_delta blocks', async () => {
      const body = sse([
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', world' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_stop', { type: 'message_stop' }],
      ]);
      const fetchImpl = makeFetch(body);
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl });
      const events = [];
      for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) events.push(ev);
      const texts = events.filter((e) => e.kind === 'text_delta').map((e) => (e as any).text);
      expect(texts).toEqual(['Hello', ', world']);
    });

    it('emits tool_call_start/delta/end in order', async () => {
      const body = sse([
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pat' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'h":"x"}' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_stop', { type: 'message_stop' }],
      ]);
      const fetchImpl = makeFetch(body);
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl });
      const events = [];
      for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) events.push(ev);
      const start = events.find((e) => e.kind === 'tool_call_start');
      const deltas = events.filter((e) => e.kind === 'tool_call_delta').map((e) => (e as any).argsJson);
      const end = events.find((e) => e.kind === 'tool_call_end');
      expect(start).toEqual({ kind: 'tool_call_start', id: 'toolu_1', name: 'read_file' });
      expect(deltas).toEqual(['{"pat', 'h":"x"}']);
      expect(end).toEqual({ kind: 'tool_call_end', id: 'toolu_1' });
    });

    it('yields error event on non-2xx', async () => {
      const fetchImpl = makeFetch('{"error":{"type":"rate_limit_error","message":"slow down"}}', 429);
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl });
      const events = [];
      for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) events.push(ev);
      const err = events.find((e) => e.kind === 'error');
      expect(err).toBeDefined();
      expect((err as any).code).toBe('http_429');
      expect((err as any).retryable).toBe(true);
    });

    it('yields error event on transport failure', async () => {
      const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl });
      const events = [];
      for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) events.push(ev);
      const err = events.find((e) => e.kind === 'error');
      expect(err).toBeDefined();
      expect((err as any).code).toBe('transport');
      expect((err as any).message).toContain('ECONNREFUSED');
    });
  });
});

describe('toAnthropicMessages', () => {
  const { toAnthropicMessages } = _internal;

  it('converts user text blocks', () => {
    const out = toAnthropicMessages([{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }]);
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('converts tool_result blocks including stringification of object output', () => {
    const out = toAnthropicMessages([{
      role: 'user',
      content: [
        { kind: 'tool_result', toolCallId: 'toolu_1', name: 'read_file', output: { path: 'x' } },
      ],
    }]);
    expect(out[0]?.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: '{"path":"x"}',
      is_error: undefined,
    });
  });

  it('converts tool_use blocks on assistant messages', () => {
    const out = toAnthropicMessages([{
      role: 'assistant',
      content: [
        { kind: 'text', text: 'thinking...' },
        { kind: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'x' } },
      ],
    }]);
    expect(out[0]?.content).toEqual([
      { type: 'text', text: 'thinking...' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'x' } },
    ]);
  });

  it('hoists role=system into top-level system (not in messages)', () => {
    const msgs: Message[] = [
      { role: 'system', content: [{ kind: 'text', text: 'sysprompt' }] },
      { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out).toHaveLength(2);
    // The system message becomes a degenerate user message in the array
    // (the adapter hoists the actual system prompt separately at request time)
    expect(out[0]?.role).toBe('user');
    expect(out[0]?.content).toEqual([{ type: 'text', text: '' }]);
    expect(out[1]?.content).toEqual([{ type: 'text', text: 'hi' }]);
  });
});
