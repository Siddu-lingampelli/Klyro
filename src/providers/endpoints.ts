/**
 * Single provider registration point.
 *
 * Everything a new provider needs lives in ONE entry here:
 *   - default base URL + model (hosted) or probe URL (local)
 *   - wire protocol kind (OpenAI-compatible vs Anthropic)
 *   - key env vars for resolution
 *
 * Consumers:
 *   - `src/providers.ts` local-probe list + hosted defaults derive from this
 *   - `src/providers/model-info.ts` pricing stays model-keyed (unchanged)
 *   - `registerEndpoint()` allows programmatic/enterprise providers
 */
export type ProviderKind = 'openai-compatible' | 'anthropic';

export interface ProviderEndpoint {
  /** Stable id, e.g. 'openai', 'ollama'. Lowercase + dashes. */
  id: string;
  /** Human label for doctor/help output. */
  label: string;
  /** Wire protocol for adapter selection. */
  kind: ProviderKind;
  /** Default base URL (hosted) or probe URL (local). */
  baseURL: string;
  /** Model used when nothing else specifies one. */
  defaultModel: string;
  /** Local servers only: probed in order with `GET <base><probePath>`. */
  probePath?: string;
  /** Env vars tried (in order) for this provider's key. */
  apiKeyEnv?: string[];
}

const BUILTINS: ProviderEndpoint[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    apiKeyEnv: ['KLYRO_API_KEY', 'OPENAI_API_KEY'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-sonnet-20240620',
    apiKeyEnv: ['KLYRO_API_KEY', 'ANTHROPIC_API_KEY'],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    probePath: '/models',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'openai-compatible',
    baseURL: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    probePath: '/models',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    kind: 'openai-compatible',
    baseURL: 'http://localhost:8000/v1',
    defaultModel: 'meta-llama/Llama-3-8B-Instruct',
    probePath: '/models',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    kind: 'openai-compatible',
    baseURL: 'http://localhost:8080/v1',
    defaultModel: 'local-model',
    probePath: '/models',
  },
];

const custom = new Map<string, ProviderEndpoint>();

function validateEndpoint(def: ProviderEndpoint): void {
  if (!/^[a-z0-9-]{1,32}$/.test(def.id)) throw new Error(`invalid provider id "${def.id}"`);
  if (!def.baseURL || !def.defaultModel) throw new Error(`provider "${def.id}" needs baseURL + defaultModel`);
}

/** Register (or override) a provider endpoint programmatically. */
export function registerEndpoint(def: ProviderEndpoint): void {
  validateEndpoint(def);
  custom.set(def.id, def);
}

/** All endpoints: builtins with custom overrides applied. */
export function listEndpoints(): ProviderEndpoint[] {
  const byId = new Map<string, ProviderEndpoint>();
  for (const d of BUILTINS) byId.set(d.id, d);
  for (const [id, d] of custom) byId.set(id, d);
  return [...byId.values()];
}

/** Find one endpoint by id (custom wins). */
export function getEndpoint(id: string): ProviderEndpoint | undefined {
  return custom.get(id) ?? BUILTINS.find((d) => d.id === id);
}

/** Local-probe candidates in order (entries with probePath). */
export function localProbeEndpoints(): ProviderEndpoint[] {
  return listEndpoints().filter((d) => d.probePath !== undefined);
}

/**
 * Guess the provider id from a base URL (host matching). Returns undefined
 * for unknown hosts — callers treat that as generic OpenAI-compatible.
 */
export function inferProviderId(baseURL: string): string | undefined {
  let host = '';
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === 'api.openai.com') return 'openai';
  if (host === 'api.anthropic.com') return 'anthropic';
  for (const d of listEndpoints()) {
    try {
      if (new URL(d.baseURL).hostname.toLowerCase() === host && d.id !== 'openai' && d.id !== 'anthropic') return d.id;
    } catch { /* ignore */ }
  }
  return undefined;
}
