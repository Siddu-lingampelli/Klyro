/**
 * P1 — MCP server configuration (r-11-17.md §3.1).
 *
 * Mirrors Claude Code's project-level `.mcp.json` (`{mcpServers: {...}}`) for
 * drop-in compatibility, and also tolerates the legacy Klyro shape
 * (`{servers: {...}}` shown by `/mcp`). Global defaults live in
 * `~/.klyro/mcp.json`; project config wins per-server.
 *
 * `${env:VAR}` references in `env` values expand from `process.env`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

/** MCP remote URL guard — https:// (or loopback http://) only. */
export function assertSafeMcpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid MCP server url: ${url}`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:') {
    const h = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '::' || h.startsWith('127.')) return;
    throw new Error(`insecure MCP server url (plain HTTP) for host ${parsed.hostname} — use https:// or a loopback URL, or set KLYRO_ALLOW_INSECURE_MCP=1`);
  }
  throw new Error(`unsupported MCP server url protocol: ${parsed.protocol}`);
}

/** True when the plain-HTTP MCP opt-in is set (env or persisted equivalent). */
export function insecureMcpAllowed(): boolean {
  return process.env.KLYRO_ALLOW_INSECURE_MCP === '1';
}

export const McpServerPolicySchema = z.object({
  allowTools: z.array(z.string()).optional(),
  denyTools: z.array(z.string()).optional(),
  requireApproval: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

/**
 * B2 — optional OAuth/PKCE auth surface for remote (`url`) transports.
 * Present ⇒ the probe/connect path resolves a bearer token and attaches
 * `Authorization`; the debug capture scrubs it (see `scrubAuthHeaders`).
 */
export const McpServerAuthSchema = z.object({
  /** OAuth 2.0 client id registered with the authorization server. */
  clientId: z.string().min(1),
  /** Token endpoint; when absent, derived from the authorization issuer. */
  tokenEndpoint: z.string().url().optional(),
  /** Authorization endpoint / metadata issuer; defaults to the server URL. */
  authorizationEndpoint: z.string().url().optional(),
  /** Custom redirect URI; defaults to a loopback listener on 127.0.0.1. */
  redirectUri: z.string().url().optional(),
  /** Space-separated additional scopes. */
  scopes: z.string().optional(),
});

export type McpServerAuth = z.infer<typeof McpServerAuthSchema>;

export type McpServerPolicy = z.infer<typeof McpServerPolicySchema>;

export const McpServerSpecSchema = z.object({
  /** stdio transport: command to spawn. Required unless `url` is set. */
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Remote transport: Streamable-HTTP JSON-RPC endpoint. Required unless `command` is set. */
  url: z.string().url().optional(),
  /**
   * Remote transport flavor: `streamable` (default, POST per message) or
   * `sse` (legacy HTTP+SSE: persistent GET event stream + message POST).
   */
  transport: z.enum(['streamable', 'sse']).optional(),
  /** Extra HTTP headers for remote transport (`${env:VAR}` expanded). */
  headers: z.record(z.string(), z.string()).optional(),
  /** B2 — optional OAuth/PKCE auth surface; only valid on remote transports. */
  auth: McpServerAuthSchema.optional(),
  disabled: z.boolean().optional(),
  policy: McpServerPolicySchema.optional(),
}).superRefine((s, ctx) => {
  if (s.auth && !s.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP server "auth" requires a remote "url" transport (stdio has no OAuth surface)' });
  }
  if (!s.command && !s.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP server needs either "command" (stdio) or "url" (remote HTTP)' });
  }
  if (s.command && s.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP server takes either "command" or "url", not both' });
  }
  if (s.url && !s.command) {
    const u = s.url as string;
    let parsed: URL | null = null;
    try {
      parsed = new URL(u);
    } catch { /* invalid URL caught by z.string().url() */ }
    if (parsed && parsed.protocol === 'http:') {
      const h = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      const loopback = h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '::' || h.startsWith('127.');
      if (!loopback && process.env.KLYRO_ALLOW_INSECURE_MCP !== '1') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `insecure MCP server url (plain HTTP) for host ${parsed.hostname} — use https:// or a loopback URL, or set KLYRO_ALLOW_INSECURE_MCP=1` });
      }
    }
  }
});

export type McpServerSpec = z.infer<typeof McpServerSpecSchema>;

export interface McpServersConfig {
  servers: Record<string, McpServerSpec>;
  /** Where each server entry came from (for doctor/diagnostics). */
  sources: Record<string, string>;
}

