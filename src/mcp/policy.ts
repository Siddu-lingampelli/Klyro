/**
 * P1 — per-server MCP tool policy (r-11-17.md: "deny by default").
 *
 * A server without an explicit `allowTools` list cannot execute anything:
 * the registration layer refuses the call before any subprocess I/O. An
 * explicit `denyTools` entry always wins over `allowTools`.
 */
import type { McpServerPolicy } from './config.js';

export interface McpPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export function evaluateMcpPolicy(
  policy: McpServerPolicy | undefined,
  toolName: string,
): McpPolicyDecision {
  if (!policy || !policy.allowTools || policy.allowTools.length === 0) {
    return { allowed: false, reason: 'mcp tool denied: server has no allowTools allowlist' };
  }
  if (policy.denyTools?.includes(toolName)) {
    return { allowed: false, reason: `mcp tool denied by server denyTools: ${toolName}` };
  }
  if (!policy.allowTools.includes(toolName)) {
    return { allowed: false, reason: `mcp tool not in server allowTools: ${toolName}` };
  }
  return { allowed: true };
}
