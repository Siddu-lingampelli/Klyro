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
  /** Execute the tool. Must never throw — return a ToolResult instead. */
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult<TOutput>>;
}

/**
 * Helper to construct a Tool without restating generics.
 */
export function defineTool<TInput, TOutput>(tool: Tool<TInput, TOutput>): Tool<TInput, TOutput> {
  return tool;
}
