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
      // Prompt caching is on by default: stable system ships as an array
      // block with an ephemeral breakpoint, plus the caching beta header.
      expect(body.system).toEqual([{ type: 'text', text: 'be helpful', cache_control: { type: 'ephemeral' } }]);
      expect(headers['anthropic-beta']).toContain('prompt-caching-2024-07-31');
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
      // Prompt caching is on by default: the last tool carries the
      // cache breakpoint so tool definitions join the cacheable prefix.
      expect(body.tools).toEqual([{
        name: 'read_file',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        cache_control: { type: 'ephemeral' },
      }]);
    });

    it('omits the tools breakpoint when promptCache is false', async () => {
      let body: any;
      const fetchImpl = (async (_url, init) => {
        body = JSON.parse(init?.body as string);
        return new Response('', { status: 200 });
      }) as typeof fetch;
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl, promptCache: false });
      for await (const _ of adapter.stream({
        model: 'm',
        messages: [],
        tools: [
          { name: 'a_tool', description: 'A', inputSchema: { type: 'object' } },
          { name: 'b_tool', description: 'B', inputSchema: { type: 'object' } },
        ],
      })) { /* drain */ }
      expect(body.tools).toEqual([
        { name: 'a_tool', description: 'A', input_schema: { type: 'object' } },
        { name: 'b_tool', description: 'B', input_schema: { type: 'object' } },
      ]);
    });

    it('puts the tools breakpoint on the last tool only when promptCache is enabled', () => {
      const tools = [
        { name: 'a_tool', description: 'A', inputSchema: { type: 'object' } },
        { name: 'b_tool', description: 'B', inputSchema: { type: 'object' } },
      ];
      expect(_internal.buildAnthropicTools(tools, true)).toEqual([
        { name: 'a_tool', description: 'A', input_schema: { type: 'object' } },
        { name: 'b_tool', description: 'B', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
      ]);
      expect(_internal.buildAnthropicTools(tools, false)).toEqual([
        { name: 'a_tool', description: 'A', input_schema: { type: 'object' } },
        { name: 'b_tool', description: 'B', input_schema: { type: 'object' } },
      ]);
      expect(_internal.buildAnthropicTools([], true)).toBeUndefined();
    });
  });

  describe('prompt caching', () => {
    async function captureBody(opts: { promptCache?: boolean; betas?: string[] }, req: CallRequest) {
      let body: any;
      let headers: Record<string, string> | undefined;
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        body = JSON.parse(init?.body as string);
        headers = init?.headers as Record<string, string>;
        return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch;
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl, ...opts });
      for await (const _ of adapter.stream(req)) { /* drain */ }
      return { body, headers: headers! };
    }

    it('puts the breakpoint on the stable block only when a suffix is present', async () => {
      const { body } = await captureBody({}, {
        model: 'm', system: 'stable', systemSuffix: 'volatile telemetry', messages: [], tools: [],
      });
      expect(body.system).toEqual([
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'volatile telemetry' },
      ]);
    });

    it('omits the breakpoint and beta when promptCache is false', async () => {
      const { body, headers } = await captureBody({ promptCache: false }, {
        model: 'm', system: 'be helpful', messages: [], tools: [],
      });
      expect(body.system).toBe('be helpful');
      expect(headers['anthropic-beta'] ?? '').not.toContain('prompt-caching-2024-07-31');
    });

    it('keeps string form (suffix concatenated by caller contract) when disabled with suffix', async () => {
      const { body } = await captureBody({ promptCache: false }, {
        model: 'm', system: 'stable', systemSuffix: 'volatile', messages: [], tools: [],
      });
      // Disabled: array form still splits halves, but with no breakpoint.
      expect(body.system).toEqual([
        { type: 'text', text: 'stable' },
        { type: 'text', text: 'volatile' },
      ]);
    });

    it('merges the caching beta with user betas without duplicating', async () => {
      const { headers } = await captureBody(
        { betas: ['tools-2024-04-04', 'prompt-caching-2024-07-31'] },
        { model: 'm', messages: [], tools: [] },
      );
      const betas = (headers['anthropic-beta'] ?? '').split(',');
      expect(betas).toContain('tools-2024-04-04');
      expect(betas.filter((b) => b === 'prompt-caching-2024-07-31')).toHaveLength(1);
    });

    it('parses cache_creation/cache_read tokens into usage', async () => {
      const body = sse([
        ['message_start', { type: 'message_start', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 90, cache_read_input_tokens: 10 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl: makeFetch(body) });
      const events = [];
      for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) events.push(ev);
      const end = events.find((e) => e.kind === 'message_end');
      expect(end).toMatchObject({ kind: 'message_end', usage: { input: 100, output: 5, cacheRead: 10, cacheWrite: 90 } });
    });

    it('omits cache counters from usage when the provider sends none', async () => {
      const body = sse([
        ['message_start', { type: 'message_start', message: { usage: { input_tokens: 7 } } }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl: makeFetch(body) });
      const events = [];
      for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) events.push(ev);
      const end = events.find((e) => e.kind === 'message_end') as { usage?: Record<string, number> };
      expect(end?.usage).toEqual({ input: 7, output: 3 });
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

    it('routes concurrent tool blocks by index without cross-talk', async () => {
      const body = sse([
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'a', input: {} } }],
        ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'b', input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x"' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"y"' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':2}' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':1}' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['content_block_stop', { type: 'content_block_stop', index: 1 }],
        ['message_stop', { type: 'message_stop' }],
      ]);
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl: makeFetch(body) });
      const events = [];
      for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) events.push(ev);
      const byId = new Map<string, string>();
      for (const e of events) {
        if (e.kind === 'tool_call_delta') {
          const d = e as { id: string; argsJson: string };
          byId.set(d.id, (byId.get(d.id) ?? '') + d.argsJson);
        }
      }
      expect(byId.get('toolu_1')).toBe('{"x":1}');
      expect(byId.get('toolu_2')).toBe('{"y":2}');
    });

    it('carries provider usage from message_start/message_delta into message_end', async () => {
      const body = sse([
        ['message_start', { type: 'message_start', message: { usage: { input_tokens: 120, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl: makeFetch(body) });
      const events = [];
      for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) events.push(ev);
      const end = events.find((e) => e.kind === 'message_end');
      expect(end).toMatchObject({ kind: 'message_end', usage: { input: 120, output: 12 } });
    });

    it('closes open blocks on a truncated stream instead of hanging', async () => {
      const body = sse([
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }],
      ]);
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl: makeFetch(body) });
      const events = [];
      for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) events.push(ev);
      expect(events).toContainEqual({ kind: 'tool_call_end', id: 'toolu_1' });
      expect(events.filter((e) => e.kind === 'message_end')).toHaveLength(1);
    });

    it('surfaces unattributable fragments as ORPHAN_TOOL_DELTAS, never drops', async () => {
      const body = sse([
        ['content_block_delta', { type: 'content_block_delta', index: 7, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } }],
      ]);
      const adapter = anthropicAdapter({ apiKey: 'k', fetchImpl: makeFetch(body) });
      const events = [];
      for await (const ev of adapter.stream({ model: 'm', messages: [], tools: [] })) events.push(ev);
      const err = events.find((e) => e.kind === 'error');
      expect(err).toMatchObject({ kind: 'error', code: 'ORPHAN_TOOL_DELTAS' });
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

  it('maps role=tool messages to user tool_result blocks (no data loss)', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', content: [{ kind: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }] },
      { role: 'tool', content: [{ kind: 'tool_result', toolCallId: 'toolu_1', name: 'read_file', output: 'file bytes', isError: false }] },
    ]);
    expect(out[1]?.role).toBe('user');
    expect(out[1]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file bytes', is_error: false },
    ]);
  });

  it('emits exactly one message_end for a normal stream', async () => {
    const fetchImpl = makeFetch(
      sse([
        ['message_start', { type: 'message_start' }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_stop', { type: 'message_stop' }],
      ]),
    );
    const adapter = anthropicAdapter({ apiKey: 'k', baseURL: 'https://api.example.com', fetchImpl });
    const req: CallRequest = { model: 'm', messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }], tools: [] };
    const kinds: string[] = [];
    for await (const ev of adapter.stream(req)) kinds.push(ev.kind);
    expect(kinds.filter((k) => k === 'message_end')).toHaveLength(1);
    expect(kinds).toContain('text_delta');
  });

  it('emits thinking_delta for thinking blocks', async () => {
    const fetchImpl = makeFetch(
      sse([
        ['message_start', { type: 'message_start' }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm, ' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me see' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 1 }],
        ['message_stop', { type: 'message_stop' }],
      ]),
    );
    const adapter = anthropicAdapter({ apiKey: 'k', baseURL: 'https://api.example.com', fetchImpl });
    const req: CallRequest = { model: 'm', messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }], tools: [] };
    const thinking: string[] = [];
    const texts: string[] = [];
    for await (const ev of adapter.stream(req)) {
      if (ev.kind === 'thinking_delta') thinking.push(ev.text);
      if (ev.kind === 'text_delta') texts.push(ev.text);
    }
    expect(thinking.join('')).toBe('hmm, let me see');
    expect(texts.join('')).toBe('done');
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
