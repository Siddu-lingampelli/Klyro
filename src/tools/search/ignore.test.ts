import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { IgnoreFilter, ignoreRuleToRegex } from './ignore.js';

describe('ignore filter', () => {
  it('converts rules to regex', () => {
    const exact = ignoreRuleToRegex('/node_modules');
    expect(exact?.test('node_modules')).toBe(true);
    expect(exact?.test('node_modules/foo')).toBe(true);
    expect(exact?.test('sub/node_modules')).toBe(false);

    const anywhere = ignoreRuleToRegex('node_modules');
    expect(anywhere?.test('node_modules')).toBe(true);
    expect(anywhere?.test('sub/node_modules')).toBe(true);
    expect(anywhere?.test('sub/node_modules/foo')).toBe(true);

    const ext = ignoreRuleToRegex('*.log');
    expect(ext?.test('a.log')).toBe(true);
    expect(ext?.test('sub/a.log')).toBe(true);
    expect(ext?.test('a.log.txt')).toBe(false);
  });

  it('loads ignore files', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-ignore-'));
    try {
      await fs.writeFile(path.join(tmp, '.gitignore'), 'node_modules\n*.log\n', 'utf-8');
      await fs.writeFile(path.join(tmp, '.klyroignore'), '/secret\n', 'utf-8');

      const filter = await IgnoreFilter.load(tmp);
      expect(filter.ignores('node_modules')).toBe(true);
      expect(filter.ignores('sub/node_modules')).toBe(true);
      expect(filter.ignores('a.log')).toBe(true);
      expect(filter.ignores('sub/a.log')).toBe(true);
      expect(filter.ignores('secret')).toBe(true);
      expect(filter.ignores('sub/secret')).toBe(false);
      expect(filter.ignores('index.ts')).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});