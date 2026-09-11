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

export const McpServerPolicySchema = z.object({
  allowTools: z.array(z.string()).optional(),
  denyTools: z.array(z.string()).optional(),
  requireApproval: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export type McpServerPolicy = z.infer<typeof McpServerPolicySchema>;

export const McpServerSpecSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
  policy: McpServerPolicySchema.optional(),
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
