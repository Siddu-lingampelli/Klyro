/**
 * Tool surface — the contract between the agent and the outside world.
 *
 * Every action the agent can take on a repo is a Tool. Tools:
 *   1. Validate input via Zod
 *   2. Produce a JSON Schema for the model
 *   3. Execute deterministically (modulo shell)
 *   4. Normalize errors into { code, message, details? }
 */

import type { z } from 'zod';

/** Standard tool result — either a typed value or a structured error. */
export type ToolResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/**
 * Context handed to every tool execution. Tools MUST treat this as immutable
 * for the duration of execution.
 */
export interface ToolContext {
  /** Working directory. All relative paths resolve here. */
  cwd: string;
  /** Environment variables (read-only snapshot). */
  env: Readonly<Record<string, string | undefined>>;
  /** Optional abort signal — tools must check periodically for long ops. */
  signal?: AbortSignal;
  /** True when running headless (CI, pipe). Tools should avoid prompts. */
  nonInteractive?: boolean;
  /** Current session id (for tracing). */
  sessionId?: string;
  /** Permissions snapshot for this turn. */
  permissions?: { mode?: string; allow?: string[]; deny?: string[] };
  /** Logger (pino-like) */
  logger?: { debug: (msg: string, data?: unknown) => void; info: (msg: string, data?: unknown) => void };
  /** Emit KlyroEvent */
  emit?: (ev: import('../events/catalog.js').KlyroEvent) => void;
}

/**
 * A typed tool definition. TInput is the validated input shape; TOutput is
 * what the tool returns on success.
 */
export interface Tool<TInput, TOutput> {
  /** Stable, machine-readable name. Lowercase + underscores. */
  name: string;
  /** Human-readable description — shown to the model. */
  description: string;
  /** Zod schema for runtime validation. */
  inputSchema: z.ZodType<TInput>;
  /** Permission class: read | edit | execute | admin */
  permission?: 'read' | 'edit' | 'execute' | 'admin';
  /** True if tool is safe to run in parallel with others */
  isConcurrencySafe?: boolean;
  /** Render call for approval UI */
  renderCall?: (input: TInput) => string;
  /** Render result for UI */
  renderResult?: (output: TOutput) => string;
  /** Truncate large results to maxResultTokens (default 8k) */
  truncate?: (output: TOutput, maxTokens: number) => TOutput | string;
  /** Execute the tool. Must never throw — return a ToolResult instead. */
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult<TOutput>>;
}

/**
 * Helper to construct a Tool without restating generics.
 */
export function defineTool<TInput, TOutput>(tool: Tool<TInput, TOutput>): Tool<TInput, TOutput> {
  return tool;
}
