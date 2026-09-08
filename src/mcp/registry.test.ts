/**
 * Tests for src/mcp/registry.ts — fake in-memory McpClientLike, real
 * ToolRegistry + PolicyEngine. No subprocesses, no network.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../tools/registry.js';
import { defineTool, type ToolContext } from '../tools/types.js';
import { PolicyEngine, builtinRules, clonePolicyConfig } from '../policy/engine.js';
import { McpError, type McpCallResult, type McpClientLike, type McpToolDef } from './client.js';
import type { McpServerSpec } from './config.js';
import { loadAndRegisterMcp, registerMcpServers, sanitizeMcpName } from './registry.js';

const ctx: ToolContext = { cwd: 'A:\\test', env: {} };

class FakeClient implements McpClientLike {
  calls: Array<{ name: string; args: unknown }> = [];
  closed = false;
  constructor(
    private readonly tools: McpToolDef[] = [],
    private readonly opts: {
      listToolsError?: string;
      callError?: unknown;
      handler?: (name: string, args: unknown) => McpCallResult;
    } = {},
  ) {}
  async listTools(): Promise<McpToolDef[]> {
    if (this.opts.listToolsError) throw new McpError(this.opts.listToolsError, 'SERVER_ERROR');
    return this.tools;
  }
  async callTool(name: string, args: unknown, _signal?: AbortSignal): Promise<McpCallResult> {
    this.calls.push({ name, args });
    if (this.opts.callError !== undefined) throw this.opts.callError;
    if (this.opts.handler) return this.opts.handler(name, args);
    return { text: 'ok', isError: false, raw: {} };
  }
  async listResources() {
    return [];
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function spec(policy?: McpServerSpec['policy'], extra?: Partial<McpServerSpec>): McpServerSpec {
  return { command: 'fake-cmd', ...(policy !== undefined ? { policy } : {}), ...(extra ?? {}) };
}

describe('sanitizeMcpName', () => {
  it('replaces non-alphanumerics with underscores', () => {
    expect(sanitizeMcpName('my-server!', 'do.thing')).toBe('mcp__my_server___do_thing');
  });

  it('caps the server part at 20 chars and the total at 64', () => {
    const name = sanitizeMcpName('a'.repeat(50), 'b'.repeat(50));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toBe(`mcp__${'a'.repeat(20)}__${'b'.repeat(37)}`);
  });

  it('falls back on empty parts', () => {
    expect(sanitizeMcpName('', '')).toBe('mcp__server__tool');
  });
});

describe('registerMcpServers', () => {
  it('registers tools with [mcp:server] description prefix', async () => {
    const fake = new FakeClient([{ name: 'read-file', description: 'reads things' }]);
    const registry = new ToolRegistry();
    const res = await registerMcpServers(
      { servers: { srv: spec({ allowTools: ['read-file'] }) } },
      { registry, clientFactory: () => fake },
    );
    expect(res.registered).toEqual(['mcp__srv__read_file']);
    expect(res.errors).toEqual([]);
    expect(registry.get('mcp__srv__read_file')?.description).toBe('[mcp:srv] reads things');
    await res.closeAll();
    expect(fake.closed).toBe(true);
  });

  it('denied tool never reaches the client (POLICY_DENIED)', async () => {
    const fake = new FakeClient([{ name: 'open-tool' }, { name: 'secret-tool' }]);
    const registry = new ToolRegistry();
    await registerMcpServers(
      { servers: { srv: spec({ allowTools: ['open-tool'] }) } },
      { registry, clientFactory: () => fake },
    );
    const out = await registry.execute('mcp__srv__secret_tool', {}, ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('POLICY_DENIED');
    expect(fake.calls).toEqual([]);
  });

  it('denyTools wins over allowTools', async () => {
    const fake = new FakeClient([{ name: 'x' }]);
    const registry = new ToolRegistry();
    await registerMcpServers(
      { servers: { srv: spec({ allowTools: ['x'], denyTools: ['x'] }) } },
      { registry, clientFactory: () => fake },
    );
    const out = await registry.execute('mcp__srv__x', {}, ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('POLICY_DENIED');
    expect(fake.calls).toEqual([]);
  });

  it('server with NO policy denies everything', async () => {
    const fake = new FakeClient([{ name: 'anything' }]);
    const registry = new ToolRegistry();
    await registerMcpServers({ servers: { srv: spec() } }, { registry, clientFactory: () => fake });
    const out = await registry.execute('mcp__srv__anything', {}, ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('POLICY_DENIED');
    expect(fake.calls).toEqual([]);
  });

  it('redacts sk-proj secrets from success values', async () => {
    const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX';
    const fake = new FakeClient([{ name: 'leak' }], {
      handler: () => ({ text: `token is ${secret} done`, isError: false, raw: {} }),
    });
    const registry = new ToolRegistry();
    await registerMcpServers(
      { servers: { srv: spec({ allowTools: ['leak'] }) } },
      { registry, clientFactory: () => fake },
    );
    const out = await registry.execute('mcp__srv__leak', {}, ctx);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(String(out.value)).not.toContain(secret);
      expect(String(out.value)).toContain('[REDACTED]');
    }
  });

  it('maps isError results to ok:false TOOL_ERROR, redacted and bounded', async () => {
    const secret = 'sk-proj-ZZZZZZZZZZZZZZZZZZZZZZZZ';
    const fake = new FakeClient([{ name: 'boom' }], {
      handler: () => ({ text: `fail ${secret} ${'x'.repeat(5000)}`, isError: true, raw: {} }),
    });
    const registry = new ToolRegistry();
    await registerMcpServers(
      { servers: { srv: spec({ allowTools: ['boom'] }) } },
      { registry, clientFactory: () => fake },
    );
    const out = await registry.execute('mcp__srv__boom', {}, ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('TOOL_ERROR');
      expect(out.error.message).not.toContain(secret);
      expect(out.error.message.length).toBeLessThanOrEqual(2000);
    }
  });

  it('maps McpError to its code with a redacted message', async () => {
    const fake = new FakeClient([{ name: 'flaky' }], {
      callError: new McpError('timed out with sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA', 'TIMEOUT'),
    });
    const registry = new ToolRegistry();
    await registerMcpServers(
      { servers: { srv: spec({ allowTools: ['flaky'] }) } },
      { registry, clientFactory: () => fake },
    );
    const out = await registry.execute('mcp__srv__flaky', {}, ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('TIMEOUT');
      expect(out.error.message).not.toContain('sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA');
    }
  });

  it('missing required zod prop yields INVALID_INPUT and never calls the client', async () => {
    const fake = new FakeClient([
      {
        name: 'search',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
    ]);
    const registry = new ToolRegistry();
    await registerMcpServers(
      { servers: { srv: spec({ allowTools: ['search'] }) } },
      { registry, clientFactory: () => fake },
    );
    const out = await registry.execute('mcp__srv__search', {}, ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('INVALID_INPUT');
    expect(fake.calls).toEqual([]);
    // And a valid input passes validation through to the client.
    const ok = await registry.execute('mcp__srv__search', { q: 'hi' }, ctx);
    expect(ok).toEqual({ ok: true, value: 'ok' });
    expect(fake.calls).toEqual([{ name: 'search', args: { q: 'hi' } }]);
  });

  it('name collision with an existing tool is skipped', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'mcp__srv__dup',
        description: 'pre-existing',
        inputSchema: z.object({}),
        execute: async () => ({ ok: true as const, value: null }),
      }),
    );
    const fake = new FakeClient([{ name: 'dup' }]);
    const res = await registerMcpServers(
      { servers: { srv: spec({ allowTools: ['dup'] }) } },
      { registry, clientFactory: () => fake },
    );
    expect(res.registered).toEqual([]);
    expect(res.skipped).toEqual([{ name: 'mcp__srv__dup', reason: 'name-collision' }]);
    await res.closeAll();
  });

  it('skips disabled servers, records connect/listTools failures, never throws', async () => {
    const registry = new ToolRegistry();
    const res = await registerMcpServers(
      {
        servers: {
          off: spec({ allowTools: ['a'] }, { disabled: true }),
          badconnect: spec({ allowTools: ['a'] }),
          badlist: spec({ allowTools: ['a'] }),
        },
      },
      {
        registry,
        clientFactory: (name) => {
          if (name === 'badconnect') throw new Error('spawn ENOENT');
          if (name === 'badlist') return new FakeClient([], { listToolsError: 'list blew up' });
          throw new Error(`unexpected server ${name}`);
        },
      },
    );
    expect(res.registered).toEqual([]);
    expect(res.errors.map((e) => e.server).sort()).toEqual(['badconnect', 'badlist']);
    await res.closeAll();
  });

  it('requireApproval adds an ask rule (real PolicyEngine evaluates to ask)', async () => {
    const engine = new PolicyEngine(builtinRules(), clonePolicyConfig());
    const registry = new ToolRegistry();
    const fake = new FakeClient([{ name: 't' }]);
    await registerMcpServers(
      { servers: { srv: spec({ allowTools: ['t'], requireApproval: true }) } },
      { registry, policy: engine, clientFactory: () => fake },
    );
    const d = await engine.evaluate(
      { name: 'mcp__srv__t', input: {} },
      { cwd: 'A:\\test', nonInteractive: false },
    );
    expect(d.action).toBe('ask');
  });
});

describe('loadAndRegisterMcp', () => {
  it('never throws and returns the contract shape', async () => {
    const registry = new ToolRegistry();
    const res = await loadAndRegisterMcp({
      cwd: 'A:\\definitely-not-a-real-dir-12345',
      registry,
      clientFactory: () => new FakeClient([]),
    });
    expect(Array.isArray(res.registered)).toBe(true);
    expect(Array.isArray(res.errors)).toBe(true);
    expect(Array.isArray(res.skipped)).toBe(true);
    expect(typeof res.closeAll).toBe('function');
    await res.closeAll();
  });
});
