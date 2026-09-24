/**
 * Proxy support (1.3): `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (either
 * case) are honored for provider, web, and update fetches. No dependencies:
 * plain-HTTP goes through the proxy as a forward absolute-URI request and
 * HTTPS is tunneled with CONNECT + TLS, all on node:http/https/net/tls.
 *
 * Loopback destinations are never proxied. `NO_PROXY` supports exact hosts,
 * leading-dot and bare suffixes, `*`, and IPv4 CIDR ranges. Only `http://`
 * proxy URLs are supported (the standard CONNECT-proxy shape); anything
 * else is treated as unconfigured.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';

export interface ProxyEndpoint {
  host: string;
  port: number;
  /** `user:password` from the proxy URL userinfo, when present. */
  auth?: string;
}

export interface ProxiedInit extends RequestInit {
  /** Total-operation timeout (CONNECT, TLS handshake, and response). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROXY_PORT = 8080;
const MAX_REDIRECTS = 5;

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (h.startsWith('127.')) {
    const parts = h.split('.');
    return parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
  }
  return false;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) return null;
  return parts.reduce((acc, p) => acc * 256 + Number(p), 0) >>> 0;
}

function noProxyMatch(host: string, noProxy: string): boolean {
  const h = host.toLowerCase();
  for (const rawEntry of noProxy.split(',')) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const name = entry.split(':')[0]!;
    if (h === name || h.endsWith(`.${name.replace(/^\./, '')}`)) return true;
    const slash = name.indexOf('/');
    if (slash !== -1) {
      const base = ipv4ToInt(name.slice(0, slash));
      const bits = Number(name.slice(slash + 1));
      const addr = ipv4ToInt(h);
      if (base !== null && addr !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        if ((addr & mask) === (base & mask)) return true;
      }
    }
  }
  return false;
}

/** Resolve the proxy for a URL, or null for a direct connection. */
export function proxyForUrl(rawUrl: string, env: NodeJS.ProcessEnv = process.env): ProxyEndpoint | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (isLoopbackHost(host)) return null;
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? '';
  if (noProxy && noProxyMatch(host, noProxy)) return null;
  const raw = u.protocol === 'https:'
    ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy)
    : (env.HTTP_PROXY ?? env.http_proxy);
  if (!raw) return null;
  let p: URL;
  try {
    p = new URL(raw);
  } catch {
    return null;
  }
  if (p.protocol !== 'http:' || !p.hostname) return null;
  const port = p.port ? Number(p.port) : DEFAULT_PROXY_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const auth = p.username ? `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}` : undefined;
  return { host: p.hostname, port, ...(auth ? { auth } : {}) };
}

function proxyAuthHeader(proxy: ProxyEndpoint): Record<string, string> {
  return proxy.auth ? { 'Proxy-Authorization': `Basic ${Buffer.from(proxy.auth, 'utf-8').toString('base64')}` } : {};
}

function abortError(signal: AbortSignal | null | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error('aborted');
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[String(k).toLowerCase()] = String(v);
    return out;
  }
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = String(v);
  return out;
}

/**
 * Open a CONNECT tunnel to targetHost:targetPort through the proxy.
 * Resolves with the tunnelled socket (paused); rejects on timeout, abort,
 * proxy errors, or non-200 responses.
 */
export function tunnelSocket(
  targetHost: string,
  targetPort: number,
  proxy: ProxyEndpoint,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { sock.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    const sock = net.connect(proxy.port, proxy.host);
    const timer = setTimeout(() => fail(new Error(`proxy CONNECT to ${targetHost}:${targetPort} timed out after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = (): void => fail(abortError(signal));
    if (signal?.aborted) {
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      reject(abortError(signal));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    let head = Buffer.alloc(0);
    sock.on('connect', () => {
      sock.write(
        [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`]
          .concat(Object.entries(proxyAuthHeader(proxy)).map(([k, v]) => `${k}: ${v}`))
          .concat(['', '']).join('\r\n'),
      );
    });
    sock.on('data', (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > 8192) fail(new Error('proxy CONNECT response too long'));
        return;
      }
      const statusLine = head.subarray(0, end).toString('latin1').split('\r\n')[0] ?? '';
      const statusMatch = /HTTP\/\d+(?:\.\d+)?\s+(\d+)/.exec(statusLine);
      const code = statusMatch ? Number(statusMatch[1]) : NaN;
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      sock.removeAllListeners('data');
      if (code !== 200) {
        try { sock.destroy(); } catch { /* ignore */ }
        reject(new Error(`proxy CONNECT rejected: ${statusLine.trim() || 'no status'}`));
        return;
      }
      try { sock.pause(); } catch { /* ignore */ }
      resolve(sock);
    });
    sock.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    sock.on('close', () => { if (!done) fail(new Error('proxy connection closed')); });
  });
}

