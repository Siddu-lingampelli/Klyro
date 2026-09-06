/**
 * Tool registry — single source of truth for tools the model can use.
 */

import { readFileTool } from './fs/read-file.js';
import { writeFileTool } from './fs/write-file.js';
import { editFileTool } from './fs/edit-file.js';
import { multiEditTool } from './fs/multi-edit.js';
import { applyPatchTool } from './fs/apply-patch.js';
import { listDirTool } from './fs/list-dir.js';
import { globTool } from './search/glob.js';
import { grepTool } from './search/grep.js';
import { searchFilesTool } from './search/search-files.js';
import { recentFilesTool } from './search/recent-files.js';
import { dependenciesTool } from './search/dependencies.js';
import { shellExecTool } from './shell/shell-exec.js';
import { gitStatusTool } from './git/git-status.js';
import { gitDiffTool } from './git/git-diff.js';
import { gitLogTool } from './git/git-log.js';
import { runVerifyTool } from './verify/run-verify.js';
import { todoWriteTool } from './plan/todo-write.js';
import { askUserTool } from './plan/ask-user.js';
import { repoMapTool } from './repo-map.js';
import { importsOfTool, importersOfTool } from './search/imports.js';
import { findSymbolTool } from './symbols/find-symbol.js';
import { lspDiagnosticsTool, lspGotoDefinitionTool } from './lsp/diagnostics.js';
import { expandResultTool } from './expand-result.js';
import { memoryWriteTool } from './memory-write.js';
import type { Tool, ToolContext, ToolResult } from './types.js';
import { zodToJsonSchema } from './schema.js';

export class ToolRegistry {
  private readonly tools: Map<string, Tool<unknown, unknown>> = new Map();

  register<TIn, TOut>(tool: Tool<TIn, TOut>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as Tool<unknown, unknown>);
    return this;
  }

  get(name: string): Tool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): Tool<unknown, unknown>[] {
    return [...this.tools.values()];
  }

  /** Tools in OpenAI-style tool definition format. */
  toOpenAITools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
    return this.list().map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.inputSchema),
      },
    }));
  }

  /** Cached JSON Schemas keyed by tool name (for adapter consumers). */
  jsonSchemas(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const t of this.list()) {
      out[t.name] = zodToJsonSchema(t.inputSchema);
    }
    return out;
  }

  async execute(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult<unknown>> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` } };
    }
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: `Invalid input for ${name}`,
          details: parsed.error.issues,
        },
      };
    }
    return tool.execute(parsed.data, ctx);
  }
}

export const builtinRegistry = (): ToolRegistry => {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(editFileTool);
  r.register(multiEditTool);
  r.register(applyPatchTool);
  r.register(listDirTool);
  r.register(globTool);
  r.register(grepTool);
  r.register(searchFilesTool);
  r.register(recentFilesTool);
  r.register(dependenciesTool);
  r.register(shellExecTool);
  r.register(gitStatusTool);
  r.register(gitDiffTool);
  r.register(gitLogTool);
  r.register(runVerifyTool);
  r.register(todoWriteTool);
  r.register(askUserTool);
  r.register(repoMapTool);
  r.register(importsOfTool);
  r.register(importersOfTool);
  r.register(findSymbolTool);
  r.register(lspDiagnosticsTool);
  r.register(lspGotoDefinitionTool);
  r.register(expandResultTool);
  r.register(memoryWriteTool);
  return r;
};
