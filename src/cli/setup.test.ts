/**
 * First-run setup: ask once, persist, never ask again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runFirstRunSetup } from './setup.js';

let dir: string;
let oldConfig: string | undefined;
let oldCreds: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-setup-'));
  oldConfig = process.env.KLYRO_CONFIG;
  oldCreds = process.env.KLYRO_CREDENTIALS_FILE;
  process.env.KLYRO_CONFIG = path.join(dir, 'settings.json');
  process.env.KLYRO_CREDENTIALS_FILE = path.join(dir, 'credentials.json');
});

afterEach(() => {
  if (oldConfig === undefined) delete process.env.KLYRO_CONFIG;
  else process.env.KLYRO_CONFIG = oldConfig;
  if (oldCreds === undefined) delete process.env.KLYRO_CREDENTIALS_FILE;
  else process.env.KLYRO_CREDENTIALS_FILE = oldCreds;
  fs.rmSync(dir, { recursive: true, force: true });
});

function asker(answers: string[]) {
  let i = 0;
  return async (_q: string): Promise<string> => answers[i++] ?? '';
}

describe('runFirstRunSetup', () => {
  it('saves openai-compatible settings + key (one-time setup)', async () => {
    const ans = await runFirstRunSetup(asker(['1', 'sk-test-123', '', '']));
    expect(ans).not.toBeNull();
    expect(ans!.provider).toBe('openai');
    expect(ans!.baseUrl).toBe('https://api.openai.com/v1');
    expect(ans!.model).toBe('gpt-4o-mini');
    expect(ans!.keySaved).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(process.env.KLYRO_CONFIG!, 'utf-8'));
    expect(cfg.baseUrl).toBe('https://api.openai.com/v1');
    expect(cfg.model).toBe('gpt-4o-mini');
    const creds = JSON.parse(fs.readFileSync(process.env.KLYRO_CREDENTIALS_FILE!, 'utf-8'));
    expect(creds.openai).toBe('sk-test-123');
  });

  it('saves anthropic with custom base URL + model', async () => {
    const ans = await runFirstRunSetup(
      asker(['2', 'sk-ant-x', 'https://proxy.example.com/v1', 'claude-x']),
    );
    expect(ans!.provider).toBe('anthropic');
    expect(ans!.baseUrl).toBe('https://proxy.example.com/v1');
    expect(ans!.model).toBe('claude-x');
  });

  it('local Ollama needs no key', async () => {
    const ans = await runFirstRunSetup(asker(['3', '', '', '']));
    expect(ans!.provider).toBe('openai');
    expect(ans!.baseUrl).toBe('http://localhost:11434/v1');
    expect(ans!.keySaved).toBe(false);
  });

  it('aborts on bad choice, missing key, or unsafe URL', async () => {
    expect(await runFirstRunSetup(asker(['9']))).toBeNull();
    expect(await runFirstRunSetup(asker(['1', '']))).toBeNull();
    expect(await runFirstRunSetup(asker(['1', 'sk-x', 'http://evil on host', 'm']))).toBeNull();
    // nothing persisted on abort
    expect(fs.existsSync(process.env.KLYRO_CONFIG!)).toBe(false);
  });

  it('plain-HTTP remote URL: explains, and persists opt-in on explicit yes', async () => {
    const ans = await runFirstRunSetup(
      asker(['1', 'sk-x', 'http://129.159.226.245:20128/v1', 'y', 'my-model']),
    );
    expect(ans).not.toBeNull();
    expect(ans!.baseUrl).toBe('http://129.159.226.245:20128/v1');
    const cfg = JSON.parse(fs.readFileSync(process.env.KLYRO_CONFIG!, 'utf-8'));
    expect(cfg.allowInsecure).toBe(true);
    expect(cfg.baseUrl).toBe('http://129.159.226.245:20128/v1');
    expect(cfg.model).toBe('my-model');
  });

  it('plain-HTTP remote URL: no means no (nothing saved)', async () => {
    expect(
      await runFirstRunSetup(asker(['1', 'sk-x', 'http://129.159.226.245:20128/v1', 'n'])),
    ).toBeNull();
    expect(fs.existsSync(process.env.KLYRO_CONFIG!)).toBe(false);
  });

  it('reuses an already-saved key instead of re-asking', async () => {
    fs.writeFileSync(process.env.KLYRO_CREDENTIALS_FILE!, JSON.stringify({ openai: 'sk-kept' }));
    const ans = await runFirstRunSetup(asker(['1', '', '', '']));
    expect(ans).not.toBeNull();
    expect(ans!.keySaved).toBe(true);
    const creds = JSON.parse(fs.readFileSync(process.env.KLYRO_CREDENTIALS_FILE!, 'utf-8'));
    expect(creds.openai).toBe('sk-kept'); // untouched
  });

  it('Ctrl+C aborts cleanly (no throw)', async () => {
    const aborting = async (_q: string): Promise<string> => {
      const err = new Error('Aborted with Ctrl+C');
      err.name = 'AbortError';
      throw err;
    };
    expect(await runFirstRunSetup(aborting)).toBeNull();
  });
});
