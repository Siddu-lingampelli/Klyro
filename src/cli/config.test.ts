import { describe, it, expect } from 'vitest';
import { _helpers } from './config.js';

describe('config path hardening', () => {
  it('setByPath refuses prototype pollution', () => {
    const obj: Record<string, unknown> = {};
    expect(() => _helpers.setByPath(obj, '__proto__.polluted', true)).toThrow(/prototype-polluting/);
    expect(() => _helpers.setByPath(obj, 'a.constructor', 1)).toThrow(/prototype-polluting/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(obj).toEqual({});
  });

  it('deleteByPath refuses prototype keys', () => {
    expect(_helpers.deleteByPath({ a: 1 }, '__proto__')).toBe(false);
  });

  it('normal dotted paths still work', () => {
    const obj: Record<string, unknown> = {};
    _helpers.setByPath(obj, 'model.default', 'gpt-4o-mini');
    expect(_helpers.getByPath(obj, 'model.default')).toBe('gpt-4o-mini');
  });
});
