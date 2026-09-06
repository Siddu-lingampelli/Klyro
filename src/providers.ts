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
  source: 'env' | 'config' | 'local-probe' | 'manual';
}

const LOCAL_ENDPOINTS: Array<{ name: string; baseURL: string; defaultModel: string }> = [
  { name: 'Ollama', baseURL: 'http://localhost:11434/v1', defaultModel: 'llama3.2' },
  { name: 'LM Studio', baseURL: 'http://localhost:1234/v1', defaultModel: 'local-model' },
  { name: 'vLLM', baseURL: 'http://localhost:8000/v1', defaultModel: 'meta-llama/Llama-3-8B-Instruct' },
  { name: 'llama.cpp', baseURL: 'http://localhost:8080/v1', defaultModel: 'local-model' },
];

/**
 * Resolve which provider to use. Does not throw; returns `null` if nothing
 * is reachable.
 *
 * Precedence (later lines are fallbacks, earlier wins):
 *   1. KLYRO_BASE_URL env (+ KLYRO_API_KEY / KLYRO_MODEL)
 *   2. Persisted config (~/.klyro/settings.json: baseUrl, provider, model,
 *      apiKey) + stored credentials (~/.klyro/credentials.json) — set once
 *      via `klyro login` or first-run setup, applies to ALL terminals.
 *   3. KLYRO_API_KEY env alone (OpenAI default)
 *   4. Stored credential keys alone (provider inferred from which key exists)
 *   5. Local endpoint probe (Ollama / LM Studio / vLLM / llama.cpp)
 */
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

  // Persisted config — the "set once, works in every terminal" layer.
  try {
    const { loadMergedConfig } = await import('./cli/config.js');
    const { getStoredKey } = await import('./cli/auth.js');
    const cfg = await loadMergedConfig(process.cwd(), {});
    const cfgBase = (cfg.baseUrl ?? cfg.baseURL) as string | undefined;
    const cfgProvider = cfg.provider as string | undefined;
    const cfgModel = (cfg.model ?? cfg['model.default']) as string | undefined;
    const cfgKey = (cfg.apiKey ?? cfg.api_key) as string | undefined;
    if (cfgBase) {
      assertSafeBaseURL(cfgBase);
      const key = envKey ?? cfgKey ?? getStoredKey(cfgProvider ?? 'openai') ?? getStoredKey('openai') ?? getStoredKey('anthropic') ?? '';
      return {
        baseURL: normalizeBaseURL(cfgBase),
        apiKey: key,
        model: envModel ?? cfgModel ?? 'gpt-4o-mini',
        source: 'config',
      };
    }
    if (cfgKey) {
      return {
        baseURL: normalizeBaseURL('https://api.openai.com/v1'),
        apiKey: cfgKey,
        model: envModel ?? cfgModel ?? 'gpt-4o-mini',
        source: 'config',
      };
    }
    // Stored keys alone (e.g. `klyro login` with defaults, or key-only setup).
    const anthropicKey = getStoredKey('anthropic');
    const openaiKey = getStoredKey('openai');
    if (cfgProvider === 'anthropic' && anthropicKey) {
      return {
        baseURL: normalizeBaseURL('https://api.anthropic.com/v1'),
        apiKey: anthropicKey,
        model: envModel ?? cfgModel ?? 'claude-3-5-sonnet-20240620',
        source: 'config',
      };
    }
    if (openaiKey) {
      return {
        baseURL: normalizeBaseURL('https://api.openai.com/v1'),
        apiKey: openaiKey,
        model: envModel ?? cfgModel ?? 'gpt-4o-mini',
        source: 'config',
      };
    }
    if (anthropicKey) {
      return {
        baseURL: normalizeBaseURL('https://api.anthropic.com/v1'),
        apiKey: anthropicKey,
        model: envModel ?? cfgModel ?? 'claude-3-5-sonnet-20240620',
        source: 'config',
      };
    }
  } catch { /* corrupted config must not break startup; probe below */ }

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
      try {
        const { loadMergedConfig } = await import('./cli/config.js');
        const cfg = await loadMergedConfig(process.cwd(), {});
        const cfgModel = (cfg.model ?? cfg['model.default']) as string | undefined;
        return {
          baseURL: ep.baseURL,
          apiKey: '',
          model: envModel ?? cfgModel ?? ep.defaultModel,
          source: 'local-probe',
        };
      } catch {
        return {
          baseURL: ep.baseURL,
          apiKey: '',
          model: envModel ?? ep.defaultModel,
          source: 'local-probe',
        };
      }
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
  if (p?.source === 'config') {
    return `(saved: ${p.baseURL}, model: ${p.model} — change via /provider /model or klyro config)`;
  }
  return `(no provider configured — run klyro login once, or set KLYRO_BASE_URL + KLYRO_API_KEY, or run a local server like Ollama)`;
}
