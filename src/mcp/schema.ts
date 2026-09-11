/**
 * P1 — JSON Schema → Zod converter for MCP tool input schemas.
 *
 * MCP servers describe inputs with JSON Schema; Klyro tools validate with
 * Zod. Supported subset:
 *
 *   - `type`: `object` (with `properties` + `required`), `string`,
 *     `number`, `integer`, `boolean`, `array` (with `items`)
 *   - string `enum` (handled before `type`)
 *   - a schema object WITHOUT a `type` but WITH a `properties` map is
 *     treated as `type: 'object'` (many servers omit the type)
 *
 * Anything else — an empty/absent schema, non-object input, an unknown
 * `type` — falls back to `z.unknown()` (accept anything, validate nothing).
 * Validation must never trust, but must also never crash on exotic schemas.
 */
import { z } from 'zod';

function objectFrom(s: Record<string, unknown>): z.ZodTypeAny {
  const props = (s['properties'] as Record<string, unknown> | undefined) ?? {};
  const required = new Set(Array.isArray(s['required']) ? (s['required'] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, v] of Object.entries(props)) {
    const inner = jsonSchemaToZod(v);
    shape[k] = required.has(k) ? inner : inner.optional();
  }
  return z.looseObject(shape);
}

export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return z.unknown();
  }
  const s = schema as Record<string, unknown>;
  const enumerated = Array.isArray(s['enum']) ? (s['enum'] as unknown[]) : undefined;
  if (enumerated && enumerated.length > 0 && enumerated.every((v) => typeof v === 'string')) {
    return z.enum(enumerated as [string, ...string[]]);
  }
  const t = s['type'];
  if (t === 'object' || (t === undefined && s['properties'] !== undefined && typeof s['properties'] === 'object' && s['properties'] !== null && !Array.isArray(s['properties']))) {
    return objectFrom(s);
  }
  switch (t) {
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
    default:
      return z.unknown();
  }
}
