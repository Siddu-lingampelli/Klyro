import { describe, it, expect } from 'vitest';
import { buildScopedCommand } from './scoped.js';

const cwd = process.cwd();

describe('buildScopedCommand path validation', () => {
  it('builds a scoped npm command for safe paths', () => {
    const cmd = buildScopedCommand(cwd, 'npm test', ['src/a.test.ts']);
    expect(cmd).toContain('src/a.test.ts');
  });

  it('drops adversarial filenames and returns null when none remain', () => {
    const evil = 'a"; rm -rf /; echo "';
    expect(buildScopedCommand(cwd, 'npm test', [evil])).toBeNull();
    expect(buildScopedCommand(cwd, 'npm test', ['../escape.test.ts'])).toBeNull();
    expect(buildScopedCommand(cwd, 'npm test', ['a$(whoami).test.ts'])).toBeNull();
    expect(buildScopedCommand(cwd, 'npm test', ['a`id`.test.ts'])).toBeNull();
    expect(buildScopedCommand(cwd, 'npm test', ['a|b.test.ts'])).toBeNull();
    expect(buildScopedCommand(cwd, 'npm test', ['a&b.test.ts'])).toBeNull();
    expect(buildScopedCommand(cwd, 'npm test', ['a;b.test.ts'])).toBeNull();
    expect(buildScopedCommand(cwd, 'npm test', ['a(b).test.ts'])).toBeNull();
  });

  it('keeps survivors and drops offenders', () => {
    const cmd = buildScopedCommand(cwd, 'npm test', ['src/ok.test.ts', '../evil.test.ts']);
    expect(cmd).not.toBeNull();
    expect(cmd!).toContain('src/ok.test.ts');
    expect(cmd!).not.toContain('evil');
  });

  it('validates pytest paths too', () => {
    const cmd = buildScopedCommand(cwd, 'pytest -q', ['tests/test_a.py']);
    expect(cmd).toContain('tests/test_a.py');
    expect(buildScopedCommand(cwd, 'pytest -q', ['tests/test_a.py; rm -rf /'])).toBeNull();
  });
});
