/**
 * Agent capability enforcement (P0.2 from r-6-10.fix.md).
 *
 * Resolves the **effective tool set** for a (child) agent by intersecting:
 *
 *   1. the parent's effective tools — a child can never receive more tools than its parent
 *   2. the agent definition's `allowedTools` (if specified)
 *   3. the runtime policy's allowed tools (e.g. `--allow-write` flags)
 *
 * Then applies safety modifiers:
 *
 *   - `readonly: true` strips every tool classified as write or mutation.
 *   - `canSpawn: false` (default for children) removes any spawn_agent-like tools.
 *   - A deny-list always wins, regardless of what the agent declares.
 *
 * This is a pure function — no I/O, no side effects. It exists so the runtime
 * can decide which tools to expose to the model BEFORE the model picks one.
 *
 * Wiring lives in src/agent/runtime.ts (see the tool-filter hook).
 */

export interface AgentCapabilities {
  /** Tools the agent definition explicitly allows. `undefined` means "no allow-list". */
  allowedTools?: string[];
  /** If true, write/mutation tools are stripped. */
  readonly?: boolean;
  /** If false (or unset), tools that can spawn new agents are stripped. */
  canSpawn?: boolean;
  /** Model override — if the provider cannot satisfy it, callers must error rather than fall back. */
  model?: string;
  /** Recursion depth cap. Beyond this, spawn attempts are blocked. */
  maxDepth?: number;
  /**
   * Path allow-list for filesystem scope. `undefined` means unconstrained.
   * A child's effective list is the intersection with its parent's.
   */
  allowedPaths?: string[];
}

export interface ResolveToolsInput {
  /** Tools the parent is allowed to use (or `null` for the root agent = all registered tools). */
  parentTools: ReadonlySet<string> | null;
  /** The agent's declared capability profile. */
  agent: AgentCapabilities;
  /** Tools currently allowed by runtime policy (e.g. user-permission flags). */
  policyAllowed: ReadonlySet<string>;
  /** All tools known to the registry (used when parentTools is null). */
  registryTools: ReadonlySet<string>;
  /** Tools that mutate state — stripped under `readonly`. */
  writeTools: ReadonlySet<string>;
  /** Tools that spawn other agents — stripped when `canSpawn` is false. */
  spawnTools: ReadonlySet<string>;
  /** Tools that are NEVER allowed, even if explicitly requested. */
  denied: ReadonlySet<string>;
  /** If true, spawn tools are kept even when agent.canSpawn is false/unset. */
  canSpawnOverride?: boolean;
}

export interface ResolveToolsResult {
  /** Tools the child agent is permitted to call. */
  allowed: string[];
  /** Tools that were denied (debugging/observability). */
  dropped: { tool: string; reason: 'denied' | 'readonly' | 'no-spawn' | 'not-in-parent' | 'not-in-policy' | 'unknown' }[];
}

/**
 * Resolve the effective tool set for an agent.
 *
 * Order of operations:
 *   1. Start from `parentTools ?? registryTools`.
 *   2. Intersect with `policyAllowed`.
 *   3. If `allowedTools` is set, intersect again.
 *   4. Strip `writeTools` if `readonly`.
 *   5. Strip `spawnTools` if `!canSpawn`.
 *   6. Remove `denied` last (always wins).
 */
export function resolveAgentTools(input: ResolveToolsInput): ResolveToolsResult {
  const {
    parentTools,
    agent,
    policyAllowed,
    registryTools,
    writeTools,
    spawnTools,
    denied,
  } = input;

  const allowed = new Set<string>();
  const dropped: ResolveToolsResult['dropped'] = [];

  // 1. Baseline: parent's tools, or all registered tools for the root agent.
  // Record narrowing for observability: registry tools outside the parent's
  // set are reported as 'not-in-parent' drops (child can never exceed parent).
  const baseline = parentTools ?? registryTools;
  if (parentTools !== null) {
    for (const name of registryTools) {
      if (!parentTools.has(name)) {
        dropped.push({ tool: name, reason: 'not-in-parent' });
      }
    }
  }
  for (const name of baseline) {
    if (!registryTools.has(name)) {
      dropped.push({ tool: name, reason: 'unknown' });
      continue;
    }
    if (!policyAllowed.has(name)) {
      dropped.push({ tool: name, reason: 'not-in-policy' });
      continue;
    }
    allowed.add(name);
  }

  // 3. Apply the agent's allow-list (if any). Anything not in the list is dropped.
  if (agent.allowedTools) {
    const explicit = new Set(agent.allowedTools);
    for (const name of [...allowed]) {
      if (!explicit.has(name)) {
        allowed.delete(name);
        dropped.push({ tool: name, reason: 'not-in-parent' });
      }
    }
    // Tools requested in allowedTools but not in the baseline cannot be granted.
    for (const name of agent.allowedTools) {
      if (!allowed.has(name) && registryTools.has(name) && policyAllowed.has(name)) {
        dropped.push({ tool: name, reason: 'not-in-parent' });
      }
    }
  }

  // 4. readonly → strip write tools (plus run_verify: verification can
  // execute arbitrary commands, so it is not read-only).
  if (agent.readonly) {
    for (const name of [...allowed]) {
      if (writeTools.has(name) || name === 'run_verify') {
        allowed.delete(name);
        dropped.push({ tool: name, reason: 'readonly' });
      }
    }
  }

  // 5. canSpawn=false → strip spawn tools. Default: root agent (parentTools
  // === null) may spawn; children strip unless explicitly enabled. An explicit
  // canSpawnOverride=true (via resolveCapabilities) also keeps them.
  const canSpawnEffective = input.canSpawnOverride ?? input.agent.canSpawn ?? (input.parentTools === null);
  if (!canSpawnEffective) {
    for (const name of [...allowed]) {
      if (spawnTools.has(name)) {
        allowed.delete(name);
        dropped.push({ tool: name, reason: 'no-spawn' });
      }
    }
  }

  // 6. Deny-list always wins.
  for (const name of [...allowed]) {
    if (denied.has(name)) {
      allowed.delete(name);
      dropped.push({ tool: name, reason: 'denied' });
    }
  }

  return {
    allowed: [...allowed].sort(),
    dropped: dropped.sort((a, b) => a.tool.localeCompare(b.tool)),
  };
}

