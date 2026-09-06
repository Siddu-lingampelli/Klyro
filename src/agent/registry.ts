/**
 * Provider registry — config-driven selection of ProviderAdapter.
 *
 * Two providers today:
 *   - "openai"  → OpenAI-compatible /v1/chat/completions (works with
 *                 OpenAI, Azure, Ollama, vLLM, LocalAI, OpenRouter,
 *                 Anthropic's OpenAI-compat endpoint, etc.)
 *   - "anthropic" → Anthropic's native /v1/messages streaming API
 *
 * Selection precedence (later overrides earlier):
 *   1. function arg (e.g. --provider CLI flag)
 *   2. KLYRO_PROVIDER env var
 *   3. inference from KLYRO_BASE_URL host (heuristic)
 *   4. default: "openai"
 *
 * The result is wrapped in retryingAdapter by default. Pass
 * { retry: false } to skip.
 */

import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderAdapter } from './provider-adapter.js';
import { httpChatAdapter } from './provider-adapter.js';
import { anthropicAdapter } from './anthropic-adapter.js';
import { retryingAdapter, type RetryOptions } from './retry.js';

export type ProviderName = 'openai' | 'anthropic';

export interface BuildProviderOptions {
  provider?: ProviderName;
  baseURL?: string;
  apiKey?: string;
  timeoutMs?: number;
  retry?: Partial<RetryOptions> | false;
}

/** Heuristic: hosts that look like Anthropic's API. Only matches anthropic.com and subdomains, not substring. */
function looksLikeAnthropic(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'anthropic.com' || h.endsWith('.anthropic.com');
}

export function inferProviderFromBaseURL(baseURL: string | undefined): ProviderName {
  if (!baseURL) return 'openai';
  try {
    const u = new URL(baseURL);
    return looksLikeAnthropic(u.hostname) ? 'anthropic' : 'openai';
  } catch {
    return 'openai';
  }
}

function isLoopbackBaseURL(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '::' || h.startsWith('127.');
  } catch {
    return false;
  }
}

const PROVIDER_ALIASES: Record<string, ProviderName> = {
  '9router': 'openai',
  'openrouter': 'openai',
  'groq': 'openai',
  'ollama': 'openai',
  'vllm': 'openai',
  'lmstudio': 'openai',
};

function normalizeProviderName(name: string | undefined): ProviderName | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase().trim();
  if (lower === 'openai' || lower === 'anthropic') return lower as ProviderName;
  return PROVIDER_ALIASES[lower];
}

/**
 * Persisted provider settings (sync read — for CLIs that must not go async).
 * Env still wins; ~/.klyro/settings.json + credentials are the fallback so
 * `klyro run` works in fresh terminals with zero env vars.
 *
 * Reads the files directly (no module imports) to avoid any import cycle
 * between agent/ and cli/ layers.
 */
function persistedProviderSettings(): { baseURL?: string; apiKey?: string; provider?: string; model?: string } {
  try {
    const home = process.env.KLYRO_CONFIG_DIR ?? (os.homedir() || process.cwd());
    const cfgPaths = process.env.KLYRO_CONFIG
      ? [process.env.KLYRO_CONFIG]
      : [path.join(home, '.klyro', 'settings.json'), path.join(home, '.klyro', 'config.json')];
    let cfg: Record<string, unknown> = {};
    for (const p of cfgPaths) {
      try {
        const parsed = JSON.parse(fsSync.readFileSync(p, 'utf-8')) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') {
          cfg = parsed;
          break;
        }
      } catch {
        continue;
      }
    }
    const credFile = process.env.KLYRO_CREDENTIALS_FILE ?? path.join(home, '.klyro', 'credentials.json');
    let creds: Record<string, string> = {};
    try {
      creds = JSON.parse(fsSync.readFileSync(credFile, 'utf-8')) as Record<string, string>;
    } catch { /* none */ }
    const keyOf = (p: string): string | undefined =>
      typeof creds[p] === 'string' && creds[p].length > 0 ? creds[p] : undefined;
    const baseURL = (cfg.baseUrl ?? cfg.baseURL) as string | undefined;
    const provider = cfg.provider as string | undefined;
    const model = (cfg.model ?? cfg['model.default']) as string | undefined;
    const apiKey =
      (cfg.apiKey ?? cfg.api_key) as string | undefined ??
      (provider ? keyOf(provider) : undefined) ??
      keyOf('openai') ??
      keyOf('anthropic');
    return { baseURL, apiKey, provider, model };
  } catch {
    return {};
  }
}

export function buildProvider(opts: BuildProviderOptions = {}): ProviderAdapter {
  const saved = persistedProviderSettings();
  const baseURL = opts.baseURL ?? process.env.KLYRO_BASE_URL ?? saved.baseURL;
  const apiKey = opts.apiKey ?? process.env.KLYRO_API_KEY ?? saved.apiKey;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // Resolve provider (with aliases like 9router -> openrouter -> openai)
  let provider: ProviderName;
  const normalizedOpt = normalizeProviderName(opts.provider);
  if (normalizedOpt) {
    provider = normalizedOpt;
  } else if (opts.provider) {
    // Fallback: treat any unknown as openai (OpenAI-compatible)
    provider = 'openai';
  } else {
    const envProvider = normalizeProviderName(process.env.KLYRO_PROVIDER);
    if (envProvider) provider = envProvider;
    else if (process.env.KLYRO_PROVIDER) {
      // Unknown provider string -> treat as openai
      provider = 'openai';
    } else provider = inferProviderFromBaseURL(baseURL);
  }

  let inner: ProviderAdapter;
  if (provider === 'anthropic') {
    if (!apiKey) {
      throw new Error('klyro: invalid --provider: anthropic requires an API key (set KLYRO_API_KEY or pass --api-key)');
    }
    inner = anthropicAdapter({ baseURL, apiKey, timeoutMs });
  } else {
    if (!baseURL) {
      throw new Error('klyro: invalid --provider: openai requires --base-url or KLYRO_BASE_URL');
    }
    // Allow empty apiKey for loopback local servers (Ollama etc.)
    if (!apiKey && !isLoopbackBaseURL(baseURL)) {
      throw new Error('klyro: invalid --provider: openai requires --api-key or KLYRO_API_KEY (or use a localhost URL for local models)');
    }
    inner = httpChatAdapter({ baseURL, apiKey: apiKey ?? '', timeoutMs });
  }

  if (opts.retry === false) return inner;
  return retryingAdapter(inner, opts.retry ?? {});
}

/**
 * Build the provider used by `klyro run` / `klyro chat` — honors --provider
 * flag, then KLYRO_PROVIDER env, then heuristic.
 *
 * This is the version called from CLI entry points.
 */
export function buildProviderFromCli(args: {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}): ProviderAdapter {
  const raw = args.provider?.toLowerCase().trim();
  const normalized = raw ? normalizeProviderName(raw) ?? (raw ? 'openai' as ProviderName : undefined) : undefined;
  const provider = normalized as ProviderName | undefined;
  // No longer throws for unknown — treat as openai (e.g. 9router, groq)
  if (raw && !normalized && raw !== 'openai' && raw !== 'anthropic') {
    // Silently treat as openai, but log hint
    process.stderr.write(`klyro: unknown provider "${raw}" — treating as openai-compatible\n`);
  }
  return buildProvider({
    provider,
    baseURL: args.baseUrl,
    apiKey: args.apiKey,
    timeoutMs: args.timeoutMs,
  });
}
