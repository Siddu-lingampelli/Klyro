/**
 * ScopedRegistry — a `ToolRegistry` that narrows the surface to a resolved
 * capability set.
 *
 * Both surfaces the runtime relies on (`toolDefinitions(deps.registry)`
 * and `deps.registry.execute(...)`) go through `list()` / `execute()`, so
 * wrapping the child's registry in this class enforces the tool allow-set
 * end-to-end without touching the runtime loop: the model only sees the
 * allowed tools, and any call to a disallowed tool returns `UNKNOWN_TOOL`.
 */

import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';

export class ScopedRegistry extends ToolRegistry {
  private readonly parent: ToolRegistry;
  private readonly allowed: ReadonlySet<string>;

  constructor(parent: ToolRegistry, allowed: ReadonlySet<string>) {
    super();
    this.parent = parent;
    this.allowed = allowed;
  }

  override get(name: string): Tool<unknown, unknown> | undefined {
    return this.allowed.has(name) ? this.parent.get(name) : undefined;
  }

  override list(): Tool<unknown, unknown>[] {
    return this.parent.list().filter((t) => this.allowed.has(t.name));
  }

  /** Which tools this scope permits, by name (for diagnostics/tests). */
  names(): string[] {
    return [...this.allowed].sort();
  }

  override async execute(
    name: string,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult<unknown>> {
    if (!this.allowed.has(name)) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_TOOL',
          message: `Tool not available in this agent context: ${name}`,
        },
      };
    }
    return this.parent.execute(name, rawInput, ctx);
  }
}