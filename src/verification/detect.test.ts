import { describe, it, expect } from 'vitest';
import { detect, summarize } from './detect.js';

describe('detect', () => {
  it('classifies TypeScript tsc errors', () => {
    const stderr = [
      "src/foo.ts(12,5): error TS2304: Cannot find name 'x'.",
      "src/bar.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join('\n');
    const f = detect('', stderr, 2);
    expect(f.type).toBe('type');
    expect(f.files).toHaveLength(2);
    expect(f.files[0]?.path).toBe('src/foo.ts');
    expect(f.files[0]?.code).toBe('TS2304');
    expect(f.files[0]?.line).toBe(12);
  });

  it('classifies test failures', () => {
    const stdout = 'FAIL src/foo.test.ts\n  ✘ should work\nTests: 1 failed';
    const f = detect(stdout, '', 1);
    expect(f.type).toBe('test');
  });

  it('classifies runtime exceptions', () => {
    const stderr = 'Error: cannot read property foo of undefined\n    at bar';
    const f = detect('', stderr, 1);
    expect(f.type).toBe('runtime');
  });

  it('classifies exit-0 as unknown (success path handled by caller)', () => {
    const f = detect('done', '', 0);
    expect(f.exitCode).toBe(0);
  });
});

describe('summarize', () => {
  it('produces a structured bullet list for type errors', () => {
    const stderr = "src/foo.ts(12,5): error TS2304: Cannot find name 'x'.";
    const f = detect('', stderr, 2);
    const s = summarize(f);
    expect(s).toContain('Verification failed');
    expect(s).toContain('type');
    expect(s).toContain('src/foo.ts:12:5');
    expect(s).toContain('TS2304');
  });
});
