import { describe, it, expect } from 'vitest';
import {
  resolveAgentTools,
  resolveCapabilities,
  DEFAULT_WRITE_TOOLS,
  DEFAULT_SPAWN_TOOLS,
  DEFAULT_DENIED_TOOLS,
  type AgentCapabilities,
  type ResolveCapabilitiesInput,
} from './capabilities.js';

const REGISTRY = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'shell_exec',
  'grep',
  'glob',
  'spawn_agent',
  'run_verify',
]);

const POLICY = REGISTRY;

function baseInput(overrides: Partial<Parameters<typeof resolveAgentTools>[0]> = {}) {
  return {
    parentTools: REGISTRY, // root parent has all
    agent: {} as AgentCapabilities,
    policyAllowed: POLICY,
    registryTools: REGISTRY,
    writeTools: DEFAULT_WRITE_TOOLS,
    spawnTools: DEFAULT_SPAWN_TOOLS,
    denied: DEFAULT_DENIED_TOOLS,
    ...overrides,
  };
}

describe('resolveAgentTools', () => {
  it('returns full registry for root agent with no constraints', () => {
    const r = resolveAgentTools({
      ...baseInput({ parentTools: null }),
    });
    expect(r.allowed).toEqual([...REGISTRY].sort());
    expect(r.dropped).toEqual([]);
  });

  it('intersects parent tools — child cannot exceed parent', () => {
    const parent = new Set(['read_file', 'grep', 'glob']);
    const r = resolveAgentTools(baseInput({ parentTools: parent }));
    expect(r.allowed.sort()).toEqual(['glob', 'grep', 'read_file']);
    expect(r.dropped.filter((d) => d.reason === 'not-in-parent').map((d) => d.tool).sort())
      .toEqual(['edit_file', 'run_verify', 'shell_exec', 'spawn_agent', 'write_file']);
  });

  it('narrows by agent.allowedTools', () => {
    const r = resolveAgentTools(
      baseInput({ agent: { allowedTools: ['read_file', 'grep'] } }),
    );
    expect(r.allowed).toEqual(['grep', 'read_file']);
    expect(r.dropped.some((d) => d.tool === 'write_file')).toBe(true);
  });

  it('cannot grant a tool not in parent even if listed in allowedTools', () => {
    const parent = new Set(['read_file']);
    const r = resolveAgentTools(
      baseInput({
        parentTools: parent,
        agent: { allowedTools: ['read_file', 'shell_exec'] },
      }),
    );
    expect(r.allowed).toEqual(['read_file']);
  });

  it('readonly strips all write tools', () => {
    const r = resolveAgentTools(
      baseInput({ agent: { readonly: true } }),
    );
    expect(r.allowed.sort()).toEqual(['glob', 'grep', 'read_file', 'run_verify']);
    const droppedReadonly = r.dropped.filter((d) => d.reason === 'readonly').map((d) => d.tool).sort();
    expect(droppedReadonly).toEqual(['edit_file', 'shell_exec', 'write_file']);
  });

  it('canSpawn=false strips spawn tools (default for children)', () => {
    const r = resolveAgentTools(baseInput({ agent: { canSpawn: false } }));
    expect(r.allowed).not.toContain('spawn_agent');
  });

  it('canSpawn=true keeps spawn tools', () => {
    const r = resolveAgentTools(baseInput({ agent: { canSpawn: true } }));
    expect(r.allowed).toContain('spawn_agent');
  });

  it('denied always wins — even if listed in allowedTools', () => {
    const r = resolveAgentTools(
      baseInput({
        agent: { allowedTools: ['shell_exec'] },
        denied: new Set(['shell_exec']),
      }),
    );
    expect(r.allowed).not.toContain('shell_exec');
    expect(r.dropped.some((d) => d.tool === 'shell_exec' && d.reason === 'denied')).toBe(true);
  });

  it('drops unknown tools when they appear in parentTools or allowedTools', () => {
    const parent = new Set(['read_file', 'fake_tool']);
    const r = resolveAgentTools(
      baseInput({
        parentTools: parent,
        agent: { allowedTools: ['read_file', 'another_fake'] },
      }),
    );
    expect(r.allowed).toEqual(['read_file']);
  });

  it('respects policy narrower than parent', () => {
    const policy = new Set(['read_file', 'grep']); // grep allowed, glob not
    const r = resolveAgentTools(baseInput({ policyAllowed: policy }));
    expect(r.allowed.sort()).toEqual(['grep', 'read_file']);
    expect(r.dropped.some((d) => d.tool === 'glob' && d.reason === 'not-in-policy')).toBe(true);
  });

  it('readonly + canSpawn=false combines both restrictions', () => {
    const r = resolveAgentTools(
      baseInput({ agent: { readonly: true, canSpawn: false } }),
    );
    expect(r.allowed.sort()).toEqual(['glob', 'grep', 'read_file', 'run_verify']);
    expect(r.allowed).not.toContain('write_file');
    expect(r.allowed).not.toContain('spawn_agent');
  });

  it('returns a deterministic sorted output', () => {
    const r = resolveAgentTools(baseInput({ parentTools: new Set(['write_file', 'read_file', 'grep']) }));
    const sorted = [...r.allowed].sort();
    expect(r.allowed).toEqual(sorted);
  });
});

describe('resolveCapabilities', () => {
  const baseExtra = { maxDepth: 3 };

  function baseCap(overrides: Partial<AgentCapabilities> = {}, extra: Partial<typeof baseExtra> = {}) {
    return {
      ...baseInput({ agent: overrides }),
      ...baseExtra,
      ...extra,
    } satisfies ResolveCapabilitiesInput;
  }

  it('wraps resolveAgentTools and returns allowed as a Set', () => {
    const r = resolveCapabilities({ ...baseCap(), parentTools: null });
    expect(r.allowed).toBeInstanceOf(Set);
    expect([...r.allowed].sort()).toEqual([...REGISTRY].sort());
    expect(r.dropped).toEqual([]);
    expect(r.readonly).toBe(false);
    expect(r.canSpawn).toBe(false);
    expect(r.maxDepth).toBe(3);
  });

  it('propagates agent.model when set', () => {
    const r = resolveCapabilities(baseCap({ model: 'claude-haiku-4-5' }));
    expect(r.model).toBe('claude-haiku-4-5');
  });

  it('omits model when not declared on agent', () => {
    const r = resolveCapabilities(baseCap());
    expect(r.model).toBeUndefined();
  });

  it('agent.maxDepth wins over caller-supplied maxDepth', () => {
    const r = resolveCapabilities(baseCap({ maxDepth: 1 }, { maxDepth: 5 }));
    expect(r.maxDepth).toBe(1);
  });

  it('falls back to caller maxDepth when agent has none', () => {
    const r = resolveCapabilities(baseCap({}, { maxDepth: 4 }));
    expect(r.maxDepth).toBe(4);
  });

  it('canSpawnOverride=true forces canSpawn even when agent.canSpawn is false/unset', () => {
    const r = resolveCapabilities(baseCap({ canSpawn: false }, { canSpawnOverride: true }));
    expect(r.canSpawn).toBe(true);
    // The spawn tool should be present in the allowed set as a result.
    expect(r.allowed.has('spawn_agent')).toBe(true);
  });

  it('reflects readonly flag in resolved profile', () => {
    const r = resolveCapabilities(baseCap({ readonly: true }));
    expect(r.readonly).toBe(true);
    expect(r.allowed.has('write_file')).toBe(false);
  });
});
