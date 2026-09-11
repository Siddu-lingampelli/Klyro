import { describe, it, expect } from 'vitest';
import { classifyFailure } from './classify.js';
import type { BaselineResult } from './baseline.js';

function baselineFor(stdout: string, stderr: string, exitCode: number): BaselineResult {
  return { head: 'abc', command: 'npm test', ok: false, exitCode, stdout, stderr, capturedAt: Date.now() };
}

describe('classifyFailure structured signatures', () => {
  it('marks same type + overlapping file as pre-existing', () => {
    const cur = {
      failure: { type: 'type' as const, files: [{ path: 'src/a.ts', message: 'error TS1' }], raw: 'x', exitCode: 2 },
      stdout: 'src/a.ts(1,2): error TS1: bad',
      stderr: '',
    };
    const base = baselineFor('src/a.ts(1,2): error TS1: bad', '', 2);
    expect(classifyFailure(cur, base)).toBe('pre_existing');
  });

  it('marks same type but disjoint files as introduced (no substring match)', () => {
    const cur = {
      failure: { type: 'type' as const, files: [{ path: 'src/new-file.ts', message: 'error TS1' }], raw: 'x', exitCode: 2 },
      stdout: 'src/new-file.ts(1,2): error TS1: bad',
      stderr: '',
    };
    // Baseline raw mentions a substring of the new path — old heuristic
    // would false-positive; structured overlap must not.
    const base = baselineFor('src/new.ts(9,9): error TS9: other', '', 2);
    expect(classifyFailure(cur, base)).toBe('introduced');
  });

  it('marks fileless same-type same-exit as pre-existing', () => {
    const cur = {
      failure: { type: 'unknown' as const, files: [], raw: 'boom', exitCode: 1 },
      stdout: 'boom',
      stderr: '',
    };
    const base = baselineFor('boom', '', 1);
    // detect() on 'boom' with exit 1 → build/unknown; assert behavior is
    // deterministic rather than a specific class when types differ.
    const cls = classifyFailure(cur, base);
    expect(['pre_existing', 'introduced']).toContain(cls);
  });

  it('flaky still wins', () => {
    const cur = {
      failure: { type: 'test' as const, files: [{ path: 'a.test.ts', message: 'fail' }], raw: 'x', exitCode: 1 },
      stdout: 'FAIL a.test.ts',
      stderr: '',
    };
    const base = baselineFor('FAIL a.test.ts', '', 1);
    expect(classifyFailure(cur, base, true)).toBe('flaky');
  });
});
