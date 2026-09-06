/**
 * klyro update — check registry for newer version, cached 24h.
 * Env KLYRO_NO_UPDATE_CHECK=1 disables.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cachePath(): string {
  const home = os.homedir() || process.cwd();
  return path.join(home, '.klyro', 'update-cache.json');
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
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch('https://registry.npmjs.org/klyro/latest', { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    const latest = json.version ?? '';
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, JSON.stringify({ at: Date.now(), latest }), 'utf-8');
    if (latest && latest !== current) return latest;
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
      process.stdout.write(`Update available: ${cur} → ${latest}\n  npm i -g klyro@latest\n`);
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
