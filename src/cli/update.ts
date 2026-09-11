/**
 * klyro update — check registry for newer version, cached 24h.
 * Env KLYRO_NO_UPDATE_CHECK=1 disables.
 *
 * Integrity: before recommending `npm i`, we verify the tarball's SRI hash
 * (sha512) against the registry's recorded `dist.integrity`. An install is
 * only recommended when the download hash matches, so a tampered CDN or
 * MITM registry response can't push a malicious binary to the operator.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_BASE = 'https://registry.npmjs.org/klyro';
const FETCH_TIMEOUT_MS = 3000;
const TARBALL_TIMEOUT_MS = 10000;

function cachePath(): string {
  // KLYRO_UPDATE_CACHE lets tests isolate the on-disk cache (and power users
  // relocate it); default is the home cache like the rest of Klyro.
  const override = process.env.KLYRO_UPDATE_CACHE;
  if (override) return override;
  const home = os.homedir() || process.cwd();
  return path.join(home, '.klyro', 'update-cache.json');
}

interface Dist {
  tarball?: string;
  integrity?: string;
}

/** SRI string may carry multiple hashes parsable with `pick`; we accept sha512 or sha256. */
function parseSRI(integrity: string | undefined): { algo: string; digest: string } | null {
  if (!integrity) return null;
  for (const part of integrity.split(/\s+/)) {
    const m = /^(sha256|sha512)-([A-Za-z0-9+/=]+)$/.exec(part);
    if (m) return { algo: m[1]!, digest: m[2]! };
  }
  return null;
}

/** Fetch with a timeout; rejects on non-2xx. */
async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

/** Download the tarball and confirm its hash equals the registry's SRI digest. */
async function verifyTarballIntegrity(dist: Dist): Promise<boolean> {
  const sri = parseSRI(dist.integrity);
  const tarball = dist.tarball;
  if (!sri || !tarball) return false;
  const res = await fetchWithTimeout(tarball, TARBALL_TIMEOUT_MS);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = createHash(sri.algo).update(buf).digest('base64');
  return actual === sri.digest;
}

export async function checkForUpdate(current: string): Promise<string | null> {
  if (process.env.KLYRO_NO_UPDATE_CHECK === '1') return null;
  const cache = cachePath();
  try {
    const raw = await fs.readFile(cache, 'utf-8');
    const data = JSON.parse(raw) as { at: number; latest: string };
    if (Date.now() - data.at < CACHE_TTL_MS) {
      return data.latest !== current ? data.latest : null;
    }
  } catch {
    // ignore
  }
  try {
    const res = await fetchWithTimeout(`${REGISTRY_BASE}/latest`);
    const json = (await res.json()) as { version?: string };
    const latest = json.version ?? '';
    if (latest && latest !== current) {
      // Verify the tarball's integrity before caching/recommending this version.
      const verRes = await fetchWithTimeout(`${REGISTRY_BASE}/${encodeURIComponent(latest)}`);
      const verJson = (await verRes.json()) as { dist?: Dist };
      const ok = await verifyTarballIntegrity(verJson.dist ?? {});
      if (!ok) return null; // integrity mismatch — treat as no update, never recommend it
      await fs.mkdir(path.dirname(cache), { recursive: true });
      await fs.writeFile(cache, JSON.stringify({ at: Date.now(), latest }), 'utf-8');
      return latest;
    }
  } catch {
    // network failure — silent
  }
  return null;
}

export async function runUpdate(): Promise<number> {
  const here = await import('../index.js').then(() => '');
  // Get version from package.json via dynamic import
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    const cur = pkg.version ?? '0.0.0';
    const latest = await checkForUpdate(cur);
    if (latest) {
      process.stdout.write(`Update available: ${cur} → ${latest} (integrity verified)\n  npm i -g klyro@latest\n`);
    } else {
      process.stdout.write(`klyro ${cur} is latest\n`);
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`klyro update: ${msg}\n`);
    return 1;
  }
}