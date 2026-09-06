import { describe, it, expect } from 'vitest';
import { builtinRegistry } from './registry.js';
import { zodToJsonSchema } from './schema.js';
import { z } from 'zod';

describe('zodToJsonSchema', () => {
  it('converts string with min/max', () => {
    const schema = z.string().min(1).max(10);
    const json = zodToJsonSchema(schema);
    expect(json.type).toBe('string');
    expect(json.minLength).toBe(1);
    expect(json.maxLength).toBe(10);
  });

  it('converts object with required fields', () => {
    const schema = z.object({
      path: z.string(),
      opt: z.string().optional(),
      def: z.number().default(5),
    });
    const json = zodToJsonSchema(schema);
    expect(json.type).toBe('object');
    expect(json.required).toEqual(['path']);
    expect(json.properties?.def?.default).toBe(5);
  });

  it('converts array', () => {
    const json = zodToJsonSchema(z.array(z.string()));
    expect(json.type).toBe('array');
    expect(json.items?.type).toBe('string');
  });

  it('converts enum', () => {
    const json = zodToJsonSchema(z.enum(['a', 'b', 'c']));
    expect(json.type).toBe('string');
    expect(json.enum).toEqual(['a', 'b', 'c']);
  });
});

describe('ToolRegistry', () => {
  it('builds the builtin registry with file tools', () => {
    const r = builtinRegistry();
    const names = r.list().map((t) => t.name).sort();
    expect(names).toEqual([
      'apply_patch', 'ask_user', 'dependencies', 'edit_file', 'git_diff', 'git_log', 'git_status', 'glob', 'grep',
      'list_directory', 'multi_edit', 'read_file', 'recent_files', 'run_verify', 'search_files',
      'shell_exec', 'todo_write', 'write_file',
    ]);
  });

  it('exposes OpenAI-style tool definitions', () => {
    const r = builtinRegistry();
    const defs = r.toOpenAITools();
    for (const def of defs) {
      expect(def.type).toBe('function');
      expect(def.function.name).toBeTruthy();
      expect(def.function.description).toBeTruthy();
      expect(def.function.parameters).toBeTypeOf('object');
    }
  });

  it('rejects unknown tools', async () => {
    const r = builtinRegistry();
    const result = await r.execute('nope', {}, { cwd: process.cwd(), env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_TOOL');
  });

  it('rejects invalid input via Zod', async () => {
    const r = builtinRegistry();
    const result = await r.execute('read_file', { path: '' }, { cwd: process.cwd(), env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
  });
});
