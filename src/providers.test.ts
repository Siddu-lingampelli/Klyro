/**
 * Persisted provider resolution: set once (config + credentials), works in
 * every terminal with zero env vars.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveProvider, lastProviderError } from './providers.js';

let dir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['KLYRO_BASE_URL', 'KLYRO_API_KEY', 'KLYRO_MODEL', 'KLYRO_PROVIDER', 'KLYRO_CONFIG', 'KLYRO_CONFIG_DIR', 'KLYRO_CREDENTIALS_FILE'];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-prov-'));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.KLYRO_CONFIG = path.join(dir, 'settings.json');
  process.env.KLYRO_CONFIG_DIR = dir;
  process.env.KLYRO_CREDENTIALS_FILE = path.join(dir, 'credentials.json');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(obj: Record<string, unknown>): void {
  fs.writeFileSync(process.env.KLYRO_CONFIG!, JSON.stringify(obj), 'utf-8');
}

function writeCreds(obj: Record<string, string>): void {
  fs.writeFileSync(process.env.KLYRO_CREDENTIALS_FILE!, JSON.stringify(obj), 'utf-8');
}

describe('resolveProvider persisted layers', () => {
  it('uses saved baseUrl + model + key (source config)', async () => {
    writeConfig({ provider: 'openai', baseUrl: 'https://proxy.example.com/v1', model: 'my-model' });
    writeCreds({ openai: 'sk-saved' });
    const r = await resolveProvider();
    expect(r).not.toBeNull();
    expect(r!.source).toBe('config');
    expect(r!.baseURL).toBe('https://proxy.example.com/v1');
    expect(r!.model).toBe('my-model');
    expect(r!.apiKey).toBe('sk-saved');
  });

  it('uses stored key alone when no base URL saved', async () => {
    writeCreds({ anthropic: 'sk-ant-saved' });
    const r = await resolveProvider();
    expect(r).not.toBeNull();
    expect(r!.source).toBe('config');
    expect(r!.baseURL).toContain('anthropic.com');
    expect(r!.apiKey).toBe('sk-ant-saved');
  });

  it('env still wins over saved config', async () => {
    writeConfig({ baseUrl: 'https://saved.example.com/v1', model: 'saved-model' });
    process.env.KLYRO_BASE_URL = 'https://env.example.com/v1';
    process.env.KLYRO_MODEL = 'env-model';
    const r = await resolveProvider();
    expect(r!.source).toBe('env');
    expect(r!.baseURL).toBe('https://env.example.com/v1');
    expect(r!.model).toBe('env-model');
  });

  it('persisted allowInsecure honors a saved plain-HTTP remote URL', async () => {
    writeConfig({
      provider: 'openai',
      baseUrl: 'http://129.159.226.245:20128/v1',
      model: 'm',
      allowInsecure: true,
    });
    writeCreds({ openai: 'sk-saved' });
    const r = await resolveProvider();
    expect(r).not.toBeNull();
    expect(r!.source).toBe('config');
    expect(r!.baseURL).toBe('http://129.159.226.245:20128/v1');
    expect(r!.apiKey).toBe('sk-saved');
    expect(lastProviderError()).toBeNull();
  });

  it('saved plain-HTTP remote URL without opt-in resolves nothing but records why', async () => {
    writeConfig({ provider: 'openai', baseUrl: 'http://129.159.226.245:20128/v1', model: 'm' });
    writeCreds({ openai: 'sk-saved' });
    const r = await resolveProvider();
    expect(r).toBeNull();
    expect(lastProviderError()).toMatch(/plaintext HTTP/);
  });

  it('saved model applies to local probe fallback', async () => {
    // No endpoint/config/keys here → would probe localhost. Just assert the
    // null-or-probe path does not read stale env (env cleared in beforeEach).
    writeConfig({ model: 'pinned-model' });
    const r = await resolveProvider();
    // Either a local server answered (model must be pinned-model) or nothing.
    if (r) expect(r.model).toBe('pinned-model');
    else expect(r).toBeNull();
  });
});
