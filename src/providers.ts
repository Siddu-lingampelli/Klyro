/**
 * Provider detection and configuration for the REPL.
 *
 * Supports any OpenAI-compatible `/chat/completions` endpoint. When no API
 * key is set, the REPL probes a list of well-known local servers (Ollama,
 * LM Studio, vLLM, llama.cpp) and uses whichever responds first.
 *
 * Resolution order:
 *   1. KLYRO_BASE_URL + KLYRO_API_KEY (full manual control)
 *   2. KLYRO_BASE_URL alone (assume local server, no auth)
 *   3. Auto-detect a local server
 *   4. Fall back to api.openai.com with a clear error if no key
 */

import { assertSafeBaseURL, normalizeBaseURL } from './chat.js';

export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  source: 'env' | 'local-probe' | 'manual';
}

const LOCAL_ENDPOINTS: Array<{ name: string; baseURL: string; defaultModel: string }> = [
  { name: 'Ollama', baseURL: 'http://localhost:11434/v1', defaultModel: 'llama3.2' },
  { name: 'LM Studio', baseURL: 'http://localhost:1234/v1', defaultModel: 'local-model' },
  { name: 'vLLM', baseURL: 'http://localhost:8000/v1', defaultModel: 'meta-llama/Llama-3-8B-Instruct' },
  { name: 'llama.cpp', baseURL: 'http://localhost:8080/v1', defaultModel: 'local-model' },
];

/** Resolve which provider to use. Does not throw; returns `null` if nothing is reachable. */
export async function resolveProvider(): Promise<ProviderConfig | null> {
  const envBaseURL = process.env.KLYRO_BASE_URL;
  const envKey = process.env.KLYRO_API_KEY;
  const envModel = process.env.KLYRO_MODEL;

  if (envBaseURL) {
    assertSafeBaseURL(envBaseURL);
    return {
      baseURL: normalizeBaseURL(envBaseURL),
      apiKey: envKey ?? '',
      model: envModel ?? 'gpt-4o-mini',
      source: 'env',
    };
  }

  if (envKey) {
    return {
      baseURL: normalizeBaseURL('https://api.openai.com/v1'),
      apiKey: envKey,
      model: envModel ?? 'gpt-4o-mini',
      source: 'manual',
    };
  }

  // Probe local endpoints
  for (const ep of LOCAL_ENDPOINTS) {
    if (await probeLocal(ep.baseURL)) {
      return {
        baseURL: ep.baseURL,
        apiKey: '',
        model: envModel ?? ep.defaultModel,
        source: 'local-probe',
      };
    }
  }
  return null;
}

/** Hit a cheap endpoint to check if a local server is up. */
async function probeLocal(baseURL: string): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 600);
  try {
    // Try the OpenAI-style /models endpoint; some servers (Ollama before load)
    // answer /, others only /v1/models.
    const res = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    clearTimeout(t);
    return false;
  }
}

/** Pretty-print a hint about how to configure the provider. */
export function providerHelp(p: ProviderConfig | null): string {
  if (p?.source === 'local-probe') {
    return `(connected to local ${p.baseURL}, model: ${p.model})`;
  }
  if (p?.source === 'env') {
    return `(env: ${p.baseURL}, model: ${p.model})`;
  }
  return `(no provider configured — set KLYRO_BASE_URL + KLYRO_API_KEY, or run a local server like Ollama)`;
}
