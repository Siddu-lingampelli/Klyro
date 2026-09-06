/**
 * Anthropic Messages API provider adapter.
 *
 * Translates the normalized ProviderAdapter surface to the Anthropic
 * /v1/messages streaming endpoint. Distinct from httpChatAdapter (which
 * speaks the OpenAI chat-completions protocol) in three ways:
 *
 *  1. `system` is a top-level field, not a message with role=system.
 *  2. Tool definitions use `input_schema` not `parameters`, and have no
 *     `type: 'function'` wrapper.
 *  3. `tool_use_id` becomes our `id`; the tool input is sent as a single
 *     `input_json_delta` block.
 *
 * Auth: `x-api-key: <key>`. Version header is sent as `anthropic-version`.
 * Auth can be a Bearer token (for proxies) — the adapter accepts either.
 */

import type { Message } from './message.js';
import type { CallRequest, ProviderAdapter, StreamEvent, ToolDefinition } from './provider-adapter.js';
import { assertSafeBaseURL } from '../chat.js';

export interface AnthropicAdapterOptions {
  baseURL?: string;
  apiKey: string;
  /** Per-request timeout in ms (default 120_000). */
  timeoutMs?: number;
  /** Override fetch (e.g. for tests). */
  fetchImpl?: typeof fetch;
  /** Override the Anthropic API version. Default '2023-06-01'. */
  anthropicVersion?: string;
  /** Override the auth header. Default 'x-api-key'. Set to 'Authorization' for proxy compat. */
  authHeader?: 'x-api-key' | 'Authorization';
  /** Beta features (e.g. ['prompt-caching-2024-07-31', 'tools-2024-04-04']). */
  betas?: string[];
}

const DEFAULT_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 120_000;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: 'text'; text: string }>; is_error?: boolean }
  >;
}

interface AnthropicRequest {
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  max_tokens: number;
  temperature?: number;
  stream: true;
}

interface AnthropicSseEvent {
  type: string;
  // The shape varies by event type; we use a record because we parse
  // incrementally and only care about a few fields.
  [key: string]: unknown;
}

