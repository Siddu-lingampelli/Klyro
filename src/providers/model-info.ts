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

export function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const info = getModelInfo(modelId);
  return (inputTokens / 1000) * info.inputPricePer1k + (outputTokens / 1000) * info.outputPricePer1k;
}
