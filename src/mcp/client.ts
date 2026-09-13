/**
 * P1 — MCP stdio client (r-11-17.md §3.1).
 *
 * Minimal JSON-RPC 2.0 over newline-delimited stdio: `initialize`,
 * `tools/list`, `tools/call`, `resources/list`, `resources/read`,
 * `prompts/list`, `prompts/get`, `ping`.
 * Every call is bound to an `AbortSignal` and a per-call timeout; spawn
 * failures and server errors surface as typed `McpError`s — never throws
 * raw across the boundary.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import type { McpServerSpec } from './config.js';

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpResource {
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpCallResult {
  /** Normalized text payload (content blocks joined). */
  text: string;
  isError: boolean;
  raw: unknown;
}

export interface McpClientLike {
  listTools(signal?: AbortSignal): Promise<McpToolDef[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>;
  listResources(signal?: AbortSignal): Promise<McpResource[]>;
  promptsList?(signal?: AbortSignal): Promise<McpPromptDef[]>;
  promptsGet?(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
}

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 8192;
/** Upper bound on spawn + initialize handshake; partial children are killed. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Grace period between SIGTERM and SIGKILL in close(). */
const CLOSE_SIGKILL_AFTER_MS = 2000;

export class McpClient implements McpClientLike {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuf = '';
  private stderrTail = '';
  private dead: McpError | null = null;
  private closed = false;

  constructor(
    readonly name: string,
    private readonly spec: McpServerSpec,
  ) {
    // URL specs route to RemoteMcpClient via makeMcpClient — direct
    // construction without a command is a programming error, fail fast.
    if (!spec.command) throw new McpError(`mcp server "${name}" has no command (use url for remote servers)`, 'INVALID_SPEC');
  }

  async connect(): Promise<void> {
    if (this.child) return;
    const command = this.spec.command;
    if (!command) throw new McpError(`mcp server "${this.name}" has no command (use url for remote servers)`, 'INVALID_SPEC');
    const timeoutMs = this.spec.policy?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(command, this.spec.args ?? [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(this.spec.env ?? {}) },
          shell: false,
          windowsHide: true,
        });
      } catch (err) {
        reject(new McpError(`mcp server "${this.name}" spawn failed: ${err instanceof Error ? err.message : String(err)}`, 'SPAWN_FAILED'));
        return;
      }
      this.child = child;
      // Swallow async stream errors (e.g. EPIPE on write-after-exit):
      // request promises already surface failures via write callbacks and
      // the exit handler, so these must never become uncaught exceptions.
      child.stdin?.on('error', () => {});
      child.stdout?.on('error', () => {});
      child.stderr?.on('error', () => {});
      child.on('error', (err) => {
        this.failAll(new McpError(`mcp server "${this.name}" process error: ${err.message}`, 'SPAWN_FAILED'));
        if (!this.connected) reject(new McpError(`mcp server "${this.name}" spawn failed: ${err.message}`, 'SPAWN_FAILED'));
      });
      child.stderr?.on('data', (b: Buffer) => {
        this.stderrTail = (this.stderrTail + b.toString('utf-8')).slice(-MAX_STDERR_BYTES);
      });
      child.stdout?.on('data', (b: Buffer) => this.onStdout(b.toString('utf-8')));
      child.on('exit', (code, signal) => {
        if (!this.closed) {
          this.failAll(new McpError(`mcp server "${this.name}" exited (${signal ?? `code ${code}`})${this.stderrTail ? `: ${this.stderrTail.slice(-300)}` : ''}`, 'SERVER_EXITED'));
        }
      });
      // Consider the transport up once the process is spawned; the
      // initialize handshake below proves the protocol.
      resolve();
    });
    try {
      let connectTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          (async () => {
            await this.request('initialize', {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: 'klyro', version: '1.0.2' },
            }, timeoutMs);
            this.notify('notifications/initialized', {});
            this.connected = true;
          })(),
          new Promise<never>((_resolve, reject) => {
            connectTimer = setTimeout(() => {
              reject(new McpError(`mcp server "${this.name}" connect timed out after ${CONNECT_TIMEOUT_MS}ms`, 'TIMEOUT'));
            }, CONNECT_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (connectTimer) clearTimeout(connectTimer);
      }
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  private connected = false;

  async listTools(signal?: AbortSignal): Promise<McpToolDef[]> {
    this.assertLive();
    const res = (await this.request('tools/list', {}, this.timeout(), signal)) as { tools?: McpToolDef[] };
    return Array.isArray(res.tools) ? res.tools : [];
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    this.assertLive();
    const res = (await this.request('tools/call', { name, arguments: args ?? {} }, this.timeout(), signal)) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const blocks = Array.isArray(res.content) ? res.content : [];
    const text = blocks.map((b) => (typeof b.text === 'string' ? b.text : JSON.stringify(b))).join('\n');
    return { text, isError: res.isError === true, raw: res };
  }

  async listResources(signal?: AbortSignal): Promise<McpResource[]> {
    this.assertLive();
    const res = (await this.request('resources/list', {}, this.timeout(), signal)) as { resources?: McpResource[] };
    return Array.isArray(res.resources) ? res.resources : [];
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<string> {
    this.assertLive();
    const res = (await this.request('resources/read', { uri }, this.timeout(), signal)) as {
      contents?: Array<{ text?: string }>;
    };
    const contents = Array.isArray(res.contents) ? res.contents : [];
    return contents.map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
  }

  /** List prompts; servers without prompts support yield [] (not an error). */
  async promptsList(signal?: AbortSignal): Promise<McpPromptDef[]> {
    this.assertLive();
    let res: { prompts?: McpPromptDef[] };
    try {
      res = (await this.request('prompts/list', {}, this.timeout(), signal)) as { prompts?: McpPromptDef[] };
    } catch (err) {
      if (err instanceof McpError && err.code === 'SERVER_ERROR' && (err.details as { code?: number } | undefined)?.code === -32601) {
        return [];
      }
      throw err;
    }
    return Array.isArray(res.prompts) ? res.prompts : [];
  }

  /** Get a prompt's messages as text. Throws McpError when unsupported/unknown. */
  async promptsGet(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<string> {
    this.assertLive();
    const res = (await this.request('prompts/get', { name, arguments: args ?? {} }, this.timeout(), signal)) as {
      messages?: Array<{ content?: { type?: string; text?: string } | unknown }>;
      description?: string;
    };
    const messages = Array.isArray(res.messages) ? res.messages : [];
    const parts: string[] = [];
    if (typeof res.description === 'string' && res.description) parts.push(res.description);
    for (const m of messages) {
      const c = (m as { content?: { text?: string } }).content;
      if (c && typeof c.text === 'string') parts.push(c.text);
      else if (c !== undefined) parts.push(JSON.stringify(c));
    }
    return parts.join('\n\n');
  }

  async close(): Promise<void> {
    // Idempotent vs the exit handler: closed is set FIRST (the on('exit')
    // callback checks it before failAll), and a second close() with no child
    // left is a no-op.
    if (this.closed && this.child === null) return;
    this.closed = true;
    this.failAll(new McpError(`mcp server "${this.name}" closed`, 'CLOSED'));
    const child = this.child;
    this.child = null;
    if (!child) return;
    // Already reaped — no escalation timer needed.
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      try {
        if (child.pid !== undefined) {
          execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        }
      } catch { /* ignore — fall through to kill() */ }
      try { child.kill(); } catch { /* ignore */ }
      return;
    }
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, CLOSE_SIGKILL_AFTER_MS);
    timer.unref?.();
    child.once('exit', () => clearTimeout(timer));
  }

  /** Test hook: number of in-flight JSON-RPC requests. */
  pendingCount(): number {
    return this.pending.size;
  }

  /* ---------------- internals ---------------- */

  private timeout(): number {
    return this.spec.policy?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private assertLive(): void {
    if (this.dead) throw this.dead;
    if (!this.child || this.closed) throw new McpError(`mcp server "${this.name}" is not connected`, 'NOT_CONNECTED');
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue; // server chatter — ignore, don't crash
      }
      if (typeof msg.id !== 'number') continue; // notification — ignore
      const pend = this.pending.get(msg.id);
      if (!pend) continue;
      this.pending.delete(msg.id);
      clearTimeout(pend.timer);
      if (pend.signal && pend.onAbort) pend.signal.removeEventListener('abort', pend.onAbort);
      if (msg.error) {
        pend.reject(new McpError(`mcp server "${this.name}" error: ${msg.error.message ?? 'unknown'}`, 'SERVER_ERROR', msg.error));
      } else {
        pend.resolve(msg.result);
      }
    }
  }

  private notify(method: string, params: unknown): void {
    try {
      this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch { /* best-effort */ }
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new McpError(`mcp call "${method}" aborted`, 'ABORTED'));
        return;
      }
      if (!this.child?.stdin) {
        reject(new McpError(`mcp server "${this.name}" has no stdin`, 'NOT_CONNECTED'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p?.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
        this.pending.delete(id);
        reject(new McpError(`mcp call "${method}" timed out after ${timeoutMs}ms`, 'TIMEOUT'));
      }, timeoutMs);
      const pend: Pending = { resolve, reject, timer };
      if (signal) {
        pend.signal = signal;
        pend.onAbort = () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new McpError(`mcp call "${method}" aborted`, 'ABORTED'));
        };
        signal.addEventListener('abort', pend.onAbort, { once: true });
      }
      this.pending.set(id, pend);
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timer);
            if (signal && pend.onAbort) signal.removeEventListener('abort', pend.onAbort);
            reject(new McpError(`mcp call "${method}" write failed: ${err.message}`, 'IO_ERROR'));
          }
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        if (signal && pend.onAbort) signal.removeEventListener('abort', pend.onAbort);
        reject(new McpError(`mcp call "${method}" write failed: ${err instanceof Error ? err.message : String(err)}`, 'IO_ERROR'));
      }
    });
  }

  private failAll(err: McpError): void {
    if (!this.dead) this.dead = err;
    for (const [id, pend] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pend.timer);
      if (pend.signal && pend.onAbort) pend.signal.removeEventListener('abort', pend.onAbort);
      pend.reject(err);
    }
  }
}
