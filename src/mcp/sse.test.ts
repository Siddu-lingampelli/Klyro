import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpError } from './client.js';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SseMcpClient } from './sse.js';

// Legacy HTTP+SSE stub: GET /sse opens the event stream with an endpoint
// event; POST /message answers JSON-RPC, pushing responses onto the stream.
function startSseStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const streams = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('event: endpoint\ndata: /message\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'POST' && req.url === '/message') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        let msg: { id?: number; method?: string; params?: { name?: string } } = {};
        try { msg = JSON.parse(body) as typeof msg; } catch { /* ignore */ }
        const answer = (payload: unknown): void => {
          const line = `data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload })}\n\n`;
          for (const s of streams) {
            try { s.write(line); } catch { /* ignore */ }
          }
        };
        if (msg.method === 'initialize') answer({ result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'sse-stub', version: '0' } } });
        else if (msg.method === 'tools/list') answer({ result: { tools: [{ name: 'ping', description: 'pong', inputSchema: { type: 'object' } }] } });
        else if (msg.method === 'tools/call') answer({ result: { content: [{ type: 'text', text: 'pong' }] } });
        else answer({ error: { code: -32601, message: 'Method not found' } });
        res.writeHead(202);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/sse`,
        close: () => new Promise((r) => {
          for (const s of streams) {
            try { s.end(); } catch { /* ignore */ }
          }
          server.close(() => r());
        }),
      });
    });
  });
}

describe('SseMcpClient G1 (remote http rejection)', () => {
  it('refuses a plaintext remote endpoint at contract time', () => {
    delete process.env.KLYRO_ALLOW_INSECURE_MCP;
    expect(() => new SseMcpClient('bad', { url: 'http://evil.example.com/sse', transport: 'sse' })).toThrow(McpError);
  });

  it('accepts loopback http and https', () => {
    expect(() => new SseMcpClient('loop', { url: 'http://127.0.0.1:1/sse', transport: 'sse' })).not.toThrow();
    expect(() => new SseMcpClient('tls', { url: 'https://x.example/sse', transport: 'sse' })).not.toThrow();
  });
});

describe('SseMcpClient (legacy HTTP+SSE)', () => {
  let url = '';
  let close = async (): Promise<void> => undefined;
  beforeEach(async () => {
    const s = await startSseStub();
    url = s.url;
    close = s.close;
  });
  afterEach(async () => { await close(); });

  it('connects via endpoint event, lists and calls tools', async () => {
    const c = new SseMcpClient('sse-stub', { url, transport: 'sse' });
    await c.connect();
    expect((await c.listTools()).map((t) => t.name)).toEqual(['ping']);
    const r = await c.callTool('ping', {});
    expect(r.text).toBe('pong');
    expect(r.isError).toBe(false);
    await c.close();
  });

  it('makeMcpClient routes transport:sse specs to the SSE client', async () => {
    const { makeMcpClient } = await import('./registry.js');
    expect(makeMcpClient('s', { url, transport: 'sse' })).toBeInstanceOf(SseMcpClient);
  });
});
