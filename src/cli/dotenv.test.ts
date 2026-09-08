import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDotenv, loadDotenv } from './dotenv.js';

describe('parseDotenv', () => {
  it('parses KEY=VALUE, quotes, comments, export prefix', () => {
    const out = parseDotenv([
      '# comment',
      'KLYRO_API_KEY=sk-test',
      'QUOTED="hello world"',
      "SINGLE='a b'",
      'export PREFIXED=1',
      'INVALID LINE',
      'EMPTY=',
    ].join('\n'));
    expect(out['KLYRO_API_KEY']).toBe('sk-test');
    expect(out['QUOTED']).toBe('hello world');
    expect(out['SINGLE']).toBe('a b');
    expect(out['PREFIXED']).toBe('1');
    expect(out['EMPTY']).toBe('');
    expect(out['INVALID LINE']).toBeUndefined();
  });
});

describe('loadDotenv', () => {
  const key = 'KLYRO_DOTENV_TEST_KEY';
  afterEach(() => { delete process.env[key]; });

  it('loads .env without clobbering existing vars; missing file is a no-op', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-dotenv-'));
    try {
      expect(loadDotenv(dir)).toEqual([]);
      fs.writeFileSync(path.join(dir, '.env'), `${key}=from-file\n`, 'utf-8');
      expect(loadDotenv(dir)).toEqual([key]);
      expect(process.env[key]).toBe('from-file');
      process.env[key] = 'explicit';
      expect(loadDotenv(dir)).toEqual([]);
      expect(process.env[key]).toBe('explicit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env[key];
    }
  });
});
