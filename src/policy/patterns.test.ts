import { describe, it, expect, vi } from 'vitest';
import { patternForCall } from './patterns.js';
import { PatternApprovalCache, approvalChoiceForKey, sanitizeForPrompt } from './approval.js';
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

describe('approvalChoiceForKey', () => {
  it("'A' persists to settings while 'a' is session-only", () => {
    expect(approvalChoiceForKey('A')).toBe('always-persist');
    expect(approvalChoiceForKey('a')).toBe('always');
  });

  it('maps single keys (case-insensitive except A)', () => {
    expect(approvalChoiceForKey('y')).toBe('allow');
    expect(approvalChoiceForKey('Y')).toBe('allow');
    expect(approvalChoiceForKey('n')).toBe('deny');
    expect(approvalChoiceForKey('d')).toBe('deny');
    expect(approvalChoiceForKey('f')).toBe('expand');
    expect(approvalChoiceForKey('?')).toBe('explain');
    expect(approvalChoiceForKey('z')).toBeNull();
  });
});

describe('sanitizeForPrompt', () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  it('strips ANSI CSI and OSC escapes', () => {
    expect(sanitizeForPrompt(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitizeForPrompt(`a${ESC}]0;title${BEL}b`)).toBe('ab');
  });

  const SOH = String.fromCharCode(1);
  const STX = String.fromCharCode(2);
  it('strips control chars but keeps newline and tab', () => {
    expect(sanitizeForPrompt(`a${SOH}b${STX}c`)).toBe('abc');
    expect(sanitizeForPrompt('line1\nline2\tindented')).toBe('line1\nline2\tindented');
  });

  it('truncates to 500 chars with a hidden-count marker', () => {
    const out = sanitizeForPrompt('x'.repeat(600));
    expect(out).toBe('x'.repeat(500) + '…[+100 hidden]');
    expect(sanitizeForPrompt('x'.repeat(500))).toBe('x'.repeat(500));
  });
});
