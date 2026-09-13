import { describe, it, expect } from 'vitest';
import { listEndpoints, getEndpoint, registerEndpoint, localProbeEndpoints, inferProviderId } from './endpoints.js';

describe('provider endpoints registry', () => {
  it('lists builtins incl. all four local servers', () => {
    const ids = listEndpoints().map((d) => d.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
    expect(localProbeEndpoints().map((d) => d.id)).toEqual(['ollama', 'lmstudio', 'vllm', 'llamacpp']);
  });

  it('registers and overrides programmatically', () => {
    registerEndpoint({ id: 'acme', label: 'Acme', kind: 'openai-compatible', baseURL: 'https://acme.example/v1', defaultModel: 'acme-1' });
    expect(getEndpoint('acme')?.label).toBe('Acme');
    expect(listEndpoints().some((d) => d.id === 'acme')).toBe(true);
    expect(() => registerEndpoint({ id: 'Bad Name!', label: 'x', kind: 'openai-compatible', baseURL: 'https://x', defaultModel: 'm' })).toThrow(/invalid provider id/);
  });

  it('infers provider from well-known hosts', () => {
    expect(inferProviderId('https://api.openai.com/v1')).toBe('openai');
    expect(inferProviderId('https://api.anthropic.com/v1')).toBe('anthropic');
    expect(inferProviderId('https://other.example/v1')).toBeUndefined();
    expect(inferProviderId('not a url')).toBeUndefined();
  });
});
