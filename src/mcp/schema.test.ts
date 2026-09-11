/** Tests for src/mcp/schema.ts — supported subset + fallback boundaries. */
import { describe, expect, it } from 'vitest';
import { jsonSchemaToZod } from './schema.js';

describe('jsonSchemaToZod', () => {
  it('converts primitives', () => {
    expect(jsonSchemaToZod({ type: 'string' }).safeParse('hi').success).toBe(true);
    expect(jsonSchemaToZod({ type: 'string' }).safeParse(1).success).toBe(false);
    expect(jsonSchemaToZod({ type: 'number' }).safeParse(1.5).success).toBe(true);
    expect(jsonSchemaToZod({ type: 'integer' }).safeParse(1.5).success).toBe(false);
    expect(jsonSchemaToZod({ type: 'integer' }).safeParse(2).success).toBe(true);
    expect(jsonSchemaToZod({ type: 'boolean' }).safeParse(false).success).toBe(true);
  });

  it('converts objects with required/optional', () => {
    const s = jsonSchemaToZod({
      type: 'object',
      properties: { q: { type: 'string' }, n: { type: 'number' } },
      required: ['q'],
    });
    expect(s.safeParse({ q: 'hi' }).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ q: 'hi', extra: 1 }).success).toBe(true); // loose
  });

  it('treats typeless schemas WITH properties as objects', () => {
    const s = jsonSchemaToZod({ properties: { q: { type: 'string' } }, required: ['q'] });
    expect(s.safeParse({ q: 'hi' }).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse('nope').success).toBe(false);
  });

  it('converts string enums and arrays', () => {
    const e = jsonSchemaToZod({ enum: ['a', 'b'] });
    expect(e.safeParse('a').success).toBe(true);
    expect(e.safeParse('c').success).toBe(false);
    const a = jsonSchemaToZod({ type: 'array', items: { type: 'string' } });
    expect(a.safeParse(['x']).success).toBe(true);
    expect(a.safeParse([1]).success).toBe(false);
  });

  it('falls back to z.unknown() for empty/absent/exotic schemas', () => {
    for (const schema of [undefined, null, {}, { type: 'mystery' }, 'str', []] as unknown[]) {
      const s = jsonSchemaToZod(schema);
      // unknown accepts anything, including numbers and objects.
      expect(s.safeParse(42).success).toBe(true);
      expect(s.safeParse({ anything: true }).success).toBe(true);
    }
  });
});