/**
 * Reason a tool was dropped from the resolved capability set. Mirrors
 * `ResolveToolsResult.dropped[].reason`.
 */
export type DropReason = 'denied' | 'readonly' | 'no-spawn' | 'not-in-parent' | 'not-in-policy' | 'unknown';

/**
 * Fully-resolved capability profile for a child agent — tool set plus
 * non-tool knobs (model override, recursion cap). Computed once at spawn
 * time and threaded through the runtime as `parentContext`.
 */
export interface ResolvedCapabilities {
  /** Sorted tool names the child is allowed to invoke. */
  allowed: ReadonlySet<string>;
  /** Per-tool drop reasons — surfaced in ChildSummary for parent visibility. */
  dropped: { tool: string; reason: DropReason }[];
  /** Model override to send to the provider (or undefined to inherit parent). */
  model?: string;
  /** Effective recursion depth cap. Caller MUST reject spawn when depth + 1 > maxDepth. */
  maxDepth: number;
  readonly: boolean;
  canSpawn: boolean;
  /**
   * Effective filesystem scope: parent's `allowedPaths` intersected with the
   * agent's own. `undefined` means unconstrained (neither side restricts).
   */
  allowedPaths?: string[];
}

/** Extra knobs consumed by `resolveCapabilities` on top of `ResolveToolsInput`. */
export interface ResolveCapabilitiesExtra {
  /** Caller-provided maxDepth (e.g. from CLI `--max-depth` or a parent's maxDepth). Required. */
  maxDepth: number;
  /** If true, the resolved `allowed` set may include tools that themselves spawn agents. */
  canSpawnOverride?: boolean;
  /**
   * The parent's filesystem allow-list (`undefined` = unconstrained parent —
   * the agent's own list, if any, applies as-is).
   */
  parentAllowedPaths?: string[];
}

/** Combined input for the one-shot resolver used by the orchestrator. */
export interface ResolveCapabilitiesInput extends ResolveToolsInput, ResolveCapabilitiesExtra {}

/**
 * Intersect two filesystem allow-lists. `undefined` on either side means
 * "unconstrained" — the other side applies as-is; both `undefined` stays
 * `undefined`. Entries survive when they are equal to, or nested inside, an
 * entry of the other list (so a parent `/repo` and a child `/repo/sub`
 * intersect to `/repo/sub`). Comparison is case-insensitive on Windows.
 */
export function intersectAllowedPaths(
  parentPaths?: string[],
  agentPaths?: string[],
): string[] | undefined {
  if (parentPaths === undefined) return agentPaths;
  if (agentPaths === undefined) return [...parentPaths];
  const out: string[] = [];
  const seen = new Set<string>();
  const within = (candidate: string, scope: string): boolean => {
    const norm = (p: string): string => {
      const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
      return process.platform === 'win32' ? n.toLowerCase() : n;
    };
    const c = norm(candidate);
    const s = norm(scope);
    return c === s || c.startsWith(s + '/');
  };
  for (const a of agentPaths) {
    for (const p of parentPaths) {
      // The overlap of two nested scopes is the narrower one.
      const narrower = within(a, p) ? a : within(p, a) ? p : undefined;
      if (narrower !== undefined) {
        const key = process.platform === 'win32' ? narrower.toLowerCase() : narrower;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(narrower);
        }
      }
    }
  }
  return out.sort();
}

/**
 * One-shot capability resolver: tool intersection + per-agent model/maxDepth.
 *
 * `maxDepth` precedence (most specific wins):
 *   1. `agent.maxDepth` (if set on the definition)
 *   2. `extra.maxDepth` (parent / CLI cap)
 * `model` is propagated only when the agent declares one; we do not silently
 * override a parent's chosen model.
 */
export function resolveCapabilities(input: ResolveCapabilitiesInput): ResolvedCapabilities {
  const resolved = resolveAgentTools(input);
  const allowed = new Set(resolved.allowed);
  const model = input.agent.model;
  const maxDepth = input.agent.maxDepth ?? input.maxDepth;
  // Default matches resolveAgentTools: the root agent (parentTools === null)
  // may spawn; children strip spawn tools unless explicitly enabled.
  const canSpawn = input.canSpawnOverride ?? input.agent.canSpawn ?? (input.parentTools === null);
  const allowedPaths = intersectAllowedPaths(input.parentAllowedPaths, input.agent.allowedPaths);
  return {
    allowed,
    dropped: resolved.dropped,
    ...(model !== undefined ? { model } : {}),
    maxDepth,
    readonly: input.agent.readonly ?? false,
    canSpawn,
    ...(allowedPaths !== undefined ? { allowedPaths } : {}),
  };
}

/** Sensible defaults for "what counts as a write tool" if a caller doesn't override. */
export const DEFAULT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'shell_exec',
  'memory_write',
  'todo_write',
]);

/** Default spawn tools — removed from children by default. */
export const DEFAULT_SPAWN_TOOLS: ReadonlySet<string> = new Set([
  'spawn_agent',
]);

/** Default deny-list — these are NEVER allowed, even if explicitly requested. */
export const DEFAULT_DENIED_TOOLS: ReadonlySet<string> = new Set([
  // Add dangerous tools here. Empty by default — extend as policy matures.
]);
