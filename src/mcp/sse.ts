/**
 * Legacy HTTP+SSE MCP transport (MCP 2024-11-05 shape).
 *
 * Distinct from Streamable HTTP (`remote.ts`): the client opens a persistent
 * GET event stream, waits for the `endpoint` event carrying the message POST
 * URI, then POSTs each JSON-RPC request and matches responses by id off the
 * shared stream. Used when `transport: 'sse'` is set on a `url` spec.
 */
import type { McpServerSpec } from './config.js';
import { McpError, type McpClientLike, type McpToolDef, type McpCallResult, type McpResource, type McpPromptDef } from './client.js';
import { AuthError, mcpTokenCacheKey, resolveAuth } from './auth.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;

/** Loopback check for the SSE constructor guard. */
export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '::' || h.startsWith('127.');
  } catch {
    return false;
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
}

export class SseMcpClient implements McpClientLike {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private endpoint: string | null = null;
  private streamAbort: AbortController | null = null;
  private pumpDone: Promise<void> | null = null;
  private dead: McpError | null = null;
  private closed = false;
  private authHeader: string | null = null;

  constructor(
    readonly name: string,
    private readonly spec: McpServerSpec,
  ) {
    if (!spec.url) throw new McpError(`mcp server "${name}" has no url`, 'INVALID_SPEC');
    // Fail-closed: refuse plaintext remote endpoints (defense-in-depth; the
    // spec schema already rejects insecure remote http URLs at load time).
    if (spec.url.startsWith('http:') && !isLoopback(spec.url) && process.env.KLYRO_ALLOW_INSECURE_MCP !== '1') {
      throw new McpError(`insecure MCP server url (plain HTTP) for host ${new URL(spec.url).hostname} — use https:// or a loopback URL, or set KLYRO_ALLOW_INSECURE_MCP=1`, 'INVALID_SPEC');
    }
    this.headers = { ...(spec.headers ?? {}) };
    this.timeoutMs = spec.policy?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Base + OAuth authorization header (merged per-request, never mutates base). */
  private authHeadersFor(): Record<string, string> {
    return this.authHeader ? { ...this.headers, Authorization: this.authHeader } : this.headers;
  }

  /** B2: resolve OAuth bearer token; true when request headers carry it. */
  private async ensureAuth(): Promise<boolean> {
    if (!this.spec.auth || !this.spec.url) return false;
    if (this.authHeader) return true;
    try {
      const result = await resolveAuth(this.spec.auth, mcpTokenCacheKey(this.spec.url, this.spec.auth.clientId));
      if (result.headers['Authorization']) {
        this.authHeader = result.headers['Authorization'];
        return true;
      }
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(`auth flow failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }

  async connect(): Promise<void> {
    if (this.endpoint) return;
    if (this.closed) throw new McpError(`mcp server "${this.name}" is closed`, 'CLOSED');
    // B2: resolve OAuth bearer token before the GET stream handshake.
    if (this.spec.auth && (await this.ensureAuth()) === false) {
      throw new McpError(`mcp server "${this.name}" auth produced no token`, 'AUTH_ERROR');
    }
    this.streamAbort = new AbortController();
    const endpointP = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new McpError(`mcp server "${this.name}" SSE endpoint timeout`, 'TIMEOUT')), CONNECT_TIMEOUT_MS);
      this.pumpDone = this.pump(timer, resolve, reject).catch(() => undefined);
    });
    this.endpoint = await endpointP;
    // Standard initialize handshake over the discovered message endpoint.
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'klyro', version: 'sse' },
    });
  }

  private async pump(
    timer: NodeJS.Timeout,
    onEndpoint: (uri: string) => void,
    onFatal: (err: McpError) => void,
  ): Promise<void> {
    let buf = '';
    let eventType = '';
    let gotEndpoint = false;
    try {
      const res = await fetch(this.spec.url!, {
        headers: { ...this.authHeadersFor(), Accept: 'text/event-stream' },
        signal: this.streamAbort!.signal,
      });
      if (!res.ok || !res.body) {
        throw new McpError(`mcp server "${this.name}" SSE GET failed: HTTP ${res.status}`, 'HTTP_ERROR', { status: res.status });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (line === '') {
            eventType = '';
            continue;
          }
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
            continue;
          }
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (eventType === 'endpoint' && !gotEndpoint) {
            gotEndpoint = true;
            clearTimeout(timer);
            try {
              onEndpoint(new URL(data, this.spec.url!).toString());
            } catch {
              onFatal(new McpError(`mcp server "${this.name}" sent a bad endpoint URI`, 'PROTOCOL_ERROR'));
              return;
            }
            eventType = '';
            continue;
          }
          let msg: unknown = null;
          try { msg = JSON.parse(data) as unknown; } catch { continue; }
          this.dispatch(msg);
          eventType = '';
        }
      }
    } catch (err) {
      if (!gotEndpoint) {
        clearTimeout(timer);
        onFatal(err instanceof McpError ? err : new McpError(`mcp server "${this.name}" SSE stream failed: ${err instanceof Error ? err.message : String(err)}`, 'IO_ERROR'));
        return;
      }
      this.failAll(new McpError(`mcp server "${this.name}" SSE stream closed`, 'SERVER_EXITED'));
    }
  }

  private dispatch(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    if (typeof m.id !== 'number') return; // notifications are ignored
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    clearTimeout(p.timer);
    if (m.error) p.reject(new McpError(`mcp server "${this.name}" error: ${m.error.message ?? 'unknown'}`, 'SERVER_ERROR', m.error));
    else p.resolve(m.result ?? {});
  }

  private failAll(err: McpError): void {
    if (!this.dead) this.dead = err;
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new McpError(`mcp server "${this.name}" is closed`, 'CLOSED');
    if (this.dead) throw this.dead;
    if (!this.endpoint) throw new McpError(`mcp server "${this.name}" not connected`, 'NOT_CONNECTED');
    if (signal?.aborted) throw new McpError(`mcp call "${method}" aborted`, 'ABORTED');
    const id = this.nextId++;
    const drop = (): void => {
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        clearTimeout(p.timer);
      }
    };
    const out = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`mcp call "${method}" timed out after ${this.timeoutMs}ms`, 'TIMEOUT'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener('abort', () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new McpError(`mcp call "${method}" aborted`, 'ABORTED'));
      }, { once: true });
    });
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { ...this.authHeadersFor(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: signal ?? undefined,
      });
      if (!res.ok && res.status !== 202) {
        const text = await res.text().catch(() => '');
        drop();
        throw new McpError(`mcp server "${this.name}" HTTP ${res.status}: ${text.slice(0, 300)}`, 'HTTP_ERROR', { status: res.status });
      }
      // 202 Accepted with no body can precede the response on the stream.
      if (res.status === 202) {
        const text = await res.text().catch(() => '');
        if (text.trim()) {
          try {
            const body = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
            if (body && typeof body === 'object' && 'error' in body && body.error) {
              drop();
              throw new McpError(`mcp server "${this.name}" error`, 'SERVER_ERROR', body.error);
            }
            if (body && typeof body === 'object' && 'result' in body) {
              drop();
              return body.result;
            }
          } catch (err) {
            if (err instanceof McpError) throw err;
            // Not inline JSON — fall through to stream matching.
          }
        }
      }
    } catch (err) {
      if (err instanceof McpError && err.code !== 'HTTP_ERROR') throw err;
      if (err instanceof McpError) throw err;
      drop();
      throw new McpError(`mcp call "${method}" failed: ${err instanceof Error ? err.message : String(err)}`, 'IO_ERROR');
    }
    return out;
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDef[]> {
    const res = (await this.request('tools/list', {}, signal)) as { tools?: McpToolDef[] };
    return Array.isArray(res.tools) ? res.tools : [];
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const res = (await this.request('tools/call', { name, arguments: args ?? {} }, signal)) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const blocks = Array.isArray(res.content) ? res.content : [];
    const text = blocks.map((b) => (typeof b.text === 'string' ? b.text : JSON.stringify(b))).join('\n');
    return { text, isError: res.isError === true, raw: res };
  }

  async listResources(signal?: AbortSignal): Promise<McpResource[]> {
    const res = (await this.request('resources/list', {}, signal)) as { resources?: McpResource[] };
    return Array.isArray(res.resources) ? res.resources : [];
  }

  async promptsList(signal?: AbortSignal): Promise<McpPromptDef[]> {
    try {
      const res = (await this.request('prompts/list', {}, signal)) as { prompts?: McpPromptDef[] };
      return Array.isArray(res.prompts) ? res.prompts : [];
    } catch (err) {
      if (err instanceof McpError && err.code === 'SERVER_ERROR' && (err.details as { code?: number } | undefined)?.code === -32601) return [];
      throw err;
    }
  }

  async promptsGet(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const res = (await this.request('prompts/get', { name, arguments: args ?? {} }, signal)) as {
      description?: string;
      messages?: Array<{ content?: { text?: string } | unknown }>;
    };
    const parts: string[] = [];
    if (typeof res.description === 'string' && res.description) parts.push(res.description);
    for (const m of Array.isArray(res.messages) ? res.messages : []) {
      const c = (m as { content?: { text?: string } }).content;
      if (c && typeof c.text === 'string') parts.push(c.text);
      else if (c !== undefined) parts.push(JSON.stringify(c));
    }
    return parts.join('\n\n');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.streamAbort?.abort(); } catch { /* ignore */ }
    this.failAll(new McpError(`mcp server "${this.name}" closed`, 'CLOSED'));
    try { await this.pumpDone; } catch { /* ignore */ }
  }
}
