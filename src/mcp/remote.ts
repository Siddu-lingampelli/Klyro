/**
 * Remote MCP transport — JSON-RPC 2.0 over HTTP POST (Streamable HTTP).
 *
 * Covers servers that speak plain request/response JSON-RPC at an HTTPS
 * endpoint (the common self-hosted shape). Pure SSE-stream servers that
 * require a persistent GET event stream are NOT supported — `probe` reports
 * that explicitly. Custom headers (e.g. Authorization) come from the spec
 * with `${env:VAR}` expansion applied at load time.
 */
import type { McpServerSpec } from './config.js';
import { McpError, type McpClientLike, type McpToolDef, type McpCallResult, type McpResource, type McpPromptDef } from './client.js';
import { AuthError, mcpTokenCacheKey, resolveAuth } from './auth.js';

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Loopback check shared with the SSE transport guard. */
export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '::' || h.startsWith('127.');
  } catch {
    return false;
  }
}

/** Parse a Streamable-HTTP SSE body (`data: {...}` lines) into JSON payloads. */
export function parseSseBody(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload) as unknown);
    } catch { /* ignore malformed lines */ }
  }
  return out;
}

export class RemoteMcpClient implements McpClientLike {
  private nextId = 1;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private authHeader: string | null = null;

  constructor(
    readonly name: string,
    private readonly spec: McpServerSpec,
  ) {
    if (!spec.url) throw new McpError(`mcp server "${name}" has no url`, 'INVALID_SPEC');
    // Fail-closed: refuse plaintext remote endpoints even if a spec bypassed
    // schema validation (defense-in-depth; schema already rejects insecure http).
    if (spec.url.startsWith('http:') && !isLoopback(spec.url) && process.env.KLYRO_ALLOW_INSECURE_MCP !== '1') {
      throw new McpError(`insecure MCP server url (plain HTTP) for host ${new URL(spec.url).hostname} — use https:// or a loopback URL, or set KLYRO_ALLOW_INSECURE_MCP=1`, 'INVALID_SPEC');
    }
    this.headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(spec.headers ?? {}) };
    this.timeoutMs = spec.policy?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** B2: resolve OAuth bearer token; returns true when usable headers exist. */
  private async ensureAuth(): Promise<boolean> {
    if (!this.spec.auth || !this.spec.url) return false;
    if (this.authHeader) return true;
    const url = this.spec.url;
    const cacheKey = mcpTokenCacheKey(url, this.spec.auth.clientId);
    try {
      const result = await resolveAuth(this.spec.auth, cacheKey);
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

  /** Base headers merged with the OAuth bearer token (never mutates base). */
  private headersFor(): Record<string, string> {
    return this.authHeader ? { ...this.headers, Authorization: this.authHeader } : this.headers;
  }

  async connect(): Promise<void> {
    // B2: resolve OAuth/pkce bearer token (reuses cache, else interactive
    // flow) and merge `Authorization` before the handshake. Non-fatal if no
    // auth is configured.
    if (this.spec.auth) {
      try {
        await this.ensureAuth();
      } catch (err) {
        throw new McpError(`mcp server "${this.name}" auth failed: ${err instanceof Error ? err.message : String(err)}`, 'AUTH_ERROR');
      }
    }
    // Handshake doubles as reachability probe; failures surface typed errors.
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'klyro', version: 'remote' },
    });
    // Best-effort initialized notification (no id → no response expected).
    try {
      await fetch(this.spec.url!, {
        method: 'POST',
        headers: this.headersFor(),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* notification is best-effort */ }
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDef[]> {
    const res = (await this.request('tools/list', {}, this.timeoutMs, signal)) as { tools?: McpToolDef[] };
    return Array.isArray(res.tools) ? res.tools : [];
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const res = (await this.request('tools/call', { name, arguments: args ?? {} }, this.timeoutMs, signal)) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const blocks = Array.isArray(res.content) ? res.content : [];
    const text = blocks.map((b) => (typeof b.text === 'string' ? b.text : JSON.stringify(b))).join('\n');
    return { text, isError: res.isError === true, raw: res };
  }

  async listResources(signal?: AbortSignal): Promise<McpResource[]> {
    const res = (await this.request('resources/list', {}, this.timeoutMs, signal)) as { resources?: McpResource[] };
    return Array.isArray(res.resources) ? res.resources : [];
  }

  async promptsList(signal?: AbortSignal): Promise<McpPromptDef[]> {
    try {
      const res = (await this.request('prompts/list', {}, this.timeoutMs, signal)) as { prompts?: McpPromptDef[] };
      return Array.isArray(res.prompts) ? res.prompts : [];
    } catch (err) {
      if (err instanceof McpError && err.code === 'SERVER_ERROR' && (err.details as { code?: number } | undefined)?.code === -32601) return [];
      throw err;
    }
  }

  async promptsGet(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const res = (await this.request('prompts/get', { name, arguments: args ?? {} }, this.timeoutMs, signal)) as {
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
    // Stateless HTTP — nothing to tear down.
  }

  private async request(method: string, params: unknown, timeoutMs: number = this.timeoutMs, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new McpError(`mcp call "${method}" aborted`, 'ABORTED');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = (): void => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const id = this.nextId++;
    try {
      const res = await fetch(this.spec.url!, {
        method: 'POST',
        headers: this.headersFor(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: ctrl.signal,
      });
      const ctype = res.headers.get('content-type') ?? '';
      const text = await res.text();
      if (!res.ok) throw new McpError(`mcp server "${this.name}" HTTP ${res.status}: ${text.slice(0, 300)}`, 'HTTP_ERROR', { status: res.status });
      let body: unknown;
      if (ctype.includes('text/event-stream')) {
        const events = parseSseBody(text);
        const last = [...events].reverse().find((e) => typeof e === 'object' && e !== null && 'result' in (e as object));
        const errs = [...events].reverse().find((e) => typeof e === 'object' && e !== null && 'error' in (e as object)) as { error?: { code?: number; message?: string } } | undefined;
        if (!last && errs?.error) throw new McpError(`mcp server "${this.name}" error: ${errs.error.message ?? 'unknown'}`, 'SERVER_ERROR', errs.error);
        if (!last) throw new McpError(`mcp server "${this.name}" empty SSE stream`, 'PROTOCOL_ERROR');
        body = (last as { result: unknown }).result;
      } else {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw new McpError(`mcp server "${this.name}" returned non-JSON`, 'PROTOCOL_ERROR');
        }
        const env = body as { result?: unknown; error?: { code?: number; message?: string } };
        if (env && typeof env === 'object' && 'error' in env && env.error) {
          throw new McpError(`mcp server "${this.name}" error: ${env.error.message ?? 'unknown'}`, 'SERVER_ERROR', env.error);
        }
        body = env && typeof env === 'object' && 'result' in env ? env.result : body;
      }
      return body;
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new McpError(`mcp call "${method}" timed out after ${timeoutMs}ms`, 'TIMEOUT');
      }
      throw new McpError(`mcp call "${method}" failed: ${err instanceof Error ? err.message : String(err)}`, 'IO_ERROR');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
