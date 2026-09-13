import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RemoteMcpClient, parseSseBody } from './remote.js';
import { McpClient } from './client.js';
import { makeMcpClient } from './registry.js';

// Minimal Streamable-HTTP stub: initialize + tools/list + tools/call + prompts/list.
function startStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      let msg: { id?: number; method?: string; params?: { name?: string } } = {};
      try { msg = JSON.parse(body) as typeof msg; } catch { /* ignore */ }
      const send = (payload: unknown): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result: payload }));
      };
      if (msg.method === 'initialize') return send({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '0' } });
      if (msg.method === 'tools/list') return send({ tools: [{ name: 'ping', description: 'pong', inputSchema: { type: 'object' } }] });
      if (msg.method === 'tools/call') return send({ content: [{ type: 'text', text: `called:${(msg.params as { name?: string } | undefined)?.name ?? '?'}` }] });
      if (msg.method === 'prompts/list') return send({ prompts: [{ name: 'review', description: 'review code' }] });
      if (msg.method === 'prompts/get') return send({ messages: [{ role: 'user', content: { type: 'text', text: 'please review' } }] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, error: { code: -32601, message: 'Method not found' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('RemoteMcpClient', () => {
  let url = '';
  let close = async (): Promise<void> => undefined;
  beforeEach(async () => {
    const s = await startStub();
    url = s.url;
    close = s.close;
  });
  afterEach(async () => { await close(); });

  it('connects, lists tools, and calls one', async () => {
    const c = new RemoteMcpClient('stub', { url });
    await c.connect();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['ping']);
    const r = await c.callTool('ping', {});
    expect(r.text).toBe('called:ping');
    expect(r.isError).toBe(false);
    await c.close();
  });

  it('lists and gets prompts', async () => {
    const c = new RemoteMcpClient('stub', { url });
    await c.connect();
    expect((await c.promptsList()).map((p) => p.name)).toEqual(['review']);
    expect(await c.promptsGet('review', {})).toContain('please review');
    await c.close();
  });

  it('makeMcpClient routes url specs to remote, command specs to stdio', () => {
    expect(makeMcpClient('r', { url: 'https://x.example/mcp' })).toBeInstanceOf(RemoteMcpClient);
    expect(makeMcpClient('s', { command: 'node' })).toBeInstanceOf(McpClient);
  });
});

describe('parseSseBody', () => {
  it('extracts data payloads, skips comments and [DONE]', () => {
    const out = parseSseBody(': ping\n\ndata: {"a":1}\n\ndata: [DONE]\n\nnot-a-line\n');
    expect(out).toEqual([{ a: 1 }]);
  });
});
