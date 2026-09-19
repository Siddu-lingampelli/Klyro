/**
 * Provider/legacy URL + transport contract (review P1).
 *
 * Every provider path (current `providers.ts`, legacy `chat.ts`/`repl.ts`,
 * custom `registerEndpoint`) shares ONE validation helper. These tests pin
 * that contract: fail-closed on remote plaintext, loopback/private allowed,
 * explicit opt-in honored, credentials never echoed in the refusal.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  assertSafeBaseURL,
  assertSafeRemoteURL,
  normalizeBaseURL,
  isLoopbackHost,
} from '../chat.js';
import { inferProviderId } from './endpoints.js';

afterEach(() => {
  delete process.env.KLYRO_ALLOW_INSECURE;
});

describe('provider URL contract', () => {
  it('accepts https everywhere', () => {
    expect(() => assertSafeBaseURL('https://api.openai.com/v1')).not.toThrow();
    expect(() => assertSafeRemoteURL('https://mcp.example.com/rpc')).not.toThrow();
  });

  it('accepts loopback http without opt-in', () => {
    for (const u of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:8080/v1']) {
      expect(() => assertSafeBaseURL(u)).not.toThrow();
      expect(() => assertSafeRemoteURL(u)).not.toThrow();
    }
  });

  it('accepts private-LAN http for providers, refuses it for MCP remotes', () => {
    expect(() => assertSafeBaseURL('http://192.168.1.50:11434/v1')).not.toThrow();
    expect(() => assertSafeRemoteURL('http://192.168.1.50/rpc')).toThrow();
  });

  it('refuses remote plaintext http fail-closed', () => {
    expect(() => assertSafeBaseURL('http://203.0.113.7:11434/v1')).toThrow();
    expect(() => assertSafeRemoteURL('http://203.0.113.7/rpc')).toThrow();
  });

  it('honors the explicit insecure opt-in on both paths', () => {
    process.env.KLYRO_ALLOW_INSECURE = '1';
    expect(() => assertSafeBaseURL('http://203.0.113.7:11434/v1')).not.toThrow();
    expect(() => assertSafeRemoteURL('http://203.0.113.7/rpc')).not.toThrow();
  });

  it('rejects malformed URLs and non-http schemes', () => {
    expect(() => assertSafeBaseURL('not a url')).toThrow();
    expect(() => assertSafeBaseURL('ftp://example.com/x')).toThrow();
    expect(() => assertSafeRemoteURL('file:///etc/passwd')).toThrow();
  });

  it('never echoes credentials in the refusal', () => {
    try {
      assertSafeBaseURL('http://user:s3cr3t-pw@203.0.113.7/v1');
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('s3cr3t-pw');
    }
  });

  it('normalizes and classifies consistently', () => {
    expect(normalizeBaseURL('https://x.example/v1///')).toBe('https://x.example/v1');
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.5')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(inferProviderId('https://api.openai.com/v1')).toBe('openai');
    expect(inferProviderId('https://api.anthropic.com/v1')).toBe('anthropic');
    expect(inferProviderId('https://unknown.example/v1')).toBeUndefined();
  });
});
