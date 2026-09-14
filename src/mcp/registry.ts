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
 * Permission class: the runtime passes each tool's `permission` into
 * `PolicyEngine.evaluate`, and `execute`/`admin` tools with no explicit
 * allow rule fall through to ask (interactive) or deny (headless). We
 * pick the most restrictive class, 'admin' — the same class as
 * `spawn_agent`, since MCP tools execute arbitrary external side effects
 * (read/write/network) outside our control.
 *
 * Debug capture: when `KLYRO_MCP_DEBUG=1` is set, every MCP tool success
 * AND error ALSO writes the UNREDACTED raw JSON payload (pre-redaction,
 * may contain secrets — handle accordingly) to
 * `<configDir>/tool-output/mcp-<server>-<ts>.json` (mode 0600) and notes
 * the path on stderr. `<configDir>` is `$KLYRO_CONFIG_DIR` when set,
 * otherwise `~/.klyro`. Default off: with the flag unset (or any value
 * other than `1`) no file is written and behaviour is unchanged.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpClient, McpError, type McpClientLike, type McpToolDef } from './client.js';
import { RemoteMcpClient } from './remote.js';
import { SseMcpClient } from './sse.js';
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
/** Success values are redacted FIRST, then truncated to this many chars. */
export const MCP_SUCCESS_MAX_CHARS = 12_000;