export class AnthropicApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Anthropic API error ${status}: ${body.slice(0, 500)}`);
    this.name = 'AnthropicApiError';
    this.status = status;
    this.body = body;
  }
}

export function anthropicAdapter(opts: AnthropicAdapterOptions): ProviderAdapter {
  const rawBase = opts.baseURL ?? 'https://api.anthropic.com';
  assertSafeBaseURL(rawBase);
  const baseURL = rawBase.replace(/\/+$/, '');
  const version = opts.anthropicVersion ?? DEFAULT_VERSION;
  const authHeader = opts.authHeader ?? 'x-api-key';
  const betas = opts.betas ?? [];
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('anthropicAdapter: no fetch available — pass opts.fetchImpl or run on Node 18+');
  }

  return {
    id: 'anthropic',
    stream(req: CallRequest): AsyncIterable<StreamEvent> {
      return streamAnthropic(req, {
        baseURL, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchImpl, version, authHeader, betas,
      });
    },
  };
}

interface InternalOpts {
  baseURL: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  version: string;
  authHeader: 'x-api-key' | 'Authorization';
  betas: string[];
}

async function* streamAnthropic(req: CallRequest, opts: InternalOpts): AsyncIterable<StreamEvent> {
  const body: AnthropicRequest = {
    model: req.model,
    system: req.system,
    messages: toAnthropicMessages(req.messages),
    tools: req.tools.length > 0 ? req.tools.map(toAnthropicTool) : undefined,
    max_tokens: req.maxTokens ?? 4096,
    temperature: req.temperature,
    stream: true,
  };

  const url = `${opts.baseURL}/v1/messages`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('anthropicAdapter: timeout')), opts.timeoutMs);
  if (req.signal) {
    if (req.signal.aborted) ac.abort(req.signal.reason);
    else req.signal.addEventListener('abort', () => ac.abort(req.signal?.reason), { once: true });
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': opts.version,
  };
  if (opts.authHeader === 'x-api-key') headers['x-api-key'] = opts.apiKey;
  else headers['Authorization'] = `Bearer ${opts.apiKey}`;
  if (opts.betas.length > 0) headers['anthropic-beta'] = opts.betas.join(',');

  let resp: Response;
  try {
    resp = await opts.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    const retryable = !/abort/i.test(message) || /timeout/i.test(message);
    yield { kind: 'error', code: 'transport', message, retryable };
    return;
  }
  clearTimeout(timer);

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '<unreadable>');
    yield {
      kind: 'error',
      code: `http_${resp.status}`,
      message: `Anthropic API returned ${resp.status}: ${text.slice(0, 500)}`,
      retryable: resp.status >= 500 || resp.status === 429,
    };
    return;
  }

  yield { kind: 'message_start' };

  // Stream SSE: lines are `event: <type>\ndata: <json>\n\n`.
  // We use a simple incremental parser; Claude's API guarantees
  // well-formed SSE.
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  // Track in-progress tool calls so we can emit start/delta/end.
  const toolBuffers = new Map<string, { name: string; argsJson: string }>();
  // Map content_block index → tool_use id (persists after tool completes to handle late deltas)
  const indexToToolId = new Map<number, string>();
  // Active thinking-block index (Anthropic reasoning channel).
  const thinkingState: { idx: number | null } = { idx: null };
  // message_stop already yields message_end — don't emit a second one at EOF.
  let sawMessageEnd = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Split on SSE event boundary.
      const events: Array<{ event: string; data: string }> = [];
      let idx = 0;
      while (true) {
        const start = idx;
        const sep = buf.indexOf('\n\n', start);
        if (sep === -1) break;
        const chunk = buf.slice(start, sep);
        idx = sep + 2;

        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) events.push({ event, data });
      }
      buf = buf.slice(idx);

      for (const e of events) {
        let parsed: AnthropicSseEvent;
        try { parsed = JSON.parse(e.data) as AnthropicSseEvent; } catch { continue; }
        const out = translateSse(e.event, parsed, toolBuffers, indexToToolId, thinkingState);
        for (const ev of out) {
          if (ev.kind === 'message_end') sawMessageEnd = true;
          yield ev;
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { kind: 'error', code: 'stream', message, retryable: true };
    return;
  } finally {
    reader.releaseLock();
  }

  if (!sawMessageEnd) yield { kind: 'message_end', finishReason: 'stop' };
}

function translateSse(
  event: string,
  parsed: AnthropicSseEvent,
  toolBuffers: Map<string, { name: string; argsJson: string }>,
  indexToToolId: Map<number, string>,
  thinking?: { idx: number | null },
): StreamEvent[] {
  const out: StreamEvent[] = [];
  switch (event) {
    case 'content_block_start': {
      const block = parsed.content_block as { type: string; id?: string; name?: string; input?: unknown } | undefined;
      const idx = parsed.index as number | undefined;
      if (block?.type === 'tool_use' && block.id && block.name) {
        toolBuffers.set(block.id, { name: block.name, argsJson: '' });
        if (idx !== undefined) indexToToolId.set(idx, block.id);
        out.push({ kind: 'tool_call_start', id: block.id, name: block.name });
      } else if ((block?.type === 'thinking' || block?.type === 'redacted_thinking') && thinking && idx !== undefined) {
        thinking.idx = idx;
      }
      return out;
    }
    case 'content_block_delta': {
      const delta = parsed.delta as { type?: string; text?: string; partial_json?: string; thinking?: string } | undefined;
      const index = parsed.index as number | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        out.push({ kind: 'text_delta', text: delta.text });
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        out.push({ kind: 'thinking_delta', text: delta.thinking });
      } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const id = findToolIdByIndex(index, toolBuffers, indexToToolId);
        if (id) {
          const buf = toolBuffers.get(id);
          if (buf) {
            buf.argsJson += delta.partial_json;
            out.push({ kind: 'tool_call_delta', id, argsJson: delta.partial_json });
          }
        }
      }
      return out;
    }
    case 'content_block_stop': {
      const index = parsed.index as number | undefined;
      if (thinking && index !== undefined && index === thinking.idx) thinking.idx = null;
      const id = findToolIdByIndex(index, toolBuffers, indexToToolId);
      if (id) {
        toolBuffers.delete(id);
        // Keep index mapping for late deltas that may arrive after stop (rare)
        out.push({ kind: 'tool_call_end', id });
      }
      return out;
    }
    case 'message_stop': {
      out.push({ kind: 'message_end', finishReason: 'stop' });
      return out;
    }
    case 'error': {
      const err = parsed.error as { type?: string; message?: string } | undefined;
      out.push({
        kind: 'error',
        code: err?.type ?? 'anthropic_error',
        message: err?.message ?? 'unknown Anthropic error',
        retryable: false,
      });
      return out;
    }
    default:
      return out;
  }
}

/** Match an Anthropic content_block index to the tool_use id we emitted. */
function findToolIdByIndex(
  index: number | undefined,
  buffers: Map<string, { name: string; argsJson: string }>,
  indexToToolId?: Map<number, string>,
): string | undefined {
  if (index === undefined) return undefined;
  if (indexToToolId) {
    const direct = indexToToolId.get(index);
    if (direct) return direct;
  }
  // Single-buffer fallback: if only one in-flight tool, any delta belongs to it
  if (buffers.size === 1) return buffers.keys().next().value;
  // No reliable mapping — drop the delta rather than misroute to wrong tool (prevents _parse_error loops)
  return undefined;
}

function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  return messages.map((m) => {
    if (m.role === 'user') {
      return {
        role: 'user' as const,
        content: m.content.map((b): AnthropicMessage['content'][number] => {
          if (b.kind === 'text') return { type: 'text', text: b.text };
          if (b.kind === 'tool_result') {
            const content = typeof b.output === 'string'
              ? (b.isError ? `Error: ${b.output}` : b.output)
              : JSON.stringify(b.output);
            return {
              type: 'tool_result',
              tool_use_id: b.toolCallId,
              content,
              is_error: b.isError,
            };
          }
          return { type: 'text', text: '' };
        }),
      };
    }
    if (m.role === 'assistant') {
      return {
        role: 'assistant' as const,
        content: m.content.map((b): AnthropicMessage['content'][number] => {
          if (b.kind === 'text') return { type: 'text', text: b.text };
          if (b.kind === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
          return { type: 'text', text: '' };
        }),
      };
    }
    if (m.role === 'tool') {
      // Anthropic has no tool role: tool_result blocks ride a user message,
      // paired with the preceding assistant tool_use by tool_use_id.
      const content = m.content.map((b): AnthropicMessage['content'][number] => {
        if (b.kind === 'tool_result') {
          const out = typeof b.output === 'string' ? b.output : JSON.stringify(b.output ?? '');
          return { type: 'tool_result', tool_use_id: b.toolCallId, content: out, is_error: b.isError };
        }
        if (b.kind === 'text') return { type: 'text', text: b.text };
        return { type: 'text', text: '' };
      });
      return { role: 'user' as const, content };
    }
    // 'system' is hoisted to the top-level `system` field; never appears
    // in the messages array passed to the adapter.
    return { role: 'user' as const, content: [{ type: 'text', text: '' }] };
  });
}

function toAnthropicTool(t: ToolDefinition): { name: string; description: string; input_schema: unknown } {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  };
}

// Re-export for testability.
export const _internal = { toAnthropicMessages, toAnthropicTool, findToolIdByIndex };
