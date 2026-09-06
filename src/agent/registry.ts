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

/** Heuristic: hosts that look like Anthropic's API. */
function looksLikeAnthropic(host: string): boolean {
  return /(^|\.)anthropic\.com$/i.test(host) || /anthropic/i.test(host);
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

export function buildProvider(opts: BuildProviderOptions = {}): ProviderAdapter {
  const baseURL = opts.baseURL ?? process.env.KLYRO_BASE_URL;
  const apiKey = opts.apiKey ?? process.env.KLYRO_API_KEY;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // Resolve provider.
  let provider: ProviderName;
  if (opts.provider) {
    provider = opts.provider;
  } else if (process.env.KLYRO_PROVIDER === 'anthropic' || process.env.KLYRO_PROVIDER === 'openai') {
    provider = process.env.KLYRO_PROVIDER;
  } else {
    provider = inferProviderFromBaseURL(baseURL);
  }

  let inner: ProviderAdapter;
  if (provider === 'anthropic') {
    if (!apiKey) {
      throw new Error('buildProvider: anthropic provider requires an apiKey (or KLYRO_API_KEY).');
    }
    inner = anthropicAdapter({ baseURL, apiKey, timeoutMs });
  } else {
    if (!baseURL || !apiKey) {
      throw new Error('buildProvider: openai provider requires baseURL and apiKey (or KLYRO_BASE_URL + KLYRO_API_KEY).');
    }
    inner = httpChatAdapter({ baseURL, apiKey, timeoutMs });
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
  const provider = args.provider as ProviderName | undefined;
  if (provider && provider !== 'openai' && provider !== 'anthropic') {
    throw new Error(`unknown provider: ${provider}`);
  }
  return buildProvider({
    provider,
    baseURL: args.baseUrl,
    apiKey: args.apiKey,
    timeoutMs: args.timeoutMs,
  });
}
