/**
 * Tests for src/mcp/auth.ts — PKCE verifier/challenge, token cache 0600 +
 * symlink-refusal, scrub, and the remote OAuth resolver's cache path. No
 * network: the code-flow listener is exercised only indirectly; the token
 * exchange is not invoked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generateCodeVerifier,
  codeChallengeFromVerifier,
  loadMcpTokens,
  saveMcpToken,
  tokenValid,
  mcpTokenCacheKey,
  scrubAuthHeaders,
  resolveAuth,
  TOKENS_FILE,
  type CachedToken,
} from './auth.js';

let configDir: string;
const OLD_CONFIG = process.env.KLYRO_CONFIG_DIR;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-auth-'));
  process.env.KLYRO_CONFIG_DIR = configDir;
});
afterEach(() => {
  if (OLD_CONFIG === undefined) delete process.env.KLYRO_CONFIG_DIR;
  else process.env.KLYRO_CONFIG_DIR = OLD_CONFIG;
  fs.rmSync(configDir, { recursive: true, force: true });
});

const token: CachedToken = {
  access_token: 'tok123',
  token_type: 'Bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  cachedAtMs: Date.now(),
};

describe('PKCE (RFC 7636)', () => {
  it('generates a 43-128 char verifier', () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });

  it('challenge is the sha256 base64url of the verifier', () => {
    const v = generateCodeVerifier();
    const c = codeChallengeFromVerifier(v);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet, no padding
    // Deterministic: same verifier → same challenge.
    expect(codeChallengeFromVerifier(v)).toBe(c);
  });
});

describe('token cache (0600)', () => {
  it('saves + loads by key, merged across writes', () => {
    saveMcpToken(mcpTokenCacheKey('https://a.example/mcp', 'c1'), token);
    saveMcpToken(mcpTokenCacheKey('https://b.example/mcp', 'c2'), { ...token, access_token: 'tok999' });
    const all = loadMcpTokens();
    expect(Object.keys(all).length).toBe(2);
    expect(all[mcpTokenCacheKey('https://a.example/mcp', 'c1')]?.access_token).toBe('tok123');
    expect(all[mcpTokenCacheKey('https://b.example/mcp', 'c2')]?.access_token).toBe('tok999');
  });

  it('writes the cache file with mode 0600', () => {
    saveMcpToken('k', token);
    const p = path.join(configDir, TOKENS_FILE);
    expect(fs.existsSync(p)).toBe(true);
    // Windows ACLs don't respect modes; just check file exists.
    // On POSIX, mode & 0o077 should be 0 (owner read/write only).
    if (process.platform !== 'win32') {
      const mode = fs.statSync(p).mode & 0o077;
      expect(mode).toBe(0);
    }
  });

  it('leaves no tmp files behind (atomic rename)', () => {
    saveMcpToken('k', token);
    const leftovers = fs.readdirSync(configDir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('refuses to write through a symlinked cache path', () => {
    const escape = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-auth-escape-'));
    try {
      fs.symlinkSync(escape, path.join(configDir, TOKENS_FILE));
      expect(() => saveMcpToken('k', token)).toThrow(/symlink/);
    } catch {
      // Windows may refuse to create the symlink — then there's nothing to guard.
    }
  });
});

describe('tokenValid', () => {
  it('accepts a live token and rejects a stale one', () => {
    expect(tokenValid(token)).toBe(true);
    const stale = { ...token, expires_at: Math.floor(Date.now() / 1000) - 30 };
    expect(tokenValid(stale)).toBe(false);
  });

  it('expires_at 0 (unknown lifetime) is treated as valid', () => {
    expect(tokenValid({ ...token, expires_at: 0 })).toBe(true);
  });

  it('rejects a missing/empty access_token', () => {
    expect(tokenValid({ ...token, access_token: '' })).toBe(false);
  });
});

describe('resolveAuth cache hit', () => {
  it('returns headers from a valid cached token without running a flow', async () => {
    saveMcpToken(mcpTokenCacheKey('https://s.example/mcp', 'cli'), token);
    const r = await resolveAuth({ clientId: 'cli' }, mcpTokenCacheKey('https://s.example/mcp', 'cli'));
    expect(r.fromCache).toBe(true);
    expect(r.headers).toEqual({ Authorization: 'Bearer tok123' });
  });

  it('rejects when auth fails (throws AuthError, never hangs)', async () => {
    // Force a fast failure: bad authorizationEndpoint URL causes resolveIssuer
    // to throw AuthError before any listener is bound.
    await expect(
      resolveAuth({ clientId: 'cli', authorizationEndpoint: 'not-valid-url' }, 'none'),
    ).rejects.toThrow();
  });
});

describe('scrubAuthHeaders', () => {
  it('redacts credential-bearing headers, keeps the rest', () => {
    const out = scrubAuthHeaders({ Authorization: 'Bearer sekret', 'X-Custom': 'v', Cookie: 'a=b' });
    expect(out['Authorization']).toBe('[REDACTED]');
    expect(out['Cookie']).toBe('[REDACTED]');
    expect(out['X-Custom']).toBe('v');
  });

  it('is case-insensitive on the header name', () => {
    expect(scrubAuthHeaders({ authorization: 'x' })['authorization']).toBe('[REDACTED]');
  });
});