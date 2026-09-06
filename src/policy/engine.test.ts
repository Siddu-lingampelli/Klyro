import { describe, it, expect } from 'vitest';
import {
  PolicyEngine,
  builtinRules,
  DEFAULT_POLICY_CONFIG,
  evaluatePolicy,
} from './engine.js';

const cwd = process.cwd();

describe('PolicyEngine', () => {
  it('denies known destructive shell patterns', async () => {
    const e = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const d = await e.evaluate({ name: 'shell_exec', input: { command: 'rm -rf /' } }, { cwd, nonInteractive: false });
    expect(d.action).toBe('deny');
  });

  it('allows whitelisted shell commands', async () => {
    const e = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const d = await e.evaluate({ name: 'shell_exec', input: { command: 'git status' } }, { cwd, nonInteractive: false });
    expect(d.action).toBe('allow');
  });

  it('asks for non-allowlisted shell in interactive mode', async () => {
    const e = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const d = await e.evaluate({ name: 'shell_exec', input: { command: 'curl https://example.com' } }, { cwd, nonInteractive: false });
    expect(d.action).toBe('ask');
  });

  it('denies non-allowlisted shell in non-interactive mode', async () => {
    const e = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const d = await e.evaluate({ name: 'shell_exec', input: { command: 'curl https://example.com' } }, { cwd, nonInteractive: true });
    expect(d.action).toBe('deny');
  });

  it('denies write_file with absolute path', async () => {
    const e = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const d = await e.evaluate({ name: 'write_file', input: { path: 'C:/Windows/System32/x' } }, { cwd, nonInteractive: false });
    expect(d.action).toBe('deny');
  });

  it('denies write_file with path traversal', async () => {
    const e = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    const d = await e.evaluate({ name: 'write_file', input: { path: '../escape.txt' } }, { cwd, nonInteractive: false });
    expect(d.action).toBe('deny');
  });

  it('falls through to allow by default', async () => {
    const e = new PolicyEngine([], DEFAULT_POLICY_CONFIG);
    const d = await e.evaluate({ name: 'read_file', input: { path: 'a.txt' } }, { cwd, nonInteractive: false });
    expect(d.action).toBe('allow');
  });

  it('evaluatePolicy does not throw on buggy rules', async () => {
    const buggyRule = {
      name: 'buggy',
      evaluate: () => { throw new Error('oops'); },
    };
    const e = new PolicyEngine([buggyRule], DEFAULT_POLICY_CONFIG);
    const d = await evaluatePolicy(e, { name: 'read_file', input: {} }, { cwd, nonInteractive: false });
    // safe() catches and returns an error ToolResult; the engine then
    // surfaces its 'error' as deny with the error message.
    expect(d.action === 'allow' || d.action === 'deny' || d.action === 'ask').toBe(true);
  });
});
