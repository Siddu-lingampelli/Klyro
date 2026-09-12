/**
 * Tests for src/mcp/registry.ts — fake in-memory McpClientLike, real
 * ToolRegistry + PolicyEngine. No subprocesses, no network.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

  it('has no fallbacks for empty parts (registration skips those as errors)', () => {
    expect(sanitizeMcpName('', '')).toBe('mcp____');
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

function mkProjectDir(servers: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-mcp-test-'));
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }), 'utf-8');
  return dir;
}

describe('sanitization collisions and empty names', () => {
  it('two different raw names mapping to one sanitized name is an error naming both', async () => {
    const registry = new ToolRegistry();
    const res = await registerMcpServers(
      {
        servers: {
          'a-b': spec({ allowTools: ['x'] }),
          'a_b': spec({ allowTools: ['x'] }),
        },
      },
      {
        registry,
        clientFactory: () => new FakeClient([{ name: 'x' }]),
      },
    );
    // First raw name wins; the second is an error, never a silent skip.
    expect(res.registered).toEqual(['mcp__a_b__x']);
    expect(res.skipped).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.server).toBe('a_b');
    expect(res.errors[0]?.message).toContain('a-b/x');
    expect(res.errors[0]?.message).toContain('a_b/x');
    expect(res.errors[0]?.message).toContain('mcp__a_b__x');
    await res.closeAll();
  });

  it('empty tool names are skipped as empty-name errors, not fallback names', async () => {
    const registry = new ToolRegistry();
    const res = await registerMcpServers(
      { servers: { srv: spec({ allowTools: [''] }) } },
      {
        registry,
        clientFactory: () => new FakeClient([{ name: '' }]),
      },
    );
    expect(res.registered).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.server).toBe('srv');
    expect(res.errors[0]?.message).toContain('empty-name');
    await res.closeAll();
  });
});

describe('success truncation', () => {
  it('redacts first, then caps at 12000 chars with a truncated marker', async () => {
    const secret = 'sk-proj-QQQQQQQQQQQQQQQQQQQQQQQQ';
    const fake = new FakeClient([{ name: 'big' }], {
      handler: () => ({ text: `prefix ${secret} ${'z'.repeat(13000)}`, isError: false, raw: {} }),
    });
    const registry = new ToolRegistry();
    await registerMcpServers(
      { servers: { srv: spec({ allowTools: ['big'] }) } },
      { registry, clientFactory: () => fake },
    );
    const out = await registry.execute('mcp__srv__big', {}, ctx);
    expect(out.ok).toBe(true);
    if (out.ok) {
      const value = String(out.value);
      expect(value).not.toContain(secret);
      expect(value).toContain('[REDACTED]');
      expect(value).toContain('[truncated ');
      expect(value.slice(0, 12000)).not.toContain('[truncated ');
      expect(value.length).toBeLessThanOrEqual(12000 + 64);
    }
  });

  it('short values pass through unmarked', async () => {
    const fake = new FakeClient([{ name: 'small' }], {
      handler: () => ({ text: 'tiny', isError: false, raw: {} }),
    });
    const registry = new ToolRegistry();
    await registerMcpServers(
      { servers: { srv: spec({ allowTools: ['small'] }) } },
      { registry, clientFactory: () => fake },
    );
    const out = await registry.execute('mcp__srv__small', {}, ctx);
    expect(out).toEqual({ ok: true, value: 'tiny' });
  });
});

describe('loadAndRegisterMcp project consent', () => {
  const projSpec = { command: 'fake-cmd', policy: { allowTools: ['t'] } };

  it('skips project servers when no approval callback is given (never auto-connects)', async () => {
    const dir = mkProjectDir({ proj1: projSpec });
    const registry = new ToolRegistry();
    const seen: string[] = [];
    const res = await loadAndRegisterMcp({
      cwd: dir,
      registry,
      clientFactory: (name) => {
        seen.push(name);
        return new FakeClient([{ name: 't' }]);
      },
    });
    expect(seen).not.toContain('proj1');
    expect(res.registered).not.toContain('mcp__proj1__t');
    expect(res.errors).toContainEqual({ server: 'proj1', message: 'project server requires approval (skipped)' });
    await res.closeAll();
  });

  it('connects project servers approved by the callback', async () => {
    const dir = mkProjectDir({ proj1: projSpec });
    const registry = new ToolRegistry();
    const approvals: Array<{ name: string; source: 'global' | 'project' }> = [];
    const res = await loadAndRegisterMcp({
      cwd: dir,
      registry,
      clientFactory: () => new FakeClient([{ name: 't' }]),
      approveProjectServer: async (info) => {
        approvals.push(info);
        return true;
      },
    });
    expect(approvals).toEqual([{ name: 'proj1', source: 'project' }]);
    expect(res.registered).toContain('mcp__proj1__t');
    expect(res.errors.filter((e) => e.server === 'proj1')).toEqual([]);
    await res.closeAll();
  });

describe('KLYRO_MCP_DEBUG capture', () => {
  const SECRET = 'sk-proj-DDDDDDDDDDDDDDDDDDDDDDDD';

  function withDebugEnv(dir: string | undefined, flag: string | undefined): { prevDebug: string | undefined; prevCfg: string | undefined } {
    const prevDebug = process.env.KLYRO_MCP_DEBUG;
    const prevCfg = process.env.KLYRO_CONFIG_DIR;
    if (flag === undefined) delete process.env.KLYRO_MCP_DEBUG;
    else process.env.KLYRO_MCP_DEBUG = flag;
    if (dir === undefined) delete process.env.KLYRO_CONFIG_DIR;
    else process.env.KLYRO_CONFIG_DIR = dir;
    return { prevDebug, prevCfg };
  }

  function restoreDebugEnv(saved: { prevDebug: string | undefined; prevCfg: string | undefined }): void {
    if (saved.prevDebug === undefined) delete process.env.KLYRO_MCP_DEBUG;
    else process.env.KLYRO_MCP_DEBUG = saved.prevDebug;
    if (saved.prevCfg === undefined) delete process.env.KLYRO_CONFIG_DIR;
    else process.env.KLYRO_CONFIG_DIR = saved.prevCfg;
  }

  function listDebugFiles(dir: string): string[] {
    const outDir = path.join(dir, 'tool-output');
    if (!fs.existsSync(outDir)) return [];
    return fs.readdirSync(outDir).filter((f) => f.startsWith('mcp-') && f.endsWith('.json'));
  }

  it('writes the UNREDACTED payload (mode 0600) on success when enabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-mcp-debug-'));
    const saved = withDebugEnv(dir, '1');
    try {
      const fake = new FakeClient([{ name: 'leak' }], {
        handler: () => ({ text: `token is ${SECRET} done`, isError: false, raw: { secret: SECRET } }),
      });
      const registry = new ToolRegistry();
      const res = await registerMcpServers(
        { servers: { srv: spec({ allowTools: ['leak'] }) } },
        { registry, clientFactory: () => fake },
      );
      const out = await registry.execute('mcp__srv__leak', {}, ctx);
      expect(out.ok).toBe(true);
      if (out.ok) expect(String(out.value)).not.toContain(SECRET);
      const files = listDebugFiles(dir);
      expect(files).toHaveLength(1);
      const file = path.join(dir, 'tool-output', files[0]!);
      expect(file).toContain('mcp-srv-');
      const raw = fs.readFileSync(file, 'utf-8');
      expect(raw).toContain(SECRET); // unredacted on disk
      if (process.platform !== 'win32') {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
      await res.closeAll();
    } finally {
      restoreDebugEnv(saved);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures on tool error too (McpError keeps code, message redacted for the model)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-mcp-debug-'));
    const saved = withDebugEnv(dir, '1');
    try {
      const fake = new FakeClient([{ name: 'flaky' }], {
        callError: new McpError(`boom ${SECRET}`, 'TIMEOUT'),
      });
      const registry = new ToolRegistry();
      const resFlaky = await registerMcpServers(
        { servers: { srv: spec({ allowTools: ['flaky'] }) } },
        { registry, clientFactory: () => fake },
      );
      const out = await registry.execute('mcp__srv__flaky', {}, ctx);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe('TIMEOUT');
        expect(out.error.message).not.toContain(SECRET);
      }
      const files = listDebugFiles(dir);
      expect(files).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, 'tool-output', files[0]!), 'utf-8')).toContain(SECRET);
      await resFlaky.closeAll();
    } finally {
      restoreDebugEnv(saved);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing when the flag is off (default behaviour unchanged)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-mcp-debug-'));
    const saved = withDebugEnv(dir, undefined);
    try {
      const fake = new FakeClient([{ name: 't' }]);
      const registry = new ToolRegistry();
      const resOff = await registerMcpServers(
        { servers: { srv: spec({ allowTools: ['t'] }) } },
        { registry, clientFactory: () => fake },
      );
      await registry.execute('mcp__srv__t', {}, ctx);
      expect(listDebugFiles(dir)).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'tool-output'))).toBe(false);
      await resOff.closeAll();
    } finally {
      restoreDebugEnv(saved);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
  it('skips project servers declined by the callback', async () => {
    const dir = mkProjectDir({ proj1: projSpec });
    const registry = new ToolRegistry();
    const seen: string[] = [];
    const res = await loadAndRegisterMcp({
      cwd: dir,
      registry,
      clientFactory: (name) => {
        seen.push(name);
        return new FakeClient([{ name: 't' }]);
      },
      approveProjectServer: async () => false,
    });
    expect(seen).not.toContain('proj1');
    expect(res.registered).not.toContain('mcp__proj1__t');
    expect(res.errors).toContainEqual({ server: 'proj1', message: 'project server not approved (skipped)' });
    await res.closeAll();
  });
});
