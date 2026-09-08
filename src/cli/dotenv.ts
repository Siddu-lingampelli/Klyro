/**
 * P0.5 — `.env` auto-load (r-11-17.md).
 *
 * Loads `<cwd>/.env` at startup so `KLYRO_API_KEY` etc. work without `export`.
 * Rules:
 * - Never overwrites an already-set variable (explicit env wins).
 * - Only `KEY=VALUE` lines; `#` comments and `export ` prefixes tolerated.
 * - Single/double quotes stripped; missing file is a no-op (never throws).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = body.slice(eq + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    // Strip trailing inline comments on unquoted values.
    if (!body.slice(eq + 1).trim().startsWith('"') && !body.slice(eq + 1).trim().startsWith("'")) {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trimEnd();
    }
    out[key] = val;
  }
  return out;
}

/** Load `<cwd>/.env` into `process.env` (no-clobber). Returns loaded keys. */
export function loadDotenv(cwd: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cwd, '.env'), 'utf-8');
  } catch {
    return [];
  }
  const parsed = parseDotenv(text);
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      loaded.push(k);
    }
  }
  return loaded;
}