function sanitizePart(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * `mcp__<server>__<tool>`, sanitized, server part ≤20 chars, total ≤64.
 *
 * No `'server'`/`'tool'` fallbacks: an empty raw part (or one that
 * sanitizes to empty) yields an empty segment, and registration skips that
 * tool with an `empty-name` error instead of masking a misconfiguration
 * behind a plausible-looking name.
 */
export function sanitizeMcpName(server: string, tool: string): string {
  const srv = sanitizePart(server).slice(0, MAX_SERVER_PART);
  const maxTool = Math.max(1, MAX_NAME_LEN - 'mcp__'.length - srv.length - '__'.length);
  const tl = sanitizePart(tool).slice(0, maxTool);
  return `mcp__${srv}__${tl}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Recursively scrub credential-bearing keys (`authorization`, `cookie`,
 * `x-api-key`) from a debug payload so a server echoing credentials back in
 * an error body can't leak a live token into the capture file. Other values
 * pass through untouched.
 */
function scrubCredentialKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubCredentialKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.toLowerCase() === 'authorization' || k.toLowerCase() === 'cookie' || k.toLowerCase() === 'x-api-key') {
        out[k] = '[REDACTED]';
      } else {
        out[k] = scrubCredentialKeys(v);
      }
    }
    return out;
  }
  return value;
}

/** Debug-capture filename disambiguator when Date.now() collides. */
let mcpDebugCounter = 0;

/**
 * `KLYRO_MCP_DEBUG=1` capture: write the UNREDACTED raw payload to
 * `<configDir>/tool-output/mcp-<server>-<ts>.json` (mode 0600) + a stderr
 * note. Best-effort and synchronous — never throws into the tool path.
 */
function captureMcpDebug(server: string, tool: string, payload: unknown): void {
  if (process.env.KLYRO_MCP_DEBUG !== '1') return;
  try {
    const base = process.env.KLYRO_CONFIG_DIR ?? path.join(os.homedir() || process.cwd(), '.klyro');
    const dir = path.join(base, 'tool-output');
    fs.mkdirSync(dir, { recursive: true });
    const safe = server.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 32) || 'server';
    let file = path.join(dir, `mcp-${safe}-${Date.now()}.json`);
    if (fs.existsSync(file)) {
      mcpDebugCounter += 1;
      file = path.join(dir, `mcp-${safe}-${Date.now()}-${mcpDebugCounter}.json`);
    }
    fs.writeFileSync(file, JSON.stringify({ server, tool, payload: scrubCredentialKeys(payload) }, null, 2), { mode: 0o600 });
    try {
      process.stderr.write(`klyro: mcp debug captured ${server}/${tool} -> ${file}\n`);
    } catch {
      /* ignore */
    }
  } catch {
    /* best-effort only */
  }
}

async function executeMcpTool(
  server: string,
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
        captureMcpDebug(server, toolDef.name, { code: err.code, message: err.message, details: err.details });
        return { ok: false, error: { code: err.code, message: redact(err.message) } };
      }
      captureMcpDebug(server, toolDef.name, { message: errMessage(err) });
      return { ok: false, error: { code: 'TOOL_ERROR', message: redact(errMessage(err)) } };
    }
    // (4) Server-reported error → TOOL_ERROR, redacted, bounded.
    if (res.isError) {
      captureMcpDebug(server, toolDef.name, res.raw);
      return { ok: false, error: { code: 'TOOL_ERROR', message: redact(res.text).slice(0, 2000) } };
    }
    // (5) Success — redact BEFORE the value reaches the model/trace, then
    // truncate to a bounded size with a marker.
    captureMcpDebug(server, toolDef.name, res.raw);
    const redacted = redact(res.text);
    if (redacted.length > MCP_SUCCESS_MAX_CHARS) {
      return {
        ok: true,
        value:
          redacted.slice(0, MCP_SUCCESS_MAX_CHARS) +
          `\n... [truncated ${redacted.length - MCP_SUCCESS_MAX_CHARS} chars]`,
      };
    }
    return { ok: true, value: redacted };
  } catch (err) {
    // Tool contract: never throw — always return a ToolResult.
    return { ok: false, error: { code: 'TOOL_ERROR', message: redact(errMessage(err)) } };
  }
}

/**
 * Construct the right client for a spec: remote HTTP when `url` is set
 * (`transport: 'sse'` selects the legacy event-stream flavor, default is
 * Streamable HTTP), else stdio. Used by registration, probe, and prompts.
 */
export function makeMcpClient(name: string, spec: McpServerSpec): McpClientLike {
  if (spec.url) return spec.transport === 'sse' ? new SseMcpClient(name, spec) : new RemoteMcpClient(name, spec);
  if (!spec.command) throw new McpError(`mcp server "${name}" has neither command nor url`, 'INVALID_SPEC');
  return new McpClient(name, spec);
}

export async function registerMcpServers(
  cfg: { servers: Record<string, McpServerSpec> },
  opts: RegisterMcpOpts,
): Promise<McpRegisterResult> {
  const { registry, policy } = opts;
  const factory = opts.clientFactory ?? makeMcpClient;
  const registered: string[] = [];
  const errors: { server: string; message: string }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const clients: McpClientLike[] = [];
  // Sanitized name → first raw (server, tool) that claimed it, used to tell
  // sanitization-collisions apart from exact-duplicates (see below).
  const claimed = new Map<string, { server: string; tool: string }>();

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
        // Empty raw names (or names that sanitize to empty) are a
        // misconfiguration — skip as an error, never with a fallback name.
        if (!server || !toolDef.name || sanitizePart(server) === '' || sanitizePart(toolDef.name) === '') {
          errors.push({ server, message: `empty-name: server "${server}" tool "${toolDef.name}" sanitizes to an empty name part (skipped)` });
          continue;
        }
        const name = sanitizeMcpName(server, toolDef.name);
        const prior = claimed.get(name);
        if (prior) {
          if (prior.server === server && prior.tool === toolDef.name) {
            skipped.push({ name, reason: 'name-collision' });
            continue;
          }
          // Sanitization-collision: two DIFFERENT raw names map to the same
          // sanitized name. This is an error (not a silent skip) and names
          // both raw identities so the conflict is actionable.
          errors.push({
            server,
            message: `name collision: "${prior.server}/${prior.tool}" and "${server}/${toolDef.name}" both sanitize to "${name}" (skipped)`,
          });
          continue;
        }
        if (registry.get(name)) {
          // Exact-duplicate: the literal name already exists (e.g. a
          // builtin) — skip quietly, first registration wins.
          skipped.push({ name, reason: 'name-collision' });
          continue;
        }
        claimed.set(name, { server, tool: toolDef.name });
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
            executeMcpTool(server, boundSpec, boundDef, boundClient, input, ctx),
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

export async function loadAndRegisterMcp(opts: {  cwd: string;
  registry: ToolRegistry;
  policy?: PolicyEngine;
  clientFactory?: (name: string, spec: McpServerSpec) => McpClientLike;
  /**
   * Consent gate for project-sourced (`.mcp.json`) servers, which can
   * auto-spawn processes. Global-source servers connect as before; a project
   * server connects ONLY when this callback returns true. When the callback
   * is ABSENT, project servers are never auto-connected — each surfaces as
   * an error (`project server requires approval (skipped)`) so the skip is
   * visible. Callers may compose this with `McpTrust` (see `./trust.js`) to
   * remember approvals per spec hash.
   */
  approveProjectServer?: (info: { name: string; source: 'global' | 'project' }) => Promise<boolean>;
}): Promise<McpRegisterResult> {
  try {
    const cfg = loadMcpServers(opts.cwd);
    const filtered: Record<string, McpServerSpec> = {};
    const gateErrors: { server: string; message: string }[] = [];
    for (const [name, spec] of Object.entries(cfg.servers)) {
      if (cfg.sources[name] !== 'project') {
        filtered[name] = spec;
        continue;
      }
      if (!opts.approveProjectServer) {
        gateErrors.push({ server: name, message: 'project server requires approval (skipped)' });
        continue;
      }
      let ok = false;
      try {
        ok = await opts.approveProjectServer({ name, source: 'project' });
      } catch (err) {
        gateErrors.push({ server: name, message: `project server approval error (skipped): ${errMessage(err)}` });
        continue;
      }
      if (!ok) {
        gateErrors.push({ server: name, message: 'project server not approved (skipped)' });
        continue;
      }
      filtered[name] = spec;
    }
    const res = await registerMcpServers({ servers: filtered }, opts);
    res.errors.unshift(...gateErrors);
    return res;
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

/**
 * Run one MCP prompt (`/mcp__<server>__<prompt>`) on demand: fresh
 * connection per invocation (no client lifecycle to manage), redacted
 * output. Project servers need trust-store approval (see `klyro mcp
 * trust`) — typing the prompt name is intent, not approval. Throws
 * McpError / Error on unknown server, disabled server, or prompt failure.
 */
export async function runMcpPrompt(
  cwd: string,
  server: string,
  prompt: string,
  tokens: string[],
  opts: {
    trust?: { isTrusted: (name: string, hash: string) => boolean };
    clientFactory?: (name: string, spec: McpServerSpec) => McpClientLike;
  } = {},
): Promise<string> {
  const cfg = loadMcpServers(cwd);
  const spec = cfg.servers[server];
  if (!spec) throw new Error(`mcp server not found: ${server}`);
  if (spec.disabled) throw new Error(`mcp server disabled: ${server}`);
  // Consent parity with the tool path: project-sourced servers require a
  // trust-store approval (see `klyro mcp trust`). Typing the prompt name
  // is intent, not approval — auto-spawning a project subprocess stays gated.
  if (cfg.sources[server] === 'project') {
    const { McpTrust, hashSpec } = await import('./trust.js');
    const trust = opts.trust ?? new McpTrust();
    if (!trust.isTrusted(server, hashSpec(spec))) {
      throw new Error(`mcp server "${server}" is not trusted — run: klyro mcp trust ${server}`);
    }
  }
  const client = (opts.clientFactory ?? makeMcpClient)(server, spec);
  if (!client.promptsGet) throw new Error(`mcp server "${server}" does not support prompts`);
  const withConnect = client as Partial<{ connect: () => Promise<void> }>;
  if (typeof withConnect.connect === 'function') await withConnect.connect();
  // Typed args: `key=value` tokens bind by name; bare tokens fill the
  // prompt's declared argument names in order; leftovers join into `input`.
  // Servers without declared arguments keep the legacy arg1..N + input form.
  let mapped: Record<string, string>;
  try {
    const defs = typeof client.promptsList === 'function' ? await client.promptsList() : [];
    const def = defs.find((d) => d.name === prompt);
    const declared = def?.arguments?.map((a) => a.name) ?? [];
    // Split tokens once: key=value binds by name, bare tokens are positional.
    mapped = {};
    const positional: string[] = [];
    for (const tok of tokens) {
      const eq = tok.indexOf('=');
      if (eq > 0) mapped[tok.slice(0, eq)] = tok.slice(eq + 1);
      else positional.push(tok);
    }
    if (declared.length > 0) {
      // Named bindings win; bare tokens fill the remaining declared slots
      // in order; anything left over joins into `input`.
      const free = declared.filter((d) => !(d in mapped));
      positional.forEach((v, i) => {
        if (i < free.length) mapped[free[i]!] = v;
      });
      const extras = positional.slice(free.length);
      if (extras.length > 0) mapped['input'] = extras.join(' ');
    } else {
      positional.forEach((v, i) => { mapped[`arg${i + 1}`] = v; });
      mapped['input'] = positional.join(' ');
    }
  } catch {
    // prompts/list failed — fall back to legacy positional mapping.
    mapped = {};
    tokens.forEach((v, i) => { mapped[`arg${i + 1}`] = v; });
    mapped['input'] = tokens.join(' ');
  }
  try {
    const text = await client.promptsGet(prompt, mapped);
    return redact(text).slice(0, 8000);
  } finally {
    await client.close().catch(() => undefined);
  }
}
