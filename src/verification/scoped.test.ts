import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildScopedCommand, findRelatedTests } from './scoped.js';

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

describe('findRelatedTests directory + name matching', () => {
  function seed(structure: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-findtests-'));
    for (const [rel, content] of Object.entries(structure)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }

  it('matches exact stems but not substring noise or sibling dirs', () => {
    const dir = seed({
      'foo.ts': 'x',
      'foo.test.ts': 'x',
      'catalog.test.ts': 'x',
      'foo2/bar.test.ts': 'x',
      'other/baz.test.ts': 'x',
    });
    try {
      const rel = findRelatedTests(dir, [path.join(dir, 'foo.ts')]);
      expect(rel).toContain(path.join('foo.test.ts'));
      // 'catalog.ts' is not edited; 'foo2/bar' shares only a string prefix.
      expect(rel.some((r) => r.includes('catalog'))).toBe(false);
      expect(rel.some((r) => r.includes('foo2'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires a substantive core for fuzzy same-dir matches', () => {
    const dir = seed({ 'a.ts': 'x', 'apple.test.ts': 'x' });
    try {
      // Single-char stem must not drag in every same-dir test.
      expect(findRelatedTests(dir, [path.join(dir, 'a.ts')])).not.toContain(
        path.join('apple.test.ts'),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
