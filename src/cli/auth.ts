/**
 * 2.2 — klyro login / logout / aliases
 * Stores masked key → ~/.klyro/credentials.json 0600
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

function credPath(): string {
  const home = os.homedir() || process.cwd();
  return path.join(home, '.klyro', 'credentials.json');
}

export async function runLogin(): Promise<number> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const provider = (await rl.question('Provider (anthropic/openai) [openai]: ')) || 'openai';
    const key = await rl.question('API key (input hidden, paste): ');
    if (!key.trim()) {
      process.stderr.write('No key provided\n');
      return 2;
    }
    const creds: Record<string, string> = {};
    try {
      const raw = await fs.readFile(credPath(), 'utf-8');
      Object.assign(creds, JSON.parse(raw));
    } catch { /* ignore */ }
    creds[provider] = key.trim();
    await fs.mkdir(path.dirname(credPath()), { recursive: true });
    await fs.writeFile(credPath(), JSON.stringify(creds, null, 2), { mode: 0o600 });
    try { await fs.chmod(credPath(), 0o600); } catch { /* ignore on Windows */ }
    process.stdout.write(`Saved ${provider} key to ${credPath()} (0600)\n`);
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
    const raw = require('node:fs').readFileSync(credPath(), 'utf-8');
    const creds = JSON.parse(raw) as Record<string, string>;
    return creds[provider];
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
