/**
 * klyro update — check registry for newer version, cached 24h.
 * Env KLYRO_NO_UPDATE_CHECK=1 disables.
 *
 * Integrity: before recommending `npm i`, we verify the tarball against
 * BOTH the registry's SRI digest (sha512/sha256) AND the legacy sha1
 * `dist.shasum` when present — a tampered CDN or MITM registry response
 * must forge two independent digests to push a malicious binary.
 * Downgrade protection: a registry `latest` that is not strictly newer
 * than the running version (semver) is never recommended.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { proxiedFetch } from '../shared/proxy.js';

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
  /** Legacy sha1 hex digest — second independent check when present. */
  shasum?: string;
}

/** Minimal semver compare for `x.y.z[-prerelease]`; null when unparseable. */
export function compareSemver(a: string, b: string): number | null {
  const pa = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(a.trim());
  const pb = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(b.trim());
  if (!pa || !pb) return null;
  for (const i of [1, 2, 3] as const) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const ra = pa[4] ?? '';
  const rb = pb[4] ?? '';
  if (ra === rb) return 0;
  // A prerelease is older than the release with the same core.
  if (ra === '') return 1;
  if (rb === '') return -1;
  return ra < rb ? -1 : 1;
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
    const res = await proxiedFetch(url, { signal: ctrl.signal, timeoutMs });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

/** Download the tarball and confirm it matches the registry's SRI digest AND shasum. */
async function verifyTarballIntegrity(dist: Dist): Promise<boolean> {
  const sri = parseSRI(dist.integrity);
  const tarball = dist.tarball;
  if (!sri || !tarball) return false;
  const res = await fetchWithTimeout(tarball, TARBALL_TIMEOUT_MS);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = createHash(sri.algo).update(buf).digest('base64');
  if (actual !== sri.digest) return false;
  // Second independent digest: legacy sha1 shasum, when the registry sends one.
  if (typeof dist.shasum === 'string' && /^[0-9a-f]{40}$/i.test(dist.shasum)) {
    const sha1 = createHash('sha1').update(buf).digest('hex');
    if (sha1.toLowerCase() !== dist.shasum.toLowerCase()) return false;
  }
  return true;
}

export async function checkForUpdate(current: string): Promise<string | null> {
  if (process.env.KLYRO_NO_UPDATE_CHECK === '1') return null;
  // Disabled in CI unless explicitly enabled (1.5): automated pipelines
  // must never phone home or suggest interactive updates.
  if ((process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') && process.env.KLYRO_UPDATE_CHECK !== '1') {
    return null;
  }
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
    // Downgrade protection: only ever recommend a strictly newer version.
    // A registry answering with an older-or-equal `latest` (stale mirror,
    // cache poisoning, downgrade attack) — or a non-semver tag like
    // "latest"/"next" (which would otherwise flow into `npm i -g klyro@…`)
    // — is treated as "no update".
    const cmp = compareSemver(latest, current);
    const isNewer = cmp !== null && cmp > 0;
    if (latest && isNewer) {
      // Verify the tarball's integrity before caching/recommending this version.
      const verRes = await fetchWithTimeout(`${REGISTRY_BASE}/${encodeURIComponent(latest)}`);
      const verJson = (await verRes.json()) as { dist?: Dist };
      const ok = await verifyTarballIntegrity(verJson.dist ?? {});
      if (!ok) return null; // integrity mismatch — treat as no update, never recommend it
      await fs.mkdir(path.dirname(cache), { recursive: true });
      await fs.writeFile(cache, JSON.stringify({ at: Date.now(), latest }), 'utf-8');
      return latest;
    }
    if (latest && (cmp === null || cmp <= 0)) {
      // Refresh the negative cache so a poisoned or non-semver answer isn't
      // re-fetched every invocation for the next 24h.
      await fs.mkdir(path.dirname(cache), { recursive: true }).catch(() => undefined);
      await fs.writeFile(cache, JSON.stringify({ at: Date.now(), latest: current }), 'utf-8').catch(() => undefined);
    }
  } catch {
    // network failure — silent
  }
  return null;
}

export async function runUpdate(opts: { apply?: boolean } = {}): Promise<number> {
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
      if (opts.apply) {
        // Defense in depth: the version string flows into a child process
        // (with shell:true on Windows), so re-validate strict semver here
        // even though checkForUpdate already gates on it. A non-semver
        // string (registry compromise, cache tampering) must never reach
        // the shell.
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest)) {
          process.stderr.write(`klyro update: refusing to install non-semver version: ${latest}\n`);
          return 1;
        }
        // Opt-in self-apply: the tarball was already hash-verified by
        // checkForUpdate, so npm installs exactly the verified version.
        process.stdout.write(`Applying update to klyro@${latest}...\n`);
        const { spawnSync } = await import('node:child_process');
        const npmCli = process.env['npm_execpath'];
        const r = npmCli
          ? spawnSync(process.execPath, [npmCli, 'i', '-g', `klyro@${latest}`], { stdio: 'inherit' })
          : spawnSync('npm', ['i', '-g', `klyro@${latest}`], { stdio: 'inherit', shell: process.platform === 'win32' });
        if (r.error) {
          process.stderr.write(`klyro update: apply failed: ${r.error.message}\n`);
          return 1;
        }
        return r.status === 0 ? 0 : 1;
      }
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