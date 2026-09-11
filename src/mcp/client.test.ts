/**
 * Tests for src/mcp/client.ts — real stdio subprocesses via `node -e`
 * scripts (newline-delimited JSON-RPC). Small timeouts keep the suite fast;
 * only the connect-timeout case waits out the 15s spawn deadline.
 */
import { describe, expect, it } from 'vitest';
import { McpClient, McpError } from './client.js';
import type { McpServerSpec } from './config.js';

function spec(script: string, timeoutMs = 3000): McpServerSpec {
  return {
    command: process.execPath,
    args: ['-e', script],
    policy: { allowTools: ['echo'], timeoutMs },
  };
}

/** Responds to initialize only; ignores every other request (for abort tests). */
const INIT_ONLY_SCRIPT = [
  "const readline = require('readline');",
  'const rl = readline.createInterface({ input: process.stdin });',
  "rl.on('line', (line) => {",
  '  let m; try { m = JSON.parse(line); } catch (e) { return; }',
  '  if (m.id === undefined || m.id === null) return;',
  "  if (m.method === 'initialize') {",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result:",
  "      { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0.0.0' } } }) + '\\n');",
  '  }',
  '});',
].join('\n');

/** Full fake server: initialize + tools/list + tools/call. */
const ECHO_SCRIPT = [
  "const readline = require('readline');",
  'const rl = readline.createInterface({ input: process.stdin });',
  "rl.on('line', (line) => {",
  '  let m; try { m = JSON.parse(line); } catch (e) { return; }',
  '  if (m.id === undefined || m.id === null) return;',
  "  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');",
  "  if (m.method === 'initialize') respond({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0.0.0' } });",
  "  else if (m.method === 'tools/list') respond({ tools: [{ name: 'echo', description: 'echoes input',",
  "    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }] });",
  "  else if (m.method === 'tools/call') {",
  '    const q = m.params && m.params.arguments ? m.params.arguments.q : undefined;',
  "    respond({ content: [{ type: 'text', text: 'hello ' + (q === undefined ? 'world' : q) }], isError: false });",
  '  }',
  '  else respond({});',
  '});',
].join('\n');

describe('McpClient stdio integration', () => {
  it('round-trips listTools + callTool with redaction-safe text', async () => {
    const client = new McpClient('echo', spec(ECHO_SCRIPT));
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);
      const res = await client.callTool('echo', { q: 'mars' });
      expect(res.isError).toBe(false);
      expect(res.text).toBe('hello mars');
      expect(client.pendingCount()).toBe(0);
    } finally {
      await client.close();
    }
    expect(client.pendingCount()).toBe(0);
  }, 10_000);

  it('aborting listTools rejects ABORTED and drains the pending map', async () => {
    const client = new McpClient('slow', spec(INIT_ONLY_SCRIPT));
    try {
      await client.connect();
      const ctl = new AbortController();
      const p = client.listTools(ctl.signal);
      ctl.abort();
      let code = '';
      try {
        await p;
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        code = (err as McpError).code;
      }
      expect(code).toBe('ABORTED');
      expect(client.pendingCount()).toBe(0);
    } finally {
      await client.close();
    }
  }, 10_000);

  it('close() is idempotent against a fast-exiting process', async () => {
    const client = new McpClient('fast-exit', spec('process.exit(0);', 2000));
    // initialize can never complete — connect must reject, never hang.
    await expect(client.connect()).rejects.toBeInstanceOf(McpError);
    // Idempotent vs the exit handler: these must resolve promptly.
    await client.close();
    await client.close();
    expect(client.pendingCount()).toBe(0);
  }, 10_000);

  it('connect() times out after the spawn deadline and kills the partial child', async () => {
    const client = new McpClient('never', spec('setInterval(() => {}, 1000);', 60_000));
    const start = Date.now();
    let code = '';
    try {
      await client.connect();
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      code = (err as McpError).code;
    }
    expect(code).toBe('TIMEOUT');
    // ~15s deadline, well under the 25s test budget, far above instant.
    expect(Date.now() - start).toBeGreaterThan(10_000);
    expect(client.pendingCount()).toBe(0);
    await client.close();
  }, 25_000);
});
