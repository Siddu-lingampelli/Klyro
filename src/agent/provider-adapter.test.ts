import { describe, it, expect } from 'vitest';
import { httpChatAdapter, buildChatCompletionsBody } from './provider-adapter.js';
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

/** Build an SSE `data:` line from a plain JS value (auto JSON-escaped). */
function dataLine(payload: unknown): string {
  return 'data: ' + JSON.stringify(payload) + '\n\n';
}

describe('httpChatAdapter thinking channel', () => {
  it('yields thinking_delta for reasoning_content without touching text', async () => {
    const body =
      dataLine({ choices: [{ index: 0, delta: { reasoning_content: 'let me think' }, finish_reason: null }] }) +
      dataLine({ choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] }) +
      dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
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
      dataLine({ choices: [{ index: 0, delta: { content: 'plain' }, finish_reason: null }] }) +
      'data: [DONE]\n\n';
    const adapter = httpChatAdapter({ baseURL: 'https://x.example', apiKey: '', fetchImpl: sseFetch(body) });
    const kinds: string[] = [];
    for await (const ev of adapter.stream(baseReq)) kinds.push(ev.kind);
    expect(kinds).not.toContain('thinking_delta');
    expect(kinds).toContain('text_delta');
  });
});

describe('httpChatAdapter tool assembly (P0.1)', () => {
  async function collect(body: string) {
    const adapter = httpChatAdapter({ baseURL: 'https://x.example', apiKey: '', fetchImpl: sseFetch(body) });
    const evs = [];
    for await (const ev of adapter.stream(baseReq)) evs.push(ev);
    return evs;
  }

  it('routes deltas by index when later frames omit id/name', async () => {
    // First frame sets id+name, later frames stream partial argument JSON.
    const body =
      dataLine({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '' } }] },
            finish_reason: null,
          },
        ],
      }) +
      dataLine({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"path' } }] },
            finish_reason: null,
          },
        ],
      }) +
      dataLine({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '":"a"}' } }] },
            finish_reason: null,
          },
        ],
      }) +
      dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      'data: [DONE]\n\n';
    const evs = await collect(body);
    const deltas = evs.filter((e) => e.kind === 'tool_call_delta');
    expect(evs).toContainEqual({ kind: 'tool_call_start', id: 'c1', name: 'read_file' });
    expect(deltas.length).toBeGreaterThan(0);
    for (const d of deltas) expect((d as { id: string }).id).toBe('c1');
    expect(evs.filter((e) => e.kind === 'message_end').length).toBe(1);
  });

  it('holds fragments arriving before identity, then flushes on start', async () => {
    // First frame has args but no id/name; second frame provides identity and
    // the trailing fragment. The adapter must assemble both.
    const body =
      dataLine({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] },
            finish_reason: null,
          },
        ],
      }) +
      dataLine({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'c9', function: { name: 'read_file', arguments: ':1}' } }],
            },
            finish_reason: null,
          },
        ],
      }) +
      dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      'data: [DONE]\n\n';
    const evs = await collect(body);
    expect(evs).toContainEqual({ kind: 'tool_call_start', id: 'c9', name: 'read_file' });
    const joined = evs
      .filter((e) => e.kind === 'tool_call_delta')
      .map((e) => (e as { argsJson: string }).argsJson)
      .join('');
    expect(joined).toBe('{"a":1}');
    expect(evs.filter((e) => e.kind === 'message_end').length).toBe(1);
  });

  it('assembles multiple tool calls independently', async () => {
    const body =
      dataLine({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'a', arguments: '{"x"' } }] },
            finish_reason: null,
          },
        ],
      }) +
      dataLine({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'b', arguments: '{"y"' } }] },
            finish_reason: null,
          },
        ],
      }) +
      dataLine({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: ':1}' } },
                { index: 1, function: { arguments: ':2}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }) +
      dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      'data: [DONE]\n\n';
    const evs = await collect(body);
    const byId = new Map<string, string>();
    for (const e of evs) {
      if (e.kind === 'tool_call_delta') {
        const d = e as { id: string; argsJson: string };
        byId.set(d.id, (byId.get(d.id) ?? '') + d.argsJson);
      }
    }
    expect(byId.get('c1')).toBe('{"x":1}');
    expect(byId.get('c2')).toBe('{"y":2}');
  });

  it('emits exactly one terminal event when finish_reason and [DONE] both arrive', async () => {
    const body =
      dataLine({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }) +
      'data: [DONE]\n\n';
    const evs = await collect(body);
    expect(evs.filter((e) => e.kind === 'message_end').length).toBe(1);
    expect(evs.filter((e) => e.kind === 'error').length).toBe(0);
  });

  it('terminates a truncated stream (no [DONE]) with one message_end', async () => {
    const body = dataLine({
      choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }],
    });
    const evs = await collect(body);
    expect(evs.filter((e) => e.kind === 'message_end').length).toBe(1);
  });

  it('surfaces identity-less fragments as incomplete calls instead of dropping', async () => {
    // Single fragment with args but no id/name — adapter must surface it
    // (not drop it) as one tool_call_start before message_end.
    const body =
      dataLine({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] },
            finish_reason: null,
          },
        ],
      }) +
      dataLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      'data: [DONE]\n\n';
    const evs = await collect(body);
    const starts = evs.filter((e) => e.kind === 'tool_call_start');
    expect(starts.length).toBe(1);
    const joined = evs
      .filter((e) => e.kind === 'tool_call_delta')
      .map((e) => (e as { argsJson: string }).argsJson)
      .join('');
    expect(joined).toBe('{"a":1}');
  });
});

describe('buildChatCompletionsBody systemSuffix', () => {
  it('leaves the system message untouched when no suffix is present', () => {
    const body = buildChatCompletionsBody({ ...baseReq, system: 'stable' });
    expect(body.messages).toContainEqual({ role: 'system', content: 'stable' });
  });

  it('appends the volatile suffix with a separator (behavior-preserving)', () => {
    const body = buildChatCompletionsBody({ ...baseReq, system: 'stable', systemSuffix: 'telemetry' });
    expect(body.messages).toContainEqual({ role: 'system', content: 'stable\n\ntelemetry' });
  });

  it('sends a suffix-only system message when no stable system exists', () => {
    const body = buildChatCompletionsBody({ ...baseReq, systemSuffix: 'telemetry' });
    expect(body.messages).toContainEqual({ role: 'system', content: 'telemetry' });
  });
});

describe('httpChatAdapter overflow (REQUEST_TOO_LARGE)', () => {
  async function collectErr(status: number, bodyText: string) {
    const fetchImpl = (async () =>
      new Response(bodyText, { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const adapter = httpChatAdapter({ baseURL: 'https://x.example', apiKey: '', fetchImpl });
    const evs = [];
    for await (const ev of adapter.stream(baseReq)) evs.push(ev);
    return evs;
  }

  it('marks 413 responses as REQUEST_TOO_LARGE (not retryable)', async () => {
    const evs = await collectErr(413, 'request_too_large: context length exceeded');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: 'error', code: 'REQUEST_TOO_LARGE', retryable: false, status: '413' });
  });

  it('marks request_too_large bodies as REQUEST_TOO_LARGE even on other 4xx', async () => {
    const evs = await collectErr(400, JSON.stringify({ error: { message: 'request_too_large: prompt is too long', type: 'invalid_request_error' } }));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: 'error', code: 'REQUEST_TOO_LARGE', retryable: false });
  });

  it('keeps plain 400s as HTTP_400 without the overflow code', async () => {
    const evs = await collectErr(400, 'bad request: malformed json');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: 'error', code: 'HTTP_400', retryable: false });
  });
});
