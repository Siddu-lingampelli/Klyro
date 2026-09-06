/**
 * JSON Schema derivation from Zod 4 schemas.
 *
 * Zod 4 stores constraints on the schema object itself (e.g. `s.minLength`),
 * not in `_zod.def`. We read them directly. For Zod 3 the constraints live
 * in `_def`, so this module falls back to that.
 *
 * Supports: string, number, integer, boolean, enum, literal, array, object,
 * optional, nullable, default, union, description, min/max length, min/max.
 */

import type { z } from 'zod';

export interface JsonSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: JsonSchema[];
  format?: string;
}

interface ZodLike {
  _zod?: { def?: Record<string, unknown>; type?: string };
  _def?: { typeName?: string; description?: string } & Record<string, unknown>;
  description?: string;
  // Zod 4 surfaces constraints as direct properties
  minLength?: number | null;
  maxLength?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
  isInt?: boolean;
  pattern?: { source?: string } | string | null;
  defaultValue?: () => unknown;
  entries?: Record<string, string | number>;
  values?: Record<string, string | number>;
  value?: unknown;
  shape?: Record<string, ZodLike>;
  element?: ZodLike;
  options?: ZodLike[];
  innerType?: ZodLike;
}

function getType(s: ZodLike): string | undefined {
  const zod4 = s._zod?.def?.type as string | undefined;
  if (zod4) return zod4;
  return s._def?.typeName as string | undefined;
}

function getDesc(s: ZodLike): string | undefined {
  return s.description ?? (s._zod?.def?.description as string | undefined) ?? s._def?.description;
}

export function zodToJsonSchema(schema: z.ZodType<unknown>): JsonSchema {
  return convert(schema as unknown as ZodLike, new Set());
}

function convert(schema: ZodLike, seen: Set<object>): JsonSchema {
  if (!schema || typeof schema !== 'object') return { type: 'object' };
  if (seen.has(schema as object)) return { type: 'object' };
  seen.add(schema as object);

  const typeName = getType(schema);
  const desc = getDesc(schema);
  const result: JsonSchema = {};
  if (desc) result.description = desc;

  switch (typeName) {
    case 'ZodString':
    case 'string': {
      result.type = 'string';
      if (typeof schema.minLength === 'number') result.minLength = schema.minLength;
      if (typeof schema.maxLength === 'number') result.maxLength = schema.maxLength;
      if (schema.pattern) {
        result.pattern = typeof schema.pattern === 'string' ? schema.pattern : schema.pattern.source ?? undefined;
      }
      break;
    }
    case 'ZodNumber':
    case 'number': {
      result.type = schema.isInt === true ? 'integer' : 'number';
      if (typeof schema.minValue === 'number') result.minimum = schema.minValue;
      if (typeof schema.maxValue === 'number') result.maximum = schema.maxValue;
      break;
    }
    case 'ZodBigInt':
    case 'bigint':
      result.type = 'integer';
      break;
    case 'ZodBoolean':
    case 'boolean':
      result.type = 'boolean';
      break;
    case 'ZodNull':
    case 'null':
      result.type = 'null';
      break;
    case 'ZodDate':
    case 'date':
      result.type = 'string';
      result.format = 'date-time';
      break;
    case 'ZodArray':
    case 'array':
      result.type = 'array';
      if (schema.element) result.items = convert(schema.element, seen);
      break;
    case 'ZodObject':
    case 'object': {
      result.type = 'object';
      const shape = schema.shape ?? {};
      const props: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const child = convert(value as ZodLike, seen);
        props[key] = child;
        const childType = getType(value as ZodLike);
        if (childType !== 'ZodOptional' && childType !== 'ZodDefault' && childType !== 'optional' && childType !== 'default') {
          required.push(key);
        }
      }
      result.properties = props;
      if (required.length > 0) result.required = required;
      result.additionalProperties = false;
      break;
    }
    case 'ZodEnum':
    case 'enum': {
      const entries =
        schema.entries ??
        schema.values ??
        (schema._zod?.def?.entries as Record<string, string | number> | undefined) ??
        {};
      const values = Object.values(entries);
      if (values.length > 0) {
        result.type = typeof values[0] === 'number' ? 'number' : 'string';
        result.enum = values;
      } else {
        result.type = 'string';
      }
      break;
    }
    case 'ZodLiteral':
    case 'literal': {
      const v = schema.value;
      if (typeof v === 'string') result.type = 'string';
      else if (typeof v === 'number') result.type = 'number';
      else if (typeof v === 'boolean') result.type = 'boolean';
      else if (v === null) result.type = 'null';
      result.enum = [v];
      break;
    }
    case 'ZodUnion':
    case 'union':
    case 'ZodDiscriminatedUnion':
    case 'discriminated_union': {
      const options = schema.options ?? [];
      result.anyOf = options.map((o) => convert(o as ZodLike, seen));
      break;
    }
    case 'ZodOptional':
    case 'optional':
    case 'ZodNullable':
    case 'nullable': {
      const inner = schema.innerType ?? (schema._zod?.def?.innerType as ZodLike | undefined);
      if (inner) return convert(inner, seen);
      break;
    }
    case 'ZodDefault':
    case 'default': {
      const inner = schema.innerType ?? (schema._zod?.def?.innerType as ZodLike | undefined);
      if (inner) {
        const innerSchema = convert(inner, seen);
        // Zod 3: defaultValue is a function. Zod 4: it's a value on _zod.def.
        const dv =
          schema.defaultValue ??
          ((schema._zod?.def?.defaultValue as unknown) as (() => unknown) | undefined);
        if (typeof dv === 'function') {
          try {
            innerSchema.default = (dv as () => unknown)();
          } catch {
            /* ignore */
          }
        } else if (dv !== undefined) {
          innerSchema.default = dv;
        }
        return innerSchema;
      }
      break;
    }
    case 'ZodPipe':
    case 'pipe':
    case 'ZodTransform':
    case 'transform':
      if (schema.innerType) return convert(schema.innerType, seen);
      result.type = 'object';
      result.additionalProperties = true;
      break;
    default:
      result.type = 'object';
      result.additionalProperties = true;
  }

  return result;
}
