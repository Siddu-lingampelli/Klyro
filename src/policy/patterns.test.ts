import { describe, it, expect, vi } from 'vitest';
import { patternForCall } from './patterns.js';
import { PatternApprovalCache } from './approval.js';
import { PolicyEngine, builtinRules, clonePolicyConfig } from './engine.js';

describe('patternForCall', () => {
  it('scopes shell commands to first word + wildcard', () => {
    expect(patternForCall('shell_exec', { command: 'npm test -- --run' })).toBe('shell_exec(npm *)');
    expect(patternForCall('shell_exec', { command: 'npm run build' })).toBe('shell_exec(npm *)');
    expect(patternForCall('run_verify', { command: 'npx tsc --noEmit' })).toBe('run_verify(npx *)');
  });

  it('scopes file tools to the exact path', () => {
    expect(patternForCall('write_file', { path: 'src/index.ts' })).toBe('write_file(src/index.ts)');
    expect(patternForCall('edit_file', { path: 'a.txt' })).toBe('edit_file(a.txt)');
  });

  it('falls back to the bare tool name', () => {
    expect(patternForCall('read_file', {})).toBe('read_file');
    expect(patternForCall('shell_exec', {})).toBe('shell_exec');
  });

  it('derived shell patterns re-match via the engine glob grammar', async () => {
    const engine = new PolicyEngine(builtinRules(), clonePolicyConfig());
    engine.addAllow('shell_exec(npm *)');
    const d = await engine.evaluate(
      { name: 'shell_exec', input: { command: 'npm run build' } },
      { cwd: '/x', nonInteractive: true },
    );
    expect(d.action).toBe('allow');
    const d2 = await engine.evaluate(
      { name: 'shell_exec', input: { command: 'curl https://example.com' } },
      { cwd: '/x', nonInteractive: true },
    );
    expect(d2.action).not.toBe('allow');
  });
});

describe('PatternApprovalCache', () => {
  const req = (pattern?: string) => ({
    toolName: 'shell_exec',
    reason: 'not in allowlist',
    summary: 'npm test',
    input: { command: 'npm test' },
    ...(pattern ? { pattern } : {}),
  });

  it('prompts once per pattern, then session-allows', async () => {
    const inner = { ask: vi.fn(async () => 'always' as const) };
    const cache = new PatternApprovalCache(inner);
    expect(await cache.ask(req('shell_exec(npm *)'))).toBe('always');
    expect(await cache.ask(req('shell_exec(npm *)'))).toBe('allow');
    expect(inner.ask).toHaveBeenCalledTimes(1);
  });

  it('different patterns prompt independently', async () => {
    const inner = { ask: vi.fn(async () => 'allow' as const) };
    const cache = new PatternApprovalCache(inner);
    await cache.ask(req('shell_exec(npm *)'));
    await cache.ask(req('shell_exec(git *)'));
    expect(inner.ask).toHaveBeenCalledTimes(2);
  });

  it('derives the pattern from input when absent', async () => {
    const inner = { ask: vi.fn(async () => 'always' as const) };
    const cache = new PatternApprovalCache(inner);
    await cache.ask(req());
    expect(await cache.ask(req())).toBe('allow');
    expect(inner.ask).toHaveBeenCalledTimes(1);
  });

  it('always-persist calls onPersist once, then session-allows', async () => {
    const inner = { ask: vi.fn(async () => 'always-persist' as const) };
    const onPersist = vi.fn();
    const cache = new PatternApprovalCache(inner, { onPersist });
    expect(await cache.ask(req('shell_exec(npm *)'))).toBe('always-persist');
    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(onPersist).toHaveBeenCalledWith('shell_exec(npm *)');
    expect(await cache.ask(req('shell_exec(npm *)'))).toBe('allow');
    expect(onPersist).toHaveBeenCalledTimes(1);
  });

  it('a persist failure still allows the current call (session cached)', async () => {
    const inner = { ask: vi.fn(async () => 'always-persist' as const) };
    const cache = new PatternApprovalCache(inner, {
      onPersist: () => { throw new Error('disk full'); },
    });
    expect(await cache.ask(req('shell_exec(npm *)'))).toBe('always-persist');
    expect(await cache.ask(req('shell_exec(npm *)'))).toBe('allow');
  });

  it('deny is never cached', async () => {
    const inner = { ask: vi.fn(async () => 'deny' as const) };
    const cache = new PatternApprovalCache(inner);
    await cache.ask(req('shell_exec(npm *)'));
    await cache.ask(req('shell_exec(npm *)'));
    expect(inner.ask).toHaveBeenCalledTimes(2);
  });
});
