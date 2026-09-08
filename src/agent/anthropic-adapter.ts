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
 *  3. `tool_use_id` becomes our `id`; tool input arrives fragmented across
 *     `input_json_delta` frames, assembled per content_block index (never
 *     assumed whole, never silently dropped).
 *
 * Auth: `x-api-key: <key>`. Version header is sent as `anthropic-version`.
 * Auth can be a Bearer token (for proxies) — the adapter accepts either.
 */

import type { Message } from './message.js';
import type { CallRequest, ProviderAdapter, StreamEvent, ToolDefinition } from './provider-adapter.js';
import { assertSafeBaseURL } from '../chat.js';
import { parseRetryAfterMs } from './provider-adapter.js';

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
    const retryable = resp.status >= 500 || resp.status === 429;
    const retryAfterMs = retryable ? parseRetryAfterMs(resp.headers?.get('retry-after')) : undefined;
    yield {
      kind: 'error',
      code: `http_${resp.status}`,
      message: `Anthropic API returned ${resp.status}: ${text.slice(0, 500)}`,
      retryable,
      status: String(resp.status),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
    return;
  }

  yield { kind: 'message_start' };

  // Stream SSE: lines are `event: <type>\ndata: <json>\n\n`.
  // We use a simple incremental parser; Anthropic's API guarantees
  // well-formed SSE.
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  // Per-block assembly keyed by content_block index (tool input IS
  // fragmented across input_json_delta frames — never assume otherwise).
  const state: AnthropicStreamState = {
    blocks: new Map(),
    orphans: new Map(),
    thinkingIdx: null,
    usage: {},
  };
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
        const out = translateSse(e.event, parsed, state);
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

  // Truncated stream: close open blocks so the runtime finalizes them as
  // (malformed) structured errors instead of hanging, then terminate.
  for (const b of state.blocks.values()) {
    if (b.open) {
      b.open = false;
      yield { kind: 'tool_call_end', id: b.id };
    }
  }
  state.blocks.clear();
  // Fragments that could never be attributed to a tool block are a stream
  // integrity failure — surface loudly, never silently drop.
  if (state.orphans.size > 0 && !sawMessageEnd) {
    const count = [...state.orphans.values()].reduce((n, s) => n + s.length, 0);
    state.orphans.clear();
    yield {
      kind: 'error',
      code: 'ORPHAN_TOOL_DELTAS',
      message: `stream ended with ${count} chars of tool input that match no content block`,
      retryable: false,
    };
    return;
  }
  state.orphans.clear();
  if (!sawMessageEnd) {
    yield {
      kind: 'message_end',
      finishReason: 'stop',
      ...(state.usage.input !== undefined || state.usage.output !== undefined
        ? { usage: { input: state.usage.input ?? 0, output: state.usage.output ?? 0 } }
        : {}),
    };
  }
}

/**
 * Mutable per-stream assembly state. Blocks are keyed by content_block
 * index; the tool id is carried inside the block entry. There is no global
 * "current tool" — concurrent or interleaved blocks stay correctly routed.
 */
interface AnthropicStreamState {
  blocks: Map<number, { id: string; name: string; argsJson: string; open: boolean }>;
  /** Fragments for an index with no open block yet (flushed on block start). */
  orphans: Map<number, string>;
  thinkingIdx: number | null;
  usage: { input?: number; output?: number };
}

function translateSse(event: string, parsed: AnthropicSseEvent, state: AnthropicStreamState): StreamEvent[] {
  const out: StreamEvent[] = [];
  switch (event) {
    case 'message_start': {
      const usage = (parsed.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
      if (typeof usage?.input_tokens === 'number') state.usage.input = usage.input_tokens;
      return out;
    }
    case 'message_delta': {
      const usage = parsed.usage as { output_tokens?: number } | undefined;
      if (typeof usage?.output_tokens === 'number') {
        state.usage.output = (state.usage.output ?? 0) + usage.output_tokens;
      }
      return out;
    }
    case 'content_block_start': {
      const block = parsed.content_block as { type: string; id?: string; name?: string; input?: unknown } | undefined;
      const idx = parsed.index as number | undefined;
      if (block?.type === 'tool_use' && block.id && block.name && idx !== undefined) {
        // Flush any fragments that arrived before the block start.
        const stashed = state.orphans.get(idx);
        state.orphans.delete(idx);
        state.blocks.set(idx, { id: block.id, name: block.name, argsJson: stashed ?? '', open: true });
        out.push({ kind: 'tool_call_start', id: block.id, name: block.name });
        if (stashed) out.push({ kind: 'tool_call_delta', id: block.id, argsJson: stashed });
      } else if ((block?.type === 'thinking' || block?.type === 'redacted_thinking') && idx !== undefined) {
        state.thinkingIdx = idx;
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
        const entry = index !== undefined ? state.blocks.get(index) : undefined;
        if (entry && entry.open) {
          entry.argsJson += delta.partial_json;
          out.push({ kind: 'tool_call_delta', id: entry.id, argsJson: delta.partial_json });
        } else if (index !== undefined) {
          const open = [...state.blocks.values()].filter((b) => b.open);
          if (open.length === 1) {
            // Single in-flight tool: attribute here (documented heuristic).
            open[0]!.argsJson += delta.partial_json;
            out.push({ kind: 'tool_call_delta', id: open[0]!.id, argsJson: delta.partial_json });
          } else {
            // No safe attribution — stash for a later block start, or
            // surface as ORPHAN_TOOL_DELTAS at stream end. Never drop.
            state.orphans.set(index, (state.orphans.get(index) ?? '') + delta.partial_json);
          }
        } else {
          state.orphans.set(-1, (state.orphans.get(-1) ?? '') + delta.partial_json);
        }
      }
      return out;
    }
    case 'content_block_stop': {
      const index = parsed.index as number | undefined;
      if (index !== undefined && index === state.thinkingIdx) state.thinkingIdx = null;
      const entry = index !== undefined ? state.blocks.get(index) : undefined;
      if (entry && entry.open) {
        entry.open = false;
        state.blocks.delete(index!);
        out.push({ kind: 'tool_call_end', id: entry.id });
      }
      return out;
    }
    case 'message_stop': {
      out.push({
        kind: 'message_end',
        finishReason: 'stop',
        ...(state.usage.input !== undefined || state.usage.output !== undefined
          ? { usage: { input: state.usage.input ?? 0, output: state.usage.output ?? 0 } }
          : {}),
      });
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
export const _internal = { toAnthropicMessages, toAnthropicTool, translateSse };
