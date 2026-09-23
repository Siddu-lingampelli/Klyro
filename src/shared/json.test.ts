import { describe, expect, it } from 'vitest';
import { stripBom } from './json.js';

describe('stripBom', () => {
  it('removes a leading U+FEFF byte-order mark', () => {
    expect(stripBom('﻿{"a":1}')).toBe('{"a":1}');
    expect(JSON.parse(stripBom('﻿{"a":1}'))).toEqual({ a: 1 });
  });

  it('leaves clean input alone (including interior U+FEFF)', () => {
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(stripBom('a﻿b')).toBe('a﻿b');
    expect(stripBom('')).toBe('');
  });
});
