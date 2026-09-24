/**
 * Proxy support (1.3): selection, forward requests, CONNECT handshake,
 * redirect following — all against local stub servers, no real network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { proxyForUrl, tunnelSocket, proxiedFetch } from './proxy.js';

const SAVED: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in SAVED)) SAVED[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(SAVED)) delete SAVED[k];
});

function clearProxyEnv(): void {
  setEnv({ HTTP_PROXY: undefined, HTTPS_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, NO_PROXY: undefined, no_proxy: undefined });
}

describe('proxyForUrl selection', () => {
  it('returns null with no proxy configured', () => {
    clearProxyEnv();
    expect(proxyForUrl('https://example.com/')).toBeNull();
  });

  it('picks scheme envs with defaults, userinfo, and case variants', () => {
    clearProxyEnv();
    setEnv({ HTTP_PROXY: 'http://proxy:3128' });
    expect(proxyForUrl('http://example.com/')).toEqual({ host: 'proxy', port: 3128 });
    expect(proxyForUrl('https://example.com/')).toEqual({ host: 'proxy', port: 3128 });
    setEnv({ HTTPS_PROXY: 'http://u:p@secure:8443' });
    expect(proxyForUrl('https://example.com/')).toEqual({ host: 'secure', port: 8443, auth: 'u:p' });
    setEnv({ HTTP_PROXY: undefined, HTTPS_PROXY: undefined, http_proxy: 'http://lower:8080' });
    expect(proxyForUrl('http://example.com/')).toEqual({ host: 'lower', port: 8080 });
  });

  it('never proxies loopback and honors NO_PROXY', () => {
    clearProxyEnv();
    setEnv({ HTTP_PROXY: 'http://proxy:3128', NO_PROXY: 'internal.example, .corp.example, 10.1.0.0/16' });
    expect(proxyForUrl('http://localhost:11434/')).toBeNull();
    expect(proxyForUrl('http://127.0.0.1:8080/')).toBeNull();
    expect(proxyForUrl('http://internal.example/')).toBeNull();
    expect(proxyForUrl('http://svc.corp.example/')).toBeNull();
    expect(proxyForUrl('http://10.1.2.3/')).toBeNull();
    expect(proxyForUrl('http://10.2.2.3/')).not.toBeNull();
    expect(proxyForUrl('http://public.example/')).not.toBeNull();
  });

  it('rejects non-http proxy URLs and bad ports', () => {
    expect(proxyForUrl('https://x/', { HTTPS_PROXY: 'https://p:1' })).toBeNull();
    expect(proxyForUrl('https://x/', { HTTPS_PROXY: 'http://p:99999' })).toBeNull();
    expect(proxyForUrl('not a url', { HTTP_PROXY: 'http://p:1' })).toBeNull();
  });
});

describe('forward proxy requests', () => {
  it('sends absolute URIs to the proxy with auth', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} | ${req.headers['proxy-authorization'] ?? ''}`);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('via-proxy');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    server.unref();
    const port = (server.address() as { port: number }).port;
    try {
      clearProxyEnv();
      setEnv({ HTTP_PROXY: `http://user:pass@127.0.0.1:${port}` });
      const res = await proxiedFetch(`http://example.invalid:${port}/path`, { timeoutMs: 5000 });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('via-proxy');
      expect(seen[0]).toContain(`http://example.invalid:${port}/path`);
      expect(seen[0]).toContain('Basic ');
    } finally {
      server.close();
    }
  });

  it('follows redirects through the proxy', async () => {
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/r302')) {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('done');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    server.unref();
    const port = (server.address() as { port: number }).port;
    try {
      clearProxyEnv();
      setEnv({ HTTP_PROXY: `http://127.0.0.1:${port}` });
      const res = await proxiedFetch(`http://127.0.0.1:${port}/r302`, { timeoutMs: 5000 });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('done');
    } finally {
      server.close();
    }
  });
});

describe('CONNECT tunnel handshake', () => {
  it('sends CONNECT with auth and resolves on 200', async () => {
    let head = '';
    const server = createNetServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        if (buf.indexOf('\r\n\r\n') !== -1) {
          head = buf.toString('latin1');
          sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    server.unref();
    const port = (server.address() as { port: number }).port;
    try {
      const sock = await tunnelSocket('example.com', 443, { host: '127.0.0.1', port, auth: 'u:p' }, 5000);
      expect(head.startsWith('CONNECT example.com:443 HTTP/1.1')).toBe(true);
      expect(head).toContain('Proxy-Authorization: Basic ');
      sock.destroy();
    } finally {
      server.close();
    }
  });

  it('rejects non-200 CONNECT responses', async () => {
    const server = createNetServer((sock) => {
      sock.on('data', () => sock.end('HTTP/1.1 407 Proxy Auth Required\r\n\r\n'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    server.unref();
    const port = (server.address() as { port: number }).port;
    try {
      await expect(tunnelSocket('example.com', 443, { host: '127.0.0.1', port }, 5000)).rejects.toThrow(/407/);
    } finally {
      server.close();
    }
  });
});
