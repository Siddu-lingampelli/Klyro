import { describe, it, expect } from 'vitest';
import { runVerifyTool } from './run-verify.js';
import type { ToolContext } from '../types.js';

describe('runVerifyTool', () => {
  const ctx: ToolContext = { cwd: process.cwd(), env: {}, signal: undefined };

  it('returns ok=true when command succeeds', async () => {
    const cmd = process.platform === 'win32' ? 'echo ok' : 'echo ok';
    const r = await runVerifyTool.execute({ command: cmd }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.ok).toBe(true);
    expect(r.value.exitCode).toBe(0);
  });

  it('returns ok=false in the *output* when command exits non-zero', async () => {
    const cmd = process.platform === 'win32' ? 'exit /b 1' : 'exit 1';
    const r = await runVerifyTool.execute({ command: cmd }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.ok).toBe(false);
    expect(r.value.exitCode).toBe(1);
  });

  it('returns TIMEOUT error when command exceeds timeoutMs', async () => {
    const cmd = process.platform === 'win32' ? 'ping -n 5 127.0.0.1' : 'sleep 5';
    const r = await runVerifyTool.execute({ command: cmd, timeoutMs: 200 }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe('TIMEOUT');
  });

  it('S2: spawned verify commands do not inherit secrets from the parent env', async () => {
    // verify commands run with filtered env; servers needing keys must use explicit config.
    const key = 'MY_TEST_SECRET_XYZ';
    const secret = 's3cr3t-filtered-' + Math.random().toString(36).slice(2);
    process.env[key] = secret;
    try {
      // Quote execPath: it contains spaces on Windows (C:\Program Files\...).
      const cmd = `"${process.execPath}" -e "console.log(process.env.${key})"`;
      const r = await runVerifyTool.execute({ command: cmd }, ctx);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      // Guard against a vacuous pass: the probe command must actually run.
      expect(r.value.ok).toBe(true);
      expect(r.value.exitCode).toBe(0);
      expect(r.value.stdout).not.toContain(secret);
      expect(r.value.stdout.trim()).toBe('undefined');
    } finally {
      delete process.env[key];
    }
  });
});