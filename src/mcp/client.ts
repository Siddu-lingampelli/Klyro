/**
 * P1 — MCP stdio client (r-11-17.md §3.1).
 *
 * Minimal JSON-RPC 2.0 over newline-delimited stdio: `initialize`,
 * `tools/list`, `tools/call`, `resources/list`, `resources/read`, `ping`.
 * Every call is bound to an `AbortSignal` and a per-call timeout; spawn
 * failures and server errors surface as typed `McpError`s — never throws
 * raw across the boundary.
 */
import { spawn, type ChildProcess } from 'node:child_process';
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

export interface McpCallResult {
  /** Normalized text payload (content blocks joined). */
  text: string;
  isError: boolean;
  raw: unknown;
}

export interface McpClientLike {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>;
  listResources(): Promise<McpResource[]>;
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
  ) {}

  async connect(): Promise<void> {
    if (this.child) return;
    const timeoutMs = this.spec.policy?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.spec.command, this.spec.args ?? [], {
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
      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'klyro', version: '1.0.0' },
      }, timeoutMs);
      this.notify('notifications/initialized', {});
      this.connected = true;
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  private connected = false;

  async listTools(): Promise<McpToolDef[]> {
    this.assertLive();
    const res = (await this.request('tools/list', {}, this.timeout())) as { tools?: McpToolDef[] };
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

  async listResources(): Promise<McpResource[]> {
    this.assertLive();
    const res = (await this.request('resources/list', {}, this.timeout())) as { resources?: McpResource[] };
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

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new McpError(`mcp server "${this.name}" closed`, 'CLOSED'));
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      try { child.kill(); } catch { /* ignore */ }
    }
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
      pend.signal?.removeEventListener('abort', pend.onAbort!);
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
            reject(new McpError(`mcp call "${method}" write failed: ${err.message}`, 'IO_ERROR'));
          }
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new McpError(`mcp call "${method}" write failed: ${err instanceof Error ? err.message : String(err)}`, 'IO_ERROR'));
      }
    });
  }

  private failAll(err: McpError): void {
    if (!this.dead) this.dead = err;
    for (const [id, pend] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pend.timer);
      pend.reject(err);
    }
  }
}
