/**
 * 2.1 — ModelInfo registry: context window, max output, prices, capabilities.
 */

export interface ModelInfo {
  id: string;
  contextWindow: number;
  maxOutput: number;
  inputPricePer1k: number; // USD per 1k input tokens
  outputPricePer1k: number;
  capabilities: {
    thinking?: boolean;
    vision?: boolean;
    tools?: boolean;
  };
}

export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  'claude-3-5-sonnet-20240620': { id: 'claude-3-5-sonnet-20240620', contextWindow: 200000, maxOutput: 8192, inputPricePer1k: 0.003, outputPricePer1k: 0.015, capabilities: { thinking: true, vision: true, tools: true } },
  'claude-3-haiku-20240307': { id: 'claude-3-haiku-20240307', contextWindow: 200000, maxOutput: 4096, inputPricePer1k: 0.00025, outputPricePer1k: 0.00125, capabilities: { tools: true } },
  'gpt-4o': { id: 'gpt-4o', contextWindow: 128000, maxOutput: 4096, inputPricePer1k: 0.005, outputPricePer1k: 0.015, capabilities: { vision: true, tools: true } },
  'gpt-4o-mini': { id: 'gpt-4o-mini', contextWindow: 128000, maxOutput: 4096, inputPricePer1k: 0.00015, outputPricePer1k: 0.0006, capabilities: { tools: true } },
  'llama3.2': { id: 'llama3.2', contextWindow: 8192, maxOutput: 2048, inputPricePer1k: 0, outputPricePer1k: 0, capabilities: { tools: true } },
  'local-model': { id: 'local-model', contextWindow: 8192, maxOutput: 2048, inputPricePer1k: 0, outputPricePer1k: 0, capabilities: {} },
};

export function getModelInfo(id: string): ModelInfo {
  return MODEL_REGISTRY[id] ?? { id, contextWindow: 100000, maxOutput: 4096, inputPricePer1k: 0, outputPricePer1k: 0, capabilities: { tools: true } };
}

/**
 * CLI model aliases (2.2): short names resolving against the registry so
 * they never point at retired generations. Exact registry hits and unknown
 * ids pass through untouched (the provider reports those errors).
 */
const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-3-5-sonnet-20240620',
  // No opus generation is pinned in the registry; closest capable Claude.
  opus: 'claude-3-5-sonnet-20240620',
  haiku: 'claude-3-haiku-20240307',
  gpt: 'gpt-4o-mini',
  local: 'local-model',
};

export function resolveModelAlias(id: string): string {
  if (!id || MODEL_REGISTRY[id]) return id;
  const hit = MODEL_ALIASES[id.toLowerCase()];
  return hit ?? id;
}

/**
 * Single-source per-1K-token rate table, derived from MODEL_REGISTRY so
 * prices live in exactly one place. Local/self-hosted entries are $0.
 */
export const MODEL_RATES_PER_1K: Record<string, { input: number; output: number }> =
  Object.fromEntries(
    Object.entries(MODEL_REGISTRY).map(([k, v]) => [k, { input: v.inputPricePer1k, output: v.outputPricePer1k }]),
  );

/** Hosted-family fallback rates for model ids not in the registry. */
const FAMILY_RATES: ReadonlyArray<{ test: (model: string) => boolean; input: number; output: number }> = [
  { test: (m) => /o1/i.test(m), input: 0.015, output: 0.06 },
  { test: (m) => /gpt-3\.5/i.test(m), input: 0.0005, output: 0.0015 },
  { test: (m) => /gpt-4/i.test(m), input: 0.003, output: 0.015 },
  { test: (m) => /claude|anthropic/i.test(m), input: 0.003, output: 0.015 },
  { test: (m) => /gemini/i.test(m), input: 0.00075, output: 0.003 },
];

/** Local/self-hosted model ids are always priced at $0. */
const LOCAL_MODEL_PATTERN = /local|ollama|llama|mistral|mixtral|qwen|gemma|phi-|vllm|llama\.cpp|^mock/i;

/**
 * Resolve per-1K rates for any model id. Exact registry hits win, then the
 * local-model check ($0), then hosted-family fallbacks. Unknown models are
 * $0 — never invent nonzero prices for models we don't recognize.
 */
export function ratesFor(modelId: string): { input: number; output: number } {
  const exact = MODEL_RATES_PER_1K[modelId];
  if (exact) return exact;
  if (LOCAL_MODEL_PATTERN.test(modelId)) return { input: 0, output: 0 };
  const fam = FAMILY_RATES.find((r) => r.test(modelId));
  if (fam) return { input: fam.input, output: fam.output };
  return { input: 0, output: 0 };
}

/**
 * True for Anthropic-family model ids (Claude). Used by the runtime's
 * cache-aware cost math: only Anthropic bills cacheRead/cacheWrite, so
 * other families keep ignoring those counters.
 */
export function isAnthropicModel(modelId: string): boolean {
  return /anthropic|claude/i.test(modelId);
}

export function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  // Single source: delegate to ratesFor so registry, family fallbacks, and
  // local-$0 rules live in exactly one place (no split-brain with getModelInfo).
  const { input, output } = ratesFor(modelId);
  return (inputTokens / 1000) * input + (outputTokens / 1000) * output;
}
