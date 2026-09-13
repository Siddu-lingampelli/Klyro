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
