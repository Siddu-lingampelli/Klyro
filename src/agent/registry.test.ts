import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildProvider, buildProviderFromCli, inferProviderFromBaseURL } from './registry.js';
import { httpChatAdapter } from './provider-adapter.js';
import { anthropicAdapter } from './anthropic-adapter.js';

describe('inferProviderFromBaseURL', () => {
  it('anthropic for api.anthropic.com', () => {
    expect(inferProviderFromBaseURL('https://api.anthropic.com/v1')).toBe('anthropic');
  });
  it('openai for api.openai.com', () => {
    expect(inferProviderFromBaseURL('https://api.openai.com/v1')).toBe('openai');
  });
  it('openai for ollama localhost', () => {
    expect(inferProviderFromBaseURL('http://localhost:11434/v1')).toBe('openai');
  });
  it('openai when undefined', () => {
    expect(inferProviderFromBaseURL(undefined)).toBe('openai');
  });
  it('openai when invalid', () => {
    expect(inferProviderFromBaseURL('not-a-url')).toBe('openai');
  });
});

describe('buildProvider', () => {
  const originalEnv = { ...process.env };
  // Isolate from the developer's real ~/.klyro (persisted fallback must not leak in).
  const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-reg-'));
  const isoConfig = path.join(isoDir, 'settings.json');
  const isoCreds = path.join(isoDir, 'credentials.json');
  beforeEach(() => {
    delete process.env.KLYRO_PROVIDER;
    delete process.env.KLYRO_BASE_URL;
    delete process.env.KLYRO_API_KEY;
    process.env.KLYRO_CONFIG = isoConfig;
    process.env.KLYRO_CREDENTIALS_FILE = isoCreds;
    fs.rmSync(isoConfig, { force: true });
    fs.rmSync(isoCreds, { force: true });
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(isoConfig, { force: true });
    fs.rmSync(isoCreds, { force: true });
  });

  it('throws when openai adapter lacks credentials', () => {
    expect(() => buildProvider({ provider: 'openai' })).toThrow(/invalid --provider/);
  });

  it('throws when anthropic adapter lacks apiKey', () => {
    expect(() => buildProvider({ provider: 'anthropic' })).toThrow(/invalid --provider/);
  });

  it('builds openai adapter when explicitly requested', () => {
    const a = buildProvider({
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
    expect(a.id).toBe('http-chat+retry');
  });

  it('builds anthropic adapter when explicitly requested', () => {
    const a = buildProvider({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });
    expect(a.id).toBe('anthropic+retry');
  });

  it('infers anthropic from KLYRO_BASE_URL when KLYRO_PROVIDER unset', () => {
    process.env.KLYRO_BASE_URL = 'https://api.anthropic.com/v1';
    process.env.KLYRO_API_KEY = 'sk-ant-test';
    const a = buildProvider();
    expect(a.id).toBe('anthropic+retry');
  });

  it('infers openai from KLYRO_BASE_URL (Ollama) when KLYRO_PROVIDER unset', () => {
    process.env.KLYRO_BASE_URL = 'http://localhost:11434/v1';
    process.env.KLYRO_API_KEY = 'dummy';
    const a = buildProvider();
    expect(a.id).toBe('http-chat+retry');
  });

  it('KLYRO_PROVIDER overrides inference', () => {
    process.env.KLYRO_BASE_URL = 'https://api.anthropic.com/v1';
    process.env.KLYRO_API_KEY = 'sk-x';
    process.env.KLYRO_PROVIDER = 'openai';
    const a = buildProvider();
    expect(a.id).toBe('http-chat+retry');
  });

  it('retry:false returns the inner adapter directly', () => {
    const a = buildProvider({
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      retry: false,
    });
    expect(a.id).toBe('http-chat');
  });

  it('buildProviderFromCli rejects unknown provider', () => {
    expect(() => buildProviderFromCli({ provider: 'grok' })).toThrow(/invalid --provider/);
  });

  it('buildProviderFromCli passes through openai', () => {
    const a = buildProviderFromCli({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
    });
    expect(a.id).toBe('http-chat+retry');
  });

  it('exports the underlying adapter factories', () => {
    expect(typeof httpChatAdapter).toBe('function');
    expect(typeof anthropicAdapter).toBe('function');
  });

  it('falls back to persisted settings.json + credentials (fresh terminal, zero env)', () => {
    fs.writeFileSync(isoConfig, JSON.stringify({ provider: 'openai', baseUrl: 'https://saved.example.com/v1', model: 'm' }));
    fs.writeFileSync(isoCreds, JSON.stringify({ openai: 'sk-saved' }));
    const a = buildProvider();
    expect(a.id).toBe('http-chat+retry');
  });

  it('env still wins over persisted settings', () => {
    fs.writeFileSync(isoConfig, JSON.stringify({ baseUrl: 'https://saved.example.com/v1' }));
    fs.writeFileSync(isoCreds, JSON.stringify({ openai: 'sk-saved' }));
    process.env.KLYRO_BASE_URL = 'http://localhost:11434/v1';
    process.env.KLYRO_API_KEY = 'dummy';
    const a = buildProvider();
    expect(a.id).toBe('http-chat+retry');
  });
});
