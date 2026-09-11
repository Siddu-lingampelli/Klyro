import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

// We test the integrity-check logic by exercising checkForUpdate against a
// mocked global fetch. checkForUpdate hits `checkForUpdate(current)` and
// returns null when integrity doesn't match or when any step fails.

describe('update.ts — integrity gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Isolate the on-disk cache so tests never read each other's (or a real
    // ~/.klyro) update-cache.json — a fresh tmp cache per test.
    const tmp = os.tmpdir();
    const cp = path.join(tmp, `klyro-update-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    process.env.KLYRO_UPDATE_CACHE = cp;
  });

  it('returns null when integrity does not match', async () => {
    const packument = {
      version: '1.0.1',
      dist: {
        tarball: 'https://registry.npmjs.org/klyro/-/klyro-1.0.1.tgz',
        // deliberately wrong SRI so a genuine tarball never matches
        integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      },
    };
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: '1.0.1' }),
        } as unknown as Response;
      }
      if (url.includes('1.0.1')) {
        return {
          ok: true,
          status: 200,
          json: async () => packument,
          arrayBuffer: async () => new TextEncoder().encode('fake tarball bytes').buffer,
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });
    const { checkForUpdate } = await import('./update.js');
    const result = await checkForUpdate('0.0.0');
    expect(result).toBeNull(); // unverified tarball → never recommend install
  });

  it('accepts a tarball whose hash matches the registry SRI', async () => {
    const tarballBytes = new TextEncoder().encode('fake tarball bytes');
    // Precompute the real sha512 base64 so the mock check passes.
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha512').update(tarballBytes).digest('base64');
    const packument = {
      version: '1.0.1',
      dist: {
        tarball: 'https://registry.npmjs.org/klyro/-/klyro-1.0.1.tgz',
        integrity: `sha512-${digest}`,
      },
    };
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: '1.0.1' }),
        } as unknown as Response;
      }
      if (url.includes('1.0.1')) {
        return {
          ok: true,
          status: 200,
          json: async () => packument,
          arrayBuffer: async () => tarballBytes,
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });
    const { checkForUpdate } = await import('./update.js');
    const result = await checkForUpdate('0.0.0');
    expect(result).toBe('1.0.1');
  });
});