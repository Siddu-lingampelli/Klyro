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

  it('accepts a tarball whose hash matches the registry SRI', async () => {    const tarballBytes = new TextEncoder().encode('fake tarball bytes');
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

  it('never recommends a registry latest older than current (downgrade protection)', async () => {
    let versionFetches = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('latest')) {
        return { ok: true, status: 200, json: async () => ({ version: '1.0.0' }) } as unknown as Response;
      }
      versionFetches++;
      return { ok: false, status: 404 } as unknown as Response;
    });
    const { checkForUpdate } = await import('./update.js');
    const result = await checkForUpdate('1.0.4');
    expect(result).toBeNull();
    expect(versionFetches).toBe(0); // tarball never even fetched
  });

  it.each(['latest', 'next', '1.0.4 & calc.exe', ''])(
    'treats non-semver registry latest %p as no update (no tarball fetch, no install string)',
    async (version) => {
      let versionFetches = 0;
      vi.stubGlobal('fetch', async (url: string) => {
        if (url.endsWith('/latest') || url.includes('/latest')) {
          return { ok: true, status: 200, json: async () => ({ version }) } as unknown as Response;
        }
        versionFetches++;
        return { ok: false, status: 404 } as unknown as Response;
      });
      const { checkForUpdate } = await import('./update.js');
      expect(await checkForUpdate('1.0.4')).toBeNull();
      expect(versionFetches).toBe(0);
    },
  );

  it('rejects when shasum disagrees even if SRI matches', async () => {
    const tarballBytes = new TextEncoder().encode('fake tarball bytes');
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha512').update(tarballBytes).digest('base64');
    const packument = {
      version: '1.0.1',
      dist: {
        tarball: 'https://registry.npmjs.org/klyro/-/klyro-1.0.1.tgz',
        integrity: `sha512-${digest}`,
        shasum: 'da39a3ee5e6b4b0d3255bfef95601890afd80709', // wrong sha1
      },
    };
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('latest')) {
        return { ok: true, status: 200, json: async () => ({ version: '1.0.1' }) } as unknown as Response;
      }
      if (url.includes('1.0.1')) {
        return {
          ok: true, status: 200,
          json: async () => packument,
          arrayBuffer: async () => tarballBytes,
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });
    const { checkForUpdate } = await import('./update.js');
    expect(await checkForUpdate('0.0.0')).toBeNull();
  });

  it('compareSemver orders triples and prereleases', async () => {
    const { compareSemver } = await import('./update.js');
    expect(compareSemver('1.0.4', '1.0.3')).toBe(1);
    expect(compareSemver('1.0.3', '1.0.4')).toBe(-1);
    expect(compareSemver('1.0.4', '1.0.4')).toBe(0);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.0.4-beta', '1.0.4')).toBe(-1);
    expect(compareSemver('garbage', '1.0.0')).toBeNull();
  });

  it('stays silent in CI unless explicitly enabled (1.5)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('must not fetch in CI');
    });
    vi.stubGlobal('fetch', fetchMock);
    const savedCI = process.env.CI;
    const savedActions = process.env.GITHUB_ACTIONS;
    const savedOptIn = process.env.KLYRO_UPDATE_CHECK;
    try {
      process.env.CI = 'true';
      delete process.env.KLYRO_UPDATE_CHECK;
      const { checkForUpdate } = await import('./update.js');
      expect(await checkForUpdate('1.0.0')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (savedCI === undefined) delete process.env.CI;
      else process.env.CI = savedCI;
      if (savedActions === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = savedActions;
      if (savedOptIn === undefined) delete process.env.KLYRO_UPDATE_CHECK;
      else process.env.KLYRO_UPDATE_CHECK = savedOptIn;
    }
  });
});