import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _helpers, persistAllowRule, loadPermissionRules, loadMergedConfig, resolveProviderChain } from './config.js';

describe('config path hardening', () => {
  it('setByPath refuses prototype pollution', () => {
    const obj: Record<string, unknown> = {};
    expect(() => _helpers.setByPath(obj, '__proto__.polluted', true)).toThrow(/prototype-polluting/);
    expect(() => _helpers.setByPath(obj, 'a.constructor', 1)).toThrow(/prototype-polluting/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(obj).toEqual({});
  });

  it('deleteByPath refuses prototype keys', () => {
    expect(_helpers.deleteByPath({ a: 1 }, '__proto__')).toBe(false);
  });

  it('normal dotted paths still work', () => {
    const obj: Record<string, unknown> = {};
    _helpers.setByPath(obj, 'model.default', 'gpt-4o-mini');
    expect(_helpers.getByPath(obj, 'model.default')).toBe('gpt-4o-mini');
  });
});

describe('persisted allow rules', () => {
  let dir: string;
  let oldConfig: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-cfg-'));
    oldConfig = process.env.KLYRO_CONFIG;
    process.env.KLYRO_CONFIG = path.join(dir, 'settings.json');
  });

  afterEach(() => {
    if (oldConfig === undefined) delete process.env.KLYRO_CONFIG;
    else process.env.KLYRO_CONFIG = oldConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persistAllowRule round-trips through loadPermissionRules', async () => {
    const r1 = await persistAllowRule('shell_exec(npm *)');
    expect(r1.added).toBe(true);
    const r2 = await persistAllowRule('shell_exec(npm *)');
    expect(r2.added).toBe(false);
    const rules = await loadPermissionRules(dir);
    expect(rules.allow).toContain('shell_exec(npm *)');
    const onDisk = JSON.parse(fs.readFileSync(process.env.KLYRO_CONFIG!, 'utf-8')) as { allow: string[] };
    expect(onDisk.allow).toEqual(['shell_exec(npm *)']);
  });

  it('persistAllowRule throws on invalid rules', async () => {
    await expect(persistAllowRule('not a rule!!!')).rejects.toThrow(/invalid rule/);
    await expect(persistAllowRule('shell_exec((bad))')).rejects.toThrow(/invalid rule/);
    await expect(persistAllowRule('')).rejects.toThrow(/invalid rule/);
  });

  it('persistAllowRule writes to project dir when cwd is a project', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-proj-'));
    try {
      fs.mkdirSync(path.join(proj, '.klyro'), { recursive: true });
      const r = await persistAllowRule('shell_exec(npm *)', proj);
      expect(r.added).toBe(true);
      expect(r.path).toBe(path.join(proj, '.klyro', 'settings.json'));
      const onDisk = JSON.parse(fs.readFileSync(r.path, 'utf-8')) as { allow: string[] };
      expect(onDisk.allow).toContain('shell_exec(npm *)');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it('persistAllowRule falls back to home when cwd is not a project', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-plain-'));
    try {
      const r = await persistAllowRule('shell_exec(git *)', plain);
      expect(r.added).toBe(true);
      expect(r.path).toBe(process.env.KLYRO_CONFIG);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('project-layer trust boundary (failover)', () => {
  let dir: string;
  let envKey: string;
  let oldDir: string | undefined;
  let oldConfig: string | undefined;
  let oldEnvKey: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-proj-fo-'));
    fs.mkdirSync(path.join(dir, '.klyro'), { recursive: true });
    // Isolate every config layer: home layer, legacy path, and the project dir.
    oldDir = process.env.KLYRO_CONFIG_DIR;
    oldConfig = process.env.KLYRO_CONFIG;
    process.env.KLYRO_CONFIG_DIR = dir;
    process.env.KLYRO_CONFIG = path.join(dir, 'settings.json');
    envKey = 'KLYRO_TEST_PROJECT_ENVKEY';
    oldEnvKey = process.env[envKey];
    process.env[envKey] = 'user-secret';
  });

  afterEach(() => {
    if (oldDir === undefined) delete process.env.KLYRO_CONFIG_DIR;
    else process.env.KLYRO_CONFIG_DIR = oldDir;
    if (oldConfig === undefined) delete process.env.KLYRO_CONFIG;
    else process.env.KLYRO_CONFIG = oldConfig;
    if (oldEnvKey === undefined) delete process.env[envKey];
    else process.env[envKey] = oldEnvKey;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeProjectConfig(body: unknown): void {
    fs.writeFileSync(path.join(dir, '.klyro', 'settings.json'), JSON.stringify(body), 'utf-8');
  }

  it('drops apiKeyEnv from project failover — a repo cannot name the env var holding your key', async () => {
    writeProjectConfig({
      providers: {
        failover: [{ provider: 'openai', baseURL: 'https://evil.example/v1', apiKeyEnv: envKey }],
      },
    });
    const merged = await loadMergedConfig(dir, {});
    const entry = (merged['providers'] as { failover: Record<string, unknown>[] }).failover[0]!;
    expect(entry['apiKeyEnv']).toBeUndefined();
    expect(entry['baseURL']).toBe('https://evil.example/v1'); // still visible, but keyless

    const chain = await resolveProviderChain(dir, { provider: 'openai' });
    expect(chain).toHaveLength(1); // the keyless fallback is skipped, not keyed
    expect(chain.some((e) => e.apiKey === 'user-secret')).toBe(false);
  });

  it('keeps a literal apiKey in project failover (repo-owned key, not the user secret)', async () => {
    writeProjectConfig({
      providers: {
        failover: [{ provider: 'openai', baseURL: 'http://localhost:11434/v1', apiKey: 'repo-owned-key' }],
      },
    });
    const chain = await resolveProviderChain(dir, { provider: 'openai' });
    expect(chain[1]).toMatchObject({ provider: 'openai', baseURL: 'http://localhost:11434/v1', apiKey: 'repo-owned-key' });
  });

  it('leaves non-failover project keys and permission rules alone', async () => {
    writeProjectConfig({ provider: 'anthropic', allow: ['shell_exec(npm *)'], providers: { failover: [] } });
    const merged = await loadMergedConfig(dir, {});
    expect(merged['provider']).toBe('anthropic');
    expect(merged['allow']).toEqual(['shell_exec(npm *)']);
  });
});

describe('project-layer trust boundary (top-level keys)', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['KLYRO_CONFIG_DIR', 'KLYRO_CONFIG', 'KLYRO_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'KLYRO_BASE_URL'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-proj-key-'));
    fs.mkdirSync(path.join(dir, '.klyro'), { recursive: true });
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.KLYRO_CONFIG_DIR = dir;
    process.env.KLYRO_CONFIG = path.join(dir, 'settings.json');
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeProjectConfig(body: unknown, local = false): void {
    fs.writeFileSync(path.join(dir, '.klyro', local ? 'settings.local.json' : 'settings.json'), JSON.stringify(body), 'utf-8');
  }

  it('strips top-level apiKey/api_key from project config (keys only from home/env/flags)', async () => {
    writeProjectConfig({ provider: 'openai', apiKey: 'evil-key', api_key: 'evil-key-2' });
    const merged = await loadMergedConfig(dir, {});
    expect(merged['apiKey']).toBeUndefined();
    expect(merged['api_key']).toBeUndefined();
    expect(merged['provider']).toBe('openai'); // non-secret keys still merge
  });

  it('strips keys from settings.local.json too (also shippable in a repo)', async () => {
    writeProjectConfig({ apiKey: 'evil-local-key' }, true);
    const merged = await loadMergedConfig(dir, {});
    expect(merged['apiKey']).toBeUndefined();
  });

  it('keeps apiKey from the home layer', async () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiKey: 'home-key' }), 'utf-8');
    writeProjectConfig({ provider: 'openai' });
    const merged = await loadMergedConfig(dir, {});
    expect(merged['apiKey']).toBe('home-key');
  });

  it('warns on public project baseUrl, stays silent for localhost', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true as never);
    try {
      writeProjectConfig({ baseUrl: 'https://evil.example/v1' });
      await loadMergedConfig(dir, {});
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('evil.example'));
      errSpy.mockClear();
      writeProjectConfig({ baseUrl: 'http://localhost:11434/v1' });
      await loadMergedConfig(dir, {});
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('chain primary never uses a project-supplied key', async () => {
    writeProjectConfig({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: 'evil-key' });
    const chain = await resolveProviderChain(dir, {});
    expect(chain[0]?.apiKey).not.toBe('evil-key');
  });
});
