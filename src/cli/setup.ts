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
 * Every abort path prints WHY (never a bare "aborted"). Ctrl+C is caught and
 * reported cleanly instead of dumping a stack.
 *
 * The `ask` callback is injected so this is unit-testable without a TTY.
 */

import { LOGIN_DEFAULTS, getStoredKey, saveKey } from './auth.js';
import { loadConfig, saveConfig } from './config.js';
import { assertSafeBaseURL } from '../chat.js';

export interface SetupAnswers {
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  keySaved: boolean;
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || /abort|cancel/i.test(err.message))
  );
}

/**
 * Validate a base URL, offering an explicit persisted opt-in for plain-HTTP
 * remote hosts. Returns the URL + whether to persist `allowInsecure: true`,
 * or null when the user declines. Never throws for policy rejections.
 */
export type AllowedURL =
  | { url: string; allowInsecure: boolean }
  | { declined: true }
  | null;

export async function ensureAllowedBaseURL(
  ask: (question: string) => Promise<string>,
  baseUrl: string,
): Promise<AllowedURL> {
  try {
    assertSafeBaseURL(baseUrl);
    return { url: baseUrl, allowInsecure: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/plaintext HTTP/.test(msg)) {
      process.stderr.write(`Unusable base URL: ${msg}\n`);
      return null; // malformed URL etc.
    }
    const host = (() => {
      try {
        return new URL(baseUrl).hostname;
      } catch {
        return baseUrl;
      }
    })();
    process.stderr.write(
      `Blocked: plain HTTP to ${host} would send your API key unencrypted.\n`,
    );
    const yn = await ask(`Allow plain HTTP to ${host} anyway? Only for hosts you trust. [y/N]: `);
    if (yn.trim().toLowerCase() === 'y' || yn.trim().toLowerCase() === 'yes') {
      return { url: baseUrl, allowInsecure: true };
    }
    return { declined: true };
  }
}

/**
 * Run the interactive setup. Returns answers, or null if the user aborted —
 * the reason is always printed here, so callers just exit(2).
 */
export async function runFirstRunSetup(
  ask: (question: string) => Promise<string>,
): Promise<SetupAnswers | null> {
  try {
    // Prefill from anything saved before (e.g. a `klyro login` that stored a
    // URL) so re-running setup is just Enter ×4.
    let existing: Record<string, unknown> = {};
    try {
      existing = await loadConfig();
    } catch { /* ignore */ }
    const choiceRaw = await ask(
      'No provider configured (one-time setup — saved for all terminals).\nProvider [1=openai-compatible, 2=anthropic, 3=local Ollama] [1]: ',
    );
    const choice = choiceRaw.trim() || '1';
    if (choice !== '1' && choice !== '2' && choice !== '3') {
      process.stderr.write('Setup aborted (expected 1, 2, or 3).\n');
      return null;
    }
    const name = choice === '2' ? 'anthropic' : choice === '3' ? 'local' : 'openai';
    const defs = LOGIN_DEFAULTS[name] ?? LOGIN_DEFAULTS.openai!;
    const storeProvider = name === 'local' ? 'openai' : name;

    // Reuse an already-saved key when present — don't make the user re-paste.
    const hasKey = !!getStoredKey(storeProvider);
    let key = '';
    if (hasKey) {
      const keep = await ask(`API key already saved for ${storeProvider} — keep it? [Y/n]: `);
      if (keep.trim().toLowerCase() !== 'n' && keep.trim().toLowerCase() !== 'no') {
        key = 'KEEP';
      }
    }
    if (!key) {
      key = await ask(
        name === 'local' ? 'API key (empty = none needed for local): ' : 'API key (paste, stored 0600): ',
      );
      if (!key.trim() && name !== 'local') {
        process.stderr.write('Setup aborted (no API key provided).\n');
        return null;
      }
    }

    const savedBase = typeof existing.baseUrl === 'string' ? existing.baseUrl : undefined;
    const baseRaw = await ask(`Base URL [${savedBase ?? defs.baseUrl}]: `);
    const baseUrl = (baseRaw.trim() || savedBase || defs.baseUrl).trim();
    const allowed = await ensureAllowedBaseURL(ask, baseUrl);
    if (!allowed || 'declined' in allowed) {
      process.stderr.write(
        'Setup aborted — use an https:// URL, or allow plain HTTP explicitly.\n',
      );
      return null;
    }

    const savedModel = typeof existing.model === 'string' ? existing.model : undefined;
    const modelRaw = await ask(`Model [${savedModel ?? defs.model}]: `);
    const model = (modelRaw.trim() || savedModel || defs.model).trim();

    if (key !== 'KEEP' && key.trim()) await saveKey(storeProvider, key);
    const cfg = await loadConfig();
    cfg.provider = storeProvider;
    cfg.baseUrl = allowed.url;
    cfg.model = model;
    if (allowed.allowInsecure) cfg.allowInsecure = true;
    await saveConfig(cfg);
    return {
      provider: storeProvider as 'openai' | 'anthropic',
      baseUrl: allowed.url,
      model,
      keySaved: key === 'KEEP' || key.trim().length > 0,
    };
  } catch (err) {
    if (isAbort(err)) {
      process.stderr.write('\nSetup cancelled — run `klyro login` when ready.\n');
      return null;
    }
    throw err;
  }
}
