/**
 * ProviderAdapter — a normalized streaming chat-completion interface
 * that the agent runtime consumes.
 *
 * Implementations:
 *   - httpChatAdapter (default): OpenAI-compatible /v1/chat/completions
 *     with tool calls. Works against api.openai.com, Ollama, LM Studio,
 *     vLLM, llama.cpp, and any compatible proxy.
 *
 * The adapter exposes a single async generator of StreamEvents so the
 * runtime loop sees one shape regardless of provider quirks.
 */

import { z } from 'zod';
import type { Message, ToolUseBlock } from './message.js';
import { redact } from '../policy/secret-redactor.js';

export type StreamEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'message_start'; id?: string; model?: string }
  | { kind: 'message_end'; finishReason?: string; usage?: { input: number; output: number } }
  | { kind: 'tool_call_start'; id: string; name: string }
  | { kind: 'tool_call_delta'; id: string; argsJson: string }
  | { kind: 'tool_call_end'; id: string }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown; // JSON Schema object
}

export interface CallRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  readonly id: string;
  stream(req: CallRequest): AsyncIterable<StreamEvent>;
}

// --- OpenAI-compatible chat-completions adapter ---

export interface HttpAdapterOptions {
  baseURL: string;
  apiKey: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Override fetch (e.g. for tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Convert a Zod schema to a permissive JSON Schema object for tool defs. */
export function zodToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  // We keep this simple: zod's own _def is enough to give the model a
  // shape. A full conversion library isn't needed for MVP — most tool
  // inputs are flat objects with primitive types.
  const def = (schema as unknown as { _def?: unknown })._def as
    | { typeName?: string; schema?: { _def?: unknown }; shape?: () => Record<string, z.ZodType<unknown>> }
    | undefined;
  if (!def) return { type: 'object', properties: {}, additionalProperties: false };
  if (def.typeName === 'ZodObject' && def.shape) {
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(def.shape())) {
      props[k] = zodFieldSchema(v);
      if (!v.isOptional()) required.push(k);
    }
    const out: Record<string, unknown> = { type: 'object', properties: props };
    if (required.length) out.required = required;
    out.additionalProperties = false;
    return out;
  }
  return { type: 'object', properties: {}, additionalProperties: false };
}

function zodFieldSchema(s: z.ZodType<unknown>): Record<string, unknown> {
  const def = (s as unknown as { _def?: { typeName?: string; innerType?: z.ZodType<unknown>; options?: z.ZodType<unknown>[]; value?: unknown } })._def;
  const name = def?.typeName;
  switch (name) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray': {
      const inner = def?.innerType;
      return { type: 'array', items: inner ? zodFieldSchema(inner) : { type: 'string' } };
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault': {
      const inner = def?.innerType;
      return inner ? zodFieldSchema(inner) : { type: 'string' };
    }
    case 'ZodEnum': {
      const values = (s as unknown as { _def: { values: readonly string[] } })._def.values;
      return { type: 'string', enum: [...values] };
    }
    case 'ZodNativeEnum': {
      const vals = Object.values((s as unknown as { _def: { values: Record<string, unknown> } })._def.values);
      return { enum: [...vals] };
    }
    case 'ZodLiteral': {
      const v = def?.value;
      return { enum: [v], type: typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : 'boolean' };
    }
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const opts = (def as unknown as { options?: z.ZodType<unknown>[] }).options ?? [];
      return { anyOf: opts.map((o) => zodFieldSchema(o)) };
    }
    case 'ZodIntersection': {
      const parts = [def?.innerType].filter(Boolean) as z.ZodType<unknown>[];
      return { allOf: parts.map((p) => zodFieldSchema(p)) };
    }
    case 'ZodObject':
      return zodToJsonSchema(s);
    default:
      return { type: 'string' };
  }
}

interface ChatCompletionsRequest {
  model: string;
  messages: Array<{ role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>;
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>;
  max_tokens?: number;
  temperature?: number;
  stream: true;
}

interface ChatCompletionsChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{ index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Build the OpenAI-compatible request body from our normalized CallRequest.
 * Exported for testing.
 */
export function buildChatCompletionsBody(req: CallRequest): ChatCompletionsRequest {
  const messages: ChatCompletionsRequest['messages'] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('');
      const tcs = m.content
        .filter((b) => b.kind === 'tool_use')
        .map((b) => {
          const tb = b as ToolUseBlock;
          return {
            id: tb.id,
            type: 'function' as const,
            function: { name: tb.name, arguments: JSON.stringify(tb.input) },
          };
        });
      const msg: ChatCompletionsRequest['messages'][number] = { role: 'assistant' };
      if (text) msg.content = text;
      if (tcs.length) msg.tool_calls = tcs;
      messages.push(msg);
    } else if (m.role === 'tool') {
      for (const b of m.content) {
        if (b.kind === 'tool_result') {
          const tr = b as { toolCallId: string; name: string; output: unknown; isError?: boolean };
          messages.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            name: tr.name,
            content: typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output ?? ''),
          });
        }
      }
    } else if (m.role === 'user') {
      const text = m.content.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('');
      messages.push({ role: 'user', content: text });
    }
  }
  const body: ChatCompletionsRequest = { model: req.model, messages, stream: true };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  return body;
}

