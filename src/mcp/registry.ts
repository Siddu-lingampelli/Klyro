/**
 * P1 — MCP tool registration (r-11-17.md §3.1).
 *
 * Exposes MCP server tools through the {@link ToolRegistry} under
 * `mcp__<server>__<tool>` names. Security properties (non-negotiable):
 *
 *   1. Deny-by-default: `evaluateMcpPolicy` runs BEFORE any client I/O; a
 *      denied tool returns POLICY_DENIED without touching the subprocess.
 *   2. Redact-before-transcript: every success value AND error message passes
 *      through `redact()` before it can reach the model or trace.
 *   3. `requireApproval` servers add an ask-rule to the PolicyEngine so the
 *      runtime loop prompts before executing.
 *
 * Permission class: no code in src consumes `Tool.permission` (it is
 * write-only metadata today), so we pick the most restrictive class,
 * 'admin' — the same class as `spawn_agent`, since MCP tools execute
 * arbitrary external side effects (read/write/network) outside our control.
 */
import { McpClient, McpError, type McpClientLike, type McpToolDef } from './client.js';
import { loadMcpServers, type McpServerSpec } from './config.js';
import { evaluateMcpPolicy } from './policy.js';
import { jsonSchemaToZod } from './schema.js';
import { redact } from '../policy/secret-redactor.js';
import type { PolicyEngine } from '../policy/engine.js';
import { defineTool, type ToolContext, type ToolResult } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface McpRegisterResult {
  registered: string[];
  errors: { server: string; message: string }[];
  skipped: { name: string; reason: string }[];
  closeAll: () => Promise<void>;
}

export interface RegisterMcpOpts {
  registry: ToolRegistry;
  policy?: PolicyEngine;
  clientFactory?: (name: string, spec: McpServerSpec) => McpClientLike;
}

/** Hard cap so generated names always fit model/tool-name limits. */
const MAX_NAME_LEN = 64;
/** Server part is capped here; the tool part takes whatever remains. */
const MAX_SERVER_PART = 20;

function sanitizePart(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

/** `mcp__<server>__<tool>`, sanitized, server part ≤20 chars, total ≤64. */
export function sanitizeMcpName(server: string, tool: string): string {
  const srv = sanitizePart(server).slice(0, MAX_SERVER_PART) || 'server';
  const maxTool = Math.max(1, MAX_NAME_LEN - 'mcp__'.length - srv.length - '__'.length);
  const tl = sanitizePart(tool).slice(0, maxTool) || 'tool';
  return `mcp__${srv}__${tl}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function executeMcpTool(
  spec: McpServerSpec,
  toolDef: McpToolDef,
  client: McpClientLike,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult<unknown>> {
  try {
    // (1) Deny-by-default — runs BEFORE any client I/O.
    const decision = evaluateMcpPolicy(spec.policy, toolDef.name);
    if (!decision.allowed) {
      return {
        ok: false,
        error: { code: 'POLICY_DENIED', message: decision.reason ?? `mcp tool denied: ${toolDef.name}` },
      };
    }
    // (2) Delegate to the server, honouring abort.
    let res;
    try {
      res = await client.callTool(toolDef.name, input, ctx.signal);
    } catch (err) {
      // (3) Typed server failures keep their code; everything else is TOOL_ERROR.
      // Redact BEFORE the message can reach the model/trace.
      if (err instanceof McpError) {
        return { ok: false, error: { code: err.code, message: redact(err.message) } };
      }
      return { ok: false, error: { code: 'TOOL_ERROR', message: redact(errMessage(err)) } };
    }
    // (4) Server-reported error → TOOL_ERROR, redacted, bounded.
    if (res.isError) {
      return { ok: false, error: { code: 'TOOL_ERROR', message: redact(res.text).slice(0, 2000) } };
    }
    // (5) Success — redact BEFORE the value reaches the model/trace.
    return { ok: true, value: redact(res.text) };
  } catch (err) {
    // Tool contract: never throw — always return a ToolResult.
    return { ok: false, error: { code: 'TOOL_ERROR', message: redact(errMessage(err)) } };
  }
}

export async function registerMcpServers(
  cfg: { servers: Record<string, McpServerSpec> },
  opts: RegisterMcpOpts,
): Promise<McpRegisterResult> {
  const { registry, policy } = opts;
  const factory = opts.clientFactory ?? ((name: string, spec: McpServerSpec) => new McpClient(name, spec));
  const registered: string[] = [];
  const errors: { server: string; message: string }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const clients: McpClientLike[] = [];

  for (const [server, spec] of Object.entries(cfg.servers)) {
    try {
      // enabledServers-style: skip disabled entries silently.
      if (spec.disabled) continue;

      // Default factory returns a bare McpClient — connect it here so fake
      // McpClientLike factories (no connect method) also work.
      let client: McpClientLike;
      try {
        client = await factory(server, spec);
        const withConnect = client as Partial<{ connect: () => Promise<void> }>;
        if (typeof withConnect.connect === 'function') {
          await withConnect.connect();
        }
      } catch (err) {
        errors.push({ server, message: errMessage(err) });
        continue; // never throw — keep registering other servers
      }

      let tools: McpToolDef[];
      try {
        tools = await client.listTools();
      } catch (err) {
        errors.push({ server, message: errMessage(err) });
        try {
          await client.close();
        } catch {
          /* best-effort */
        }
        continue;
      }
      clients.push(client);

      for (const toolDef of tools) {
        const name = sanitizeMcpName(server, toolDef.name);
        if (registry.get(name)) {
          skipped.push({ name, reason: 'name-collision' });
          continue;
        }
        // Capture per-tool bindings for the closure.
        const boundSpec = spec;
        const boundDef = toolDef;
        const boundClient = client;
        const tool = defineTool<unknown, unknown>({
          name,
          description: `[mcp:${server}] ${boundDef.description ?? boundDef.name}`,
          inputSchema: jsonSchemaToZod(boundDef.inputSchema ?? { type: 'object' }),
          // 'admin': most restrictive class — MCP tools run arbitrary
          // external side effects; nothing in src reads this field yet.
          permission: 'admin',
          execute: (input: unknown, ctx: ToolContext) =>
            executeMcpTool(boundSpec, boundDef, boundClient, input, ctx),
        });
        registry.register(tool);
        registered.push(name);
        if (boundSpec.policy?.requireApproval && policy) {
          policy.addAsk(name);
        }
      }
    } catch (err) {
      // Belt-and-braces: registerMcpServers never throws.
      errors.push({ server, message: errMessage(err) });
    }
  }

  return {
    registered,
    errors,
    skipped,
    closeAll: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

export async function loadAndRegisterMcp(opts: {
  cwd: string;
  registry: ToolRegistry;
  policy?: PolicyEngine;
  clientFactory?: (name: string, spec: McpServerSpec) => McpClientLike;
}): Promise<McpRegisterResult> {
  try {
    const cfg = loadMcpServers(opts.cwd);
    return await registerMcpServers(cfg, opts);
  } catch (err) {
    // Never throws — surface load failures as error entries.
    return {
      registered: [],
      errors: [{ server: '*', message: errMessage(err) }],
      skipped: [],
      closeAll: async () => {},
    };
  }
}
