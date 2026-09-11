/** Tests for src/mcp/policy.ts — deny-by-default semantics. */
import { describe, expect, it } from 'vitest';
import { evaluateMcpPolicy } from './policy.js';

describe('evaluateMcpPolicy', () => {
  it('denies when there is no policy', () => {
    expect(evaluateMcpPolicy(undefined, 'anything').allowed).toBe(false);
  });

  it('denies when allowTools is missing or empty', () => {
    expect(evaluateMcpPolicy({}, 'x').allowed).toBe(false);
    expect(evaluateMcpPolicy({ allowTools: [] }, 'x').allowed).toBe(false);
  });

  it('allows listed tools', () => {
    expect(evaluateMcpPolicy({ allowTools: ['x'] }, 'x')).toEqual({ allowed: true });
  });

  it('denies tools not on the allowlist', () => {
    const d = evaluateMcpPolicy({ allowTools: ['x'] }, 'y');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('y');
  });

  it('denyTools wins over allowTools', () => {
    const d = evaluateMcpPolicy({ allowTools: ['x'], denyTools: ['x'] }, 'x');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('denyTools');
  });
});
