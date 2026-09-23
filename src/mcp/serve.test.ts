import { describe, it, expect } from 'vitest';
import { makeServeDeps, handleMcpRequest } from './serve.js';

describe('mcp serve — policy-gated stdio server', () => {
  it('answers initialize with server info', async () => {
    const deps = makeServeDeps(process.cwd());
    const res = await handleMcpRequest(deps, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res?.['result']).toMatchObject({ capabilities: { tools: {} } });
  });

  it('lists builtin tools with schemas', async () => {
    const deps = makeServeDeps(process.cwd());
    const res = await handleMcpRequest(deps, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (res?.['result'] as { tools: { name: string }[] }).tools;
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.some((t) => t.name === 'read_file')).toBe(true);
  });

  it('refuses privileged tools without an allow rule (non-interactive serve)', async () => {
    const deps = makeServeDeps(process.cwd());
    const res = await handleMcpRequest(deps, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'spawn_agent', arguments: {} },
    });
    const content = (res?.['result'] as { content: { text: string }[] }).content[0]!.text;
    expect(content).toMatch(/POLICY_DENIED/);
  });

  it('rejects unknown tools and methods', async () => {
    const deps = makeServeDeps(process.cwd());
    const unknown = await handleMcpRequest(deps, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    expect(unknown?.['error']).toMatchObject({ code: -32602 });
    const method = await handleMcpRequest(deps, { jsonrpc: '2.0', id: 5, method: 'frobnicate' });
    expect(method?.['error']).toMatchObject({ code: -32601 });
  });

  it('ignores notifications (no response)', async () => {
    const deps = makeServeDeps(process.cwd());
    expect(await handleMcpRequest(deps, { jsonrpc: '2.0', method: 'ping' })).toBeNull();
  });
});


describe('readBoundedLines - oversized message guard', () => {
  async function collect(input: NodeJS.ReadableStream, maxBytes?: number): Promise<Array<string | { tooLong: true }>> {
    const { readBoundedLines } = await import('./serve.js');
    const out: Array<string | { tooLong: true }> = [];
    for await (const item of readBoundedLines(input, maxBytes)) out.push(item);
    return out;
  }

  it('passes normal lines through, split across chunks', async () => {
    const { Readable } = await import('node:stream');
    const got = await collect(Readable.from([Buffer.from('{"a"'), Buffer.from(':1}\n{"b":2}\n')]));
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('drops an overlong line, reports once, and resyncs after it', async () => {
    const { Readable } = await import('node:stream');
    const big = 'x'.repeat(100);
    const got = await collect(Readable.from([Buffer.from('ok1\n' + big), Buffer.from(big + '\nok2\n')]), 64);
    expect(got[0]).toBe('ok1');
    expect(got).toContainEqual({ tooLong: true });
    expect(got[got.length - 1]).toBe('ok2');
    expect(got.filter((g) => typeof g !== 'string')).toHaveLength(1);
  });
});
