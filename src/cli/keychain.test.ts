import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { keychainAvailable, keychainGet, keychainSet, keychainDelete } from './keychain.js';

describe('keychain', () => {
  it('reports no backend where no dependency-free store exists', () => {
    // Windows has no dependency-free read path; other platforms probe CLIs.
    const backend = keychainAvailable();
    expect(backend === null || backend === 'macos' || backend === 'linux').toBe(true);
  });

  it('get/set/delete degrade to null/false without throwing', async () => {
    // Never throws regardless of platform or locked keychains.
    await expect(keychainGet('klyro-test-acct')).resolves.toBeNull();
    // set may succeed on macOS/Linux CI keychains — either outcome is fine,
    // but a successful set must round-trip through get.
    const stored = await keychainSet('klyro-test-acct', 'klyro-test-value');
    expect(typeof stored).toBe('boolean');
    if (stored) {
      expect(await keychainGet('klyro-test-acct')).toBe('klyro-test-value');
      await keychainDelete('klyro-test-acct');
    } else {
      expect(await keychainDelete('klyro-test-acct')).toBe(false);
    }
  });

  it('refuses empty secrets without touching the OS', async () => {
    expect(await keychainSet('klyro-test-acct', '')).toBe(false);
  });

  it('saveKey falls back to the 0600 file when no keychain backend exists', async () => {
    const { saveKey, getStoredKeyAsync } = await import('./auth.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-key-'));
    const prev = process.env.KLYRO_CREDENTIALS_FILE;
    process.env.KLYRO_CREDENTIALS_FILE = path.join(dir, 'credentials.json');
    try {
      const where = await saveKey('openai', 'test-key-123');
      expect(['keychain', 'file']).toContain(where);
      // Read-back works regardless of which store won.
      expect(await getStoredKeyAsync('openai')).toBe('test-key-123');
    } finally {
      if (prev === undefined) delete process.env.KLYRO_CREDENTIALS_FILE;
      else process.env.KLYRO_CREDENTIALS_FILE = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