/** Upper bound for per-server timeouts — larger values are clamped, not rejected. */
export const MAX_MCP_TIMEOUT_MS = 600_000;

/**
 * Expand `${env:VAR}` references from `process.env`.
 *
 * A reference to an UNSET or empty variable expands to `''` (silent empty
 * expansion): the entry is kept with the empty value rather than rejected,
 * so callers always see the effective spec. Pure — exported for unit tests.
 */
export function expandEnv(value: string): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? '');
}

function normalizeRaw(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const servers = obj['mcpServers'] ?? obj['servers'] ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
  return servers as Record<string, unknown>;
}

function readJsonFile(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Load + merge global and project MCP server specs. Invalid entries are skipped. */
export function loadMcpServers(cwd: string): McpServersConfig {
  const home = os.homedir() || process.cwd();
  const globalPath = path.join(home, '.klyro', 'mcp.json');
  const projectPath = path.join(cwd, '.mcp.json');
  const servers: Record<string, McpServerSpec> = {};
  const sources: Record<string, string> = {};

  for (const [filePath, label] of [[globalPath, 'global'], [projectPath, 'project']] as const) {
    const raw = normalizeRaw(readJsonFile(filePath));
    for (const [name, specRaw] of Object.entries(raw)) {
      // Empty server names can never produce a valid tool name — skip
      // silently (shape stays `{servers, sources}`; registry reports
      // empty TOOL names as errors at registration time).
      if (name === '') continue;
      const parsed = McpServerSpecSchema.safeParse(specRaw);
      if (!parsed.success) continue;
      const spec = parsed.data;
      if (spec.policy?.timeoutMs !== undefined && spec.policy.timeoutMs > MAX_MCP_TIMEOUT_MS) {
        spec.policy.timeoutMs = MAX_MCP_TIMEOUT_MS;
      }
      if (spec.env) {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(spec.env)) env[k] = expandEnv(v);
        spec.env = env;
      }
      if (spec.headers) {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(spec.headers)) headers[k] = expandEnv(v);
        spec.headers = headers;
      }
      servers[name] = spec;
      sources[name] = label;
    }
  }
  return { servers, sources };
}

/** Servers eligible for connection (configured and not disabled). */
export function enabledServers(cfg: McpServersConfig): Record<string, McpServerSpec> {
  const out: Record<string, McpServerSpec> = {};
  for (const [name, spec] of Object.entries(cfg.servers)) {
    if (!spec.disabled) out[name] = spec;
  }
  return out;
}

/** Server names are bounded: the registry builds `mcp__<server>__<tool>` (≤64 chars). */
export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,20}$/;

export function projectMcpPath(cwd: string): string {
  return path.join(cwd, '.mcp.json');
}

function readProjectDoc(cwd: string): { doc: Record<string, unknown>; servers: Record<string, unknown> } {
  const raw = readJsonFile(projectMcpPath(cwd));
  const doc = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const servers = normalizeRaw(doc);
  return { doc, servers: { ...servers } };
}

function writeProjectDoc(cwd: string, doc: Record<string, unknown>, servers: Record<string, unknown>): void {
  const next: Record<string, unknown> = { ...doc };
  if ('mcpServers' in next) next['mcpServers'] = servers;
  else next['servers'] = servers;
  if (Object.keys(next).length === 0) next['mcpServers'] = servers;
  const tmp = `${projectMcpPath(cwd)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, projectMcpPath(cwd));
}

/** Add (or reject duplicates of) a project-level MCP server. Throws on invalid input. */
export function addProjectServer(cwd: string, name: string, spec: unknown): void {
  if (!MCP_NAME_RE.test(name)) throw new Error(`invalid server name "${name}" (want 1-20 chars of A-Za-z0-9_-)`);
  const parsed = McpServerSpecSchema.safeParse(spec);
  if (!parsed.success) throw new Error(`invalid server spec: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  const { doc, servers } = readProjectDoc(cwd);
  if (name in servers) throw new Error(`server "${name}" already configured in ${projectMcpPath(cwd)} (remove it first)`);
  servers[name] = parsed.data;
  writeProjectDoc(cwd, doc, servers);
}

/** Remove a project-level MCP server. Returns false when absent. */
export function removeProjectServer(cwd: string, name: string): boolean {
  const { doc, servers } = readProjectDoc(cwd);
  if (!(name in servers)) return false;
  delete servers[name];
  writeProjectDoc(cwd, doc, servers);
  return true;
}
