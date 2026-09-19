/**
 * P1 — MCP server-spec trust store (hash-based approval persistence).
 *
 * Companions the project-server consent gate in `registry.ts`: callers ask
 * the user to approve a project-sourced server once via
 * `approveProjectServer`, then persist `(name → sha256(spec))` here so later
 * runs can auto-approve unchanged specs. Any spec change (new hash) requires
 * fresh approval. Decisions persist in `~/.klyro/mcp-trust.json`.
 *
 * `registry.ts` does NOT use this class directly — callers compose it with
 * the `approveProjectServer` callback. This module is intentionally
 * side-effect free on import (file I/O happens in the constructor).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServerSpec } from './config.js';

export interface McpTrustRecord {
  sha256: string;
  trustedAt: number;
}

export type McpTrustStore = Record<string, McpTrustRecord>;

/** Deterministic JSON: object keys sorted recursively, arrays preserved. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** sha256 of the canonical (key-sorted) JSON encoding of a server spec. */
export function hashSpec(spec: McpServerSpec): string {
  return crypto.createHash('sha256').update(stableStringify(spec), 'utf-8').digest('hex');
}

export function defaultMcpTrustStorePath(): string {
  return path.join(os.homedir() || process.cwd(), '.klyro', 'mcp-trust.json');
}

export class McpTrust {
  private store: McpTrustStore = {};

  constructor(private readonly storePath: string = defaultMcpTrustStorePath()) {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.storePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.store = parsed as McpTrustStore;
      }
    } catch {
      this.store = {};
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      // Atomic trust write (tmp + rename) so a crash never leaves a
      // truncated mcp-trust.json that auto-approves the wrong spec.
      const tmp = `${this.storePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2), 'utf-8');
      try {
        const fh = fs.openSync(tmp, 'r+');
        try { fs.fsyncSync(fh); } finally { fs.closeSync(fh); }
      } catch { /* ignore on Windows */ }
      fs.renameSync(tmp, this.storePath);
    } catch {
      /* best-effort — trust stays in memory for the session */
    }
  }

  /** True only when `name` was approved for exactly this spec hash. */
  isTrusted(name: string, hash: string): boolean {
    const rec = this.store[name];
    return !!rec && rec.sha256 === hash;
  }

  /** Record approval of `name` for exactly this spec hash. */
  approve(name: string, hash: string): void {
    this.store[name] = { sha256: hash, trustedAt: Date.now() };
    this.save();
  }
}
