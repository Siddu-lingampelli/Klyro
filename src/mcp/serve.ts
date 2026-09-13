/**
 * `klyro mcp serve` — expose the builtin tool registry as a minimal MCP
 * server over stdio (newline-delimited JSON-RPC 2.0).
 *
 * Supported methods: `initialize`, `ping`, `tools/list`, `tools/call`.
 * Every call is gated by the PolicyEngine (default config + builtin rules)
 * in headless mode: `allow` runs, `deny`/`ask` are refused as tool errors
 * (serve cannot prompt, so nothing privileged runs without an explicit
 * allow rule) — serving never bypasses policy.
 */
import * as readline from 'node:readline';
import { builtinRegistry, type ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import { PolicyEngine, builtinRules, DEFAULT_POLICY_CONFIG } from '../policy/engine.js';
import { readVersion } from '../version.js';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: unknown };
}

export interface ServeDeps {
  registry?: ToolRegistry;
  policy?: PolicyEngine;
  ctx?: ToolContext;
}

export function makeServeDeps(cwd: string, overrides: ServeDeps = {}): Required<ServeDeps> {
  return {
    registry: overrides.registry ?? builtinRegistry(),
    policy: overrides.policy ?? new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG),
    ctx: overrides.ctx ?? { cwd, env: process.env, nonInteractive: true },
  };
}

/** Pure request handler — unit-tested without stdio. Returns null for notifications. */
export async function handleMcpRequest(
  deps: Required<ServeDeps>,
  msg: JsonRpcRequest,
): Promise<Record<string, unknown> | null> {
  const id = msg.id ?? null;
  if (msg.method === undefined || typeof msg.method !== 'string') {
    if (id === null || id === undefined) return null;
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (id === null || id === undefined) return null; // notification — no response
  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'klyro', version: readVersion() },
      },
    };
  }
  if (msg.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (msg.method === 'tools/list') {
    const schemas = deps.registry.jsonSchemas();
    return {
      jsonrpc: '2.0', id,
      result: {
        tools: deps.registry.list().map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: schemas[t.name] ?? { type: 'object' },
        })),
      },
    };
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (typeof name !== 'string' || !deps.registry.get(name)) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(name)}` } };
    }
    const decision = await deps.policy.evaluate(
      { name, input: (args ?? {}) as Record<string, unknown>, permission: deps.registry.get(name)?.permission },
      { cwd: deps.ctx.cwd, nonInteractive: true },
    );
    if (decision.action !== 'allow') {
      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: `POLICY_DENIED: ${decision.action === 'deny' ? (decision as { reason?: string }).reason ?? 'denied' : 'approval required (non-interactive serve cannot prompt)'}` }],
          isError: true,
        },
      };
    }
    const res = await deps.registry.execute(name, args, deps.ctx);
    if (!res.ok) {
      const e = res.error as { code?: string; message?: string };
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${e.code ?? 'ERROR'}: ${e.message ?? ''}` }], isError: true } };
    }
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof res.value === 'string' ? res.value : JSON.stringify(res.value) }] } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
}

/** Stdio loop: one JSON-RPC message per line on stdin, responses on stdout. */
export async function serveStdio(cwd: string): Promise<number> {
  const deps = makeServeDeps(cwd);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      continue;
    }
    try {
      const res = await handleMcpRequest(deps, msg);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    } catch (err) {
      const id = (msg as JsonRpcRequest).id ?? null;
      if (id !== null && id !== undefined) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }) + '\n');
      }
    }
  }
  return 0;
}
