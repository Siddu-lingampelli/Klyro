/**
 * 2.2 — klyro login / logout / aliases
 * Stores masked key → ~/.klyro/credentials.json 0600
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export function credPath(): string {
  // KLYRO_CREDENTIALS_FILE override exists for tests; real users get ~/.klyro/credentials.json.
  if (process.env.KLYRO_CREDENTIALS_FILE) return process.env.KLYRO_CREDENTIALS_FILE;
  const home = os.homedir() || process.cwd();
  return path.join(home, '.klyro', 'credentials.json');
}

/** Persist one provider key (0600). Never logs or returns the key. */
export async function saveKey(provider: string, key: string): Promise<void> {
  const creds: Record<string, string> = {};
  try {
    const raw = await fs.readFile(credPath(), 'utf-8');
    Object.assign(creds, JSON.parse(raw));
  } catch { /* ignore */ }
  creds[provider] = key.trim();
  await fs.mkdir(path.dirname(credPath()), { recursive: true });
  await fs.writeFile(credPath(), JSON.stringify(creds, null, 2), { mode: 0o600 });
  try { await fs.chmod(credPath(), 0o600); } catch { /* ignore on Windows */ }
}

/** Which providers have stored keys (names only — never values). */
export function storedProviders(): string[] {
  try {
    const raw = fsSync.readFileSync(credPath(), 'utf-8');
    const creds = JSON.parse(raw) as Record<string, string>;
    return Object.keys(creds).filter((k) => typeof creds[k] === 'string' && creds[k].length > 0);
  } catch {
    return [];
  }
}

export const LOGIN_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-20240620' },
  local: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
};

/**
 * `klyro login` — full one-time setup. Persists provider + base URL + model
 * to ~/.klyro/settings.json and the key to ~/.klyro/credentials.json (0600),
 * so every future terminal picks them up with no env vars.
 */
export async function runLogin(): Promise<number> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const providerRaw = (await rl.question('Provider (openai/anthropic/local) [openai]: ')) || 'openai';
    const provider = providerRaw.trim().toLowerCase();
    const defs = LOGIN_DEFAULTS[provider] ?? LOGIN_DEFAULTS.openai!;
    const keyPrompt = provider === 'local' ? 'API key (empty for local Ollama): ' : 'API key (paste): ';
    const key = await rl.question(keyPrompt);
    if (!key.trim() && provider !== 'local') {
      process.stderr.write('No key provided\n');
      return 2;
    }
    const baseUrl = ((await rl.question(`Base URL [${defs.baseUrl}]: `)) || defs.baseUrl).trim();
    const model = ((await rl.question(`Model [${defs.model}]: `)) || defs.model).trim();
    const storeProvider = provider === 'local' ? 'openai' : provider;
    if (key.trim()) {
      await saveKey(storeProvider, key);
      process.stdout.write(`Saved ${storeProvider} key to ${credPath()} (0600)\n`);
    }
    // Persist non-secret settings (merged with existing config, never clobbers).
    const { loadConfig, saveConfig } = await import('./config.js');
    const cfg = await loadConfig();
    cfg.provider = storeProvider;
    cfg.baseUrl = baseUrl;
    cfg.model = model;
    await saveConfig(cfg);
    process.stdout.write(`Saved provider settings (applies to all terminals — no env vars needed)\n`);
    return 0;
  } finally {
    rl.close();
  }
}

export async function runLogout(provider?: string): Promise<number> {
  try {
    const raw = await fs.readFile(credPath(), 'utf-8');
    const creds = JSON.parse(raw) as Record<string, string>;
    if (provider) {
      delete creds[provider];
      await fs.writeFile(credPath(), JSON.stringify(creds, null, 2), 'utf-8');
      process.stdout.write(`Removed ${provider} key\n`);
    } else {
      await fs.unlink(credPath());
      process.stdout.write('Removed all credentials\n');
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`No credentials to remove: ${msg}\n`);
    return 1;
  }
}

export function getStoredKey(provider: string): string | undefined {
  try {
    const raw = fsSync.readFileSync(credPath(), 'utf-8');
    const creds = JSON.parse(raw) as Record<string, string>;
    const v = creds[provider];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

// Model aliases 2.2
export const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-3-5-sonnet-20240620',
  opus: 'claude-3-opus-20240229',
  haiku: 'claude-3-haiku-20240307',
  gpt: 'gpt-4o',
  local: 'llama3.2',
};

export function resolveAlias(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}
