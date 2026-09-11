import { describe, it, expect, beforeAll } from 'vitest';
import { detectSandbox, sandboxCommand, resetSandbox } from './sandbox.js';

// G1-1 tests. The bwrap backend only runs on Linux with bubblewrap installed;
// on Windows (and Linux without bwrap) the shim must decline *honestly* —
// returning `undefined` and never a fake "sandboxed".

describe('sandbox shim — degrade-cleanly contract', () => {
  beforeAll(() => resetSandbox());

  it('detects a status without throwing, on every platform', () => {
    const s = detectSandbox();
    expect(s).toHaveProperty('backend');
    expect(s).toHaveProperty('active');
    expect(typeof s.reason).toBe('string');
    expect(typeof s.active).toBe('boolean');
  });

  it('never pretends: sandboxCommand is undefined when no backend is active', () => {
    const s = detectSandbox();
    const wrap = sandboxCommand('echo', ['hi'], { cwd: process.cwd() });
    if (!s.active) {
      expect(wrap).toBeUndefined();
    } else {
      // On a real Linux bwrap install, the wrapper must be a bwrap argv.
      expect(wrap).toBeDefined();
      expect(wrap!.cmd).toBe('bwrap');
      expect(wrap!.args).toContain('--');
      expect(wrap!.args[wrap!.args.indexOf('--') + 1]).toBe('echo');
    }
  });

  it('cached detection is stable across calls', () => {
    const a = detectSandbox();
    const b = detectSandbox();
    expect(a.backend).toBe(b.backend);
    expect(a.active).toBe(b.active);
  });

  it('resets detection state for tests', () => {
    resetSandbox();
    const s = detectSandbox();
    expect(s.backend).toBe(detectSandbox().backend);
  });
});