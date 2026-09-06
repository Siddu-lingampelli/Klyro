/**
 * First-run setup — "set once, works in every terminal".
 *
 * When Klyro starts with no provider anywhere (no env, no saved config, no
 * stored keys, no local server), the TUI asks for provider details ONCE via
 * readline (stdin is free — the Ink App is not mounted yet), persists them
 * to ~/.klyro/settings.json + ~/.klyro/credentials.json (0600), and startup
 * continues. The next terminal never asks again; changes happen explicitly
 * via /provider, /model, `klyro login`, or `klyro config`.
 *
 * The `ask` callback is injected so this is unit-testable without a TTY.
 */

import { LOGIN_DEFAULTS, saveKey } from './auth.js';
import { loadConfig, saveConfig } from './config.js';
import { assertSafeBaseURL } from '../chat.js';

export interface SetupAnswers {
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  keySaved: boolean;
}

/**
 * Run the interactive setup. Returns answers, or null if the user aborted
 * (empty provider choice) — the caller should exit(2) in that case.
 */
export async function runFirstRunSetup(
  ask: (question: string) => Promise<string>,
): Promise<SetupAnswers | null> {
  const choiceRaw = await ask(
    'No provider configured (one-time setup — saved for all terminals).\nProvider [1=openai-compatible, 2=anthropic, 3=local Ollama] [1]: ',
  );
  const choice = choiceRaw.trim() || '1';
  if (choice !== '1' && choice !== '2' && choice !== '3') return null;
  const name = choice === '2' ? 'anthropic' : choice === '3' ? 'local' : 'openai';
  const defs = LOGIN_DEFAULTS[name] ?? LOGIN_DEFAULTS.openai!;

  const key = await ask(
    name === 'local' ? 'API key (empty = none needed for local): ' : 'API key (paste, stored 0600): ',
  );
  if (!key.trim() && name !== 'local') return null;

  const baseRaw = await ask(`Base URL [${defs.baseUrl}]: `);
  const baseUrl = (baseRaw.trim() || defs.baseUrl).trim();
  try {
    assertSafeBaseURL(baseUrl);
  } catch {
    return null;
  }
  const modelRaw = await ask(`Model [${defs.model}]: `);
  const model = (modelRaw.trim() || defs.model).trim();

  const storeProvider = name === 'local' ? 'openai' : name;
  if (key.trim()) await saveKey(storeProvider, key);
  const cfg = await loadConfig();
  cfg.provider = storeProvider;
  cfg.baseUrl = baseUrl;
  cfg.model = model;
  await saveConfig(cfg);
  return { provider: storeProvider as 'openai' | 'anthropic', baseUrl, model, keySaved: key.trim().length > 0 };
}
