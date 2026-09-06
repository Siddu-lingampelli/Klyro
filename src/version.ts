/**
 * Single source of truth for the Klyro version (read from package.json).
 *
 * Every surface — `klyro --version`, the TUI header, `/version` — reads
 * through here, so a version bump in package.json shows up everywhere with
 * no hardcoded fallbacks rotting behind.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'package.json'),
    resolve(here, '../..', 'package.json'),
    resolve(here, '../../package.json'),
  ];
  for (const pkgPath of candidates) {
    try {
      const raw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Only ignore missing file; surface JSON parse errors
      if (e.code === 'ENOENT') continue;
      // Malformed JSON — warn but don't crash version output
      process.stderr.write(`klyro: warning: malformed ${pkgPath}: ${e.message}\n`);
      continue;
    }
  }
  // Fallback: try require-style resolution
  try {
    const pkgPath = resolve(process.cwd(), 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string; name?: string };
    if (pkg.name === 'klyro' && typeof pkg.version === 'string') return pkg.version;
  } catch {
    // ignore
  }
  return '0.0.0';
}
