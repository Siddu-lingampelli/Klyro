/** Tests for src/mcp/trust.ts — spec hashing + approval persistence. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashSpec, McpTrust } from './trust.js';
import type { McpServerSpec } from './config.js';

const specA: McpServerSpec = { command: 'node', args: ['a'], env: { K: 'v' } };

function tmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-mcp-trust-'));
  return path.join(dir, 'mcp-trust.json');
}

describe('hashSpec', () => {
  it('is stable across key order', () => {
    const reordered: McpServerSpec = { env: { K: 'v' }, args: ['a'], command: 'node' };
    expect(hashSpec(reordered)).toBe(hashSpec(specA));
  });

  it('changes when the spec changes', () => {
    expect(hashSpec({ ...specA, args: ['b'] })).not.toBe(hashSpec(specA));
  });

  it('returns a 64-char hex sha256', () => {
    expect(hashSpec(specA)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('McpTrust', () => {
  it('is untrusted until approved, then trusted for that hash only', () => {
    const trust = new McpTrust(tmpStore());
    const h = hashSpec(specA);
    expect(trust.isTrusted('srv', h)).toBe(false);
    trust.approve('srv', h);
    expect(trust.isTrusted('srv', h)).toBe(true);
    expect(trust.isTrusted('srv', hashSpec({ ...specA, command: 'other' }))).toBe(false);
    expect(trust.isTrusted('other-srv', h)).toBe(false);
  });

  it('persists approvals across instances', () => {
    const p = tmpStore();
    const h = hashSpec(specA);
    new McpTrust(p).approve('srv', h);
    expect(new McpTrust(p).isTrusted('srv', h)).toBe(true);
  });

  it('tolerates missing/corrupt store files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-mcp-trust-'));
    const bad = path.join(dir, 'mcp-trust.json');
    fs.writeFileSync(bad, 'not json{{{', 'utf-8');
    const trust = new McpTrust(bad);
    expect(trust.isTrusted('srv', 'x')).toBe(false);
  });
});
