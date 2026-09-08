import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextTrust, evaluateTrust, hashContent, loadTrustedKlyroMd } from './trust.js';
import type { KlyroEvent } from '../events/catalog.js';

const f = (p: string, content: string) => ({ path: p, content });

describe('evaluateTrust', () => {
  it('unknown files need approval; known hashes pass; changed hashes re-prompt', () => {
    const files = [f('/r/KLYRO.md', 'hello')];
    expect(evaluateTrust({}, files).untrusted[0]?.reason).toBe('unknown');
    const stored = { '/r/KLYRO.md': { sha256: hashContent('hello'), trustedAt: 1 } };
    expect(evaluateTrust(stored, files).trusted).toHaveLength(1);
    expect(evaluateTrust(stored, [f('/r/KLYRO.md', 'evil instructions')]).untrusted[0]?.reason).toBe('changed');
  });
});

describe('ContextTrust', () => {
  it('approve persists across instances via the store file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-trust-'));
    try {
      const store = path.join(dir, 'trust.json');
      const t1 = new ContextTrust(store);
      const file = f('/r/KLYRO.md', 'hello');
      expect(t1.isTrusted(file)).toBe(false);
      t1.approve(file);
      expect(t1.isTrusted(file)).toBe(true);
      const t2 = new ContextTrust(store);
      expect(t2.isTrusted(file)).toBe(true);
      expect(t2.isTrusted(f('/r/KLYRO.md', 'changed'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadTrustedKlyroMd', () => {
  it('excludes declined files, includes approved ones, emits trust_prompt events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-trust-md-'));
    try {
      fs.writeFileSync(path.join(dir, 'KLYRO.md'), 'project rules', 'utf-8');
      const events: KlyroEvent[] = [];
      const trust = new ContextTrust(path.join(dir, '.trust.json'));

      const declined = await loadTrustedKlyroMd(dir, {
        trust,
        approve: async () => false,
        emit: (ev) => { events.push(ev); },
      });
      const mdPath = path.join(dir, 'KLYRO.md');
      expect(declined).not.toContain('project rules');
      expect(events.filter((e) => e.type === 'context.trust_prompt' && e.path === mdPath)).toHaveLength(1);

      const approved = await loadTrustedKlyroMd(dir, {
        trust,
        approve: async () => true,
        emit: (ev) => { events.push(ev); },
      });
      expect(approved).toContain('project rules');

      // Second run: hash now known, no new prompt.
      const before = events.length;
      const again = await loadTrustedKlyroMd(dir, {
        trust,
        approve: async () => { throw new Error('must not be called'); },
        emit: (ev) => { events.push(ev); },
      });
      expect(again).toContain('project rules');
      expect(events.length).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