function collectResponse(
  req: http.ClientRequest,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      req.destroy(abortError(signal));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(abortError(signal));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const headers = new Headers();
        const raw = res.headersDistinct ?? res.headers;
        for (const [k, v] of Object.entries(raw)) {
          if (v === undefined) continue;
          headers.append(k, Array.isArray(v) ? v.join(', ') : String(v));
        }
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, statusText: res.statusMessage ?? '', headers }));
      });
      res.on('error', (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function bodyToBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf-8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new TypeError('proxiedFetch: unsupported body type');
}

async function requestViaProxy(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  proxy: ProxyEndpoint,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<Response> {
  if (signal?.aborted) throw abortError(signal);
  if (url.protocol === 'http:') {
    const target = `${url.hostname}${url.port ? `:${url.port}` : ''}`;
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method,
      path: url.href, // forward-proxy form: absolute URI
      headers: { host: target, ...proxyAuthHeader(proxy), ...headers },
      signal: signal ?? undefined,
    });
    const pending = collectResponse(req, timeoutMs, signal);
    req.end(body);
    return pending;
  }
  // https: — CONNECT tunnel, then TLS, then ordinary HTTPS on the socket.
  const port = url.port ? Number(url.port) : 443;
  const sock = await tunnelSocket(url.hostname, port, proxy, timeoutMs, signal);
  if (signal?.aborted) {
    try { sock.destroy(); } catch { /* ignore */ }
    throw abortError(signal);
  }
  const tlsSock = tls.connect({ socket: sock, servername: url.hostname });
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      tlsSock.off('secureConnect', onSecure);
      tlsSock.off('error', onErr);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      try { tlsSock.destroy(abortError(signal)); } catch { /* ignore */ }
      reject(abortError(signal));
    };
    const onSecure = (): void => { cleanup(); resolve(); };
    const onErr = (err: Error): void => { cleanup(); reject(err); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    tlsSock.once('secureConnect', onSecure);
    tlsSock.once('error', onErr);
  });
  const req = https.request({
    host: url.hostname,
    port,
    path: `${url.pathname}${url.search}`,
    method,
    headers: { host: url.host, ...headers },
    createConnection: () => tlsSock,
    signal: signal ?? undefined,
  });
  const pending = collectResponse(req, timeoutMs, signal);
  req.end(body);
  return pending;
}

/**
 * Drop-in fetch replacement: routes through HTTP(S)_PROXY when one applies,
 * otherwise delegates to global fetch (byte-identical behavior, including
 * redirect following). Follows up to 5 redirects in proxied mode unless
 * `redirect: 'manual'` is set. Only `string | URL` inputs are supported.
 */
export async function proxiedFetch(input: RequestInfo | URL, init: ProxiedInit = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, redirect, ...rest } = init;
  if (typeof input !== 'string' && !(input instanceof URL)) {
    throw new TypeError('proxiedFetch: only string | URL inputs are supported');
  }
  let url = new URL(String(input));
  let method = (rest.method ?? 'GET').toUpperCase();
  const headers = headersToRecord(rest.headers);
  let body = bodyToBuffer(rest.body as BodyInit | null | undefined);
  const signal = rest.signal ?? undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const proxy = proxyForUrl(url.href);
    let res: Response;
    if (!proxy) {
      res = await globalThis.fetch(url.href, { ...rest, method, headers, body } as RequestInit);
    } else {
      res = await requestViaProxy(url, method, headers, body, proxy, timeoutMs, signal);
    }
    if (redirect === 'manual' || ![301, 302, 303, 307, 308].includes(res.status)) return res;
    const loc = res.headers.get('location');
    if (!loc) return res;
    try { await res.arrayBuffer(); } catch { /* ignore — drain best-effort */ }
    url = new URL(loc, url.href);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      delete headers['content-length'];
      delete headers['content-type'];
    }
  }
  throw new Error('proxiedFetch: too many redirects');
}
