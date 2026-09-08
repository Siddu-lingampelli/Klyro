/**
 * P1 — JSON Schema → Zod converter for MCP tool input schemas.
 *
 * MCP servers describe inputs with JSON Schema; Klyro tools validate with
 * Zod. This converts the common subset (object/string/number/integer/
 * boolean/array/enum + required) and falls back to a permissive
 * `z.looseObject({}).catchall(z.unknown())`-style schema for anything else —
 * validation must never trust, but must also never crash on exotic schemas.
 */
import { z } from 'zod';

export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return z.looseObject({}).catchall(z.unknown());
  }
  const s = schema as Record<string, unknown>;
  const enumerated = Array.isArray(s['enum']) ? (s['enum'] as unknown[]) : undefined;
  if (enumerated && enumerated.length > 0 && enumerated.every((v) => typeof v === 'string')) {
    return z.enum(enumerated as [string, ...string[]]);
  }
  switch (s['type']) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = jsonSchemaToZod(s['items']);
      return z.array(items);
    }
    case 'object': {
      const props = (s['properties'] as Record<string, unknown> | undefined) ?? {};
      const required = new Set(Array.isArray(s['required']) ? (s['required'] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [k, v] of Object.entries(props)) {
        const inner = jsonSchemaToZod(v);
        shape[k] = required.has(k) ? inner : inner.optional();
      }
      return z.looseObject(shape);
    }
    default:
      return z.unknown();
  }
}
