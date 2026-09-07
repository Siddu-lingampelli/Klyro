import { httpChatAdapter } from './src/agent/provider-adapter.js';

// EXACT copy of test line 117-120 body
const body =
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
  'data: [DONE]\n\n';

const adapter = httpChatAdapter({
  baseURL: 'https://x.example',
  apiKey: '',
  fetchImpl: (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
});

const evs: Array<Record<string, unknown>> = [];
for await (const ev of adapter.stream({ model: 'm', messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }], tools: [] })) {
  evs.push(ev as Record<string, unknown>);
}
console.log('Event count:', evs.length);
for (const e of evs) {
  console.log(' ', JSON.stringify(e));
}
const starts = evs.filter((e) => (e as { kind: string }).kind === 'tool_call_start');
console.log('starts.length =', starts.length);
const deltas = evs.filter((e) => (e as { kind: string }).kind === 'tool_call_delta');
const joined = deltas.map((e) => (e as unknown as { argsJson: string }).argsJson).join('');
console.log('joined delta =', JSON.stringify(joined));