export function httpChatAdapter(opts: HttpAdapterOptions): ProviderAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.baseURL.replace(/\/+$/, '')}/chat/completions`;
  return {
    id: 'http-chat',
    stream(req: CallRequest): AsyncIterable<StreamEvent> {
      return streamChatCompletions(url, opts, req, fetchImpl);
    },
  };
}

async function* streamChatCompletions(
  url: string,
  opts: HttpAdapterOptions,
  req: CallRequest,
  fetchImpl: typeof fetch,
): AsyncIterable<StreamEvent> {
  const body = buildChatCompletionsBody(req);
  const ac = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ac.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => ac.abort(req.signal?.reason);
  req.signal?.addEventListener('abort', onAbort);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
    const msg = err instanceof Error ? err.message : String(err);
    yield { kind: 'error', code: 'NETWORK', message: msg, retryable: true };
    return;
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
    const rawErr = await res.text().catch(() => '');
    const errText = redact(rawErr).slice(0, 500);
    yield {
      kind: 'error',
      code: `HTTP_${res.status}`,
      message: `provider returned ${res.status}: ${errText}`,
      retryable: res.status >= 500 || res.status === 429,
    };
    return;
  }
  yield { kind: 'message_start' };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // Track per-tool-call id by index.
  const toolIds = new Map<number, string>();
  const toolNames = new Map<number, string>();
  let pendingUsage: { input: number; output: number } | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE: events separated by \n\n
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            yield { kind: 'message_end' };
            return;
          }
          let chunk: ChatCompletionsChunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          // Capture usage even when finish_reason is null (Ollama/vLLM style)
          if (chunk.usage) {
            pendingUsage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
          }
          for (const choice of chunk.choices) {
            // Handle multiple possible content fields for compat (OpenAI, Ollama, OpenRouter gemini, etc.)
            const delta: unknown = choice.delta as unknown;
            const text =
              (delta as { content?: string })?.content ??
              (delta as { text?: string })?.text ??
              (choice as unknown as { message?: { content?: string } })?.message?.content ??
              (choice as unknown as { delta?: { text?: string } })?.delta?.text;
            if (typeof text === 'string' && text) {
              yield { kind: 'text_delta', text };
            }
            // Reasoning channel (DeepSeek-R1 / OpenRouter / vLLM et al. send
            // `reasoning_content`; some proxies use `reasoning`). Shown dimmed
            // while working, discarded when the answer completes.
            const thinking =
              (delta as { reasoning_content?: string })?.reasoning_content ??
              (delta as { reasoning?: string })?.reasoning;
            if (typeof thinking === 'string' && thinking) {
              yield { kind: 'thinking_delta', text: thinking };
            }
            for (const tc of choice.delta.tool_calls ?? []) {
              if (tc.id && tc.function?.name) {
                toolIds.set(tc.index, tc.id);
                toolNames.set(tc.index, tc.function.name);
                yield { kind: 'tool_call_start', id: tc.id, name: tc.function.name };
              } else if (tc.id) {
                toolIds.set(tc.index, tc.id);
              }
              if (tc.function?.arguments) {
                const id = toolIds.get(tc.index) ?? `call_${tc.index}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
                yield { kind: 'tool_call_delta', id, argsJson: tc.function.arguments };
              }
            }
            if (choice.finish_reason) {
              const usage = pendingUsage ?? (chunk.usage
                ? { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens }
                : undefined);
              pendingUsage = undefined;
              // Clear tool tracking per message to avoid stale ids on next turn
              const ids = [...toolIds.values()];
              toolIds.clear();
              toolNames.clear();
              for (const id of ids) yield { kind: 'tool_call_end', id };
              yield { kind: 'message_end', finishReason: choice.finish_reason, usage };
            }
          }
        }
      }
    }
    if (toolIds.size) {
      for (const id of toolIds.values()) yield { kind: 'tool_call_end', id };
      if (pendingUsage) {
        yield { kind: 'message_end', usage: pendingUsage };
      } else {
        yield { kind: 'message_end' };
      }
    } else if (pendingUsage) {
      yield { kind: 'message_end', usage: pendingUsage };
    } else {
      yield { kind: 'message_end' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { kind: 'error', code: 'STREAM', message: msg, retryable: true };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}
