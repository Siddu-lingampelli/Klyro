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

/**
 * Process-control variables a repository `.env` must never set.
 *
 * `.env` ships WITH the repo, so it is untrusted content, and these keys do
 * not configure Klyro — they change how the OS and node execute every child
 * process Klyro spawns (MCP servers, hooks, verify commands, shell_exec),
 * because children inherit `process.env`:
 *   - `NODE_OPTIONS=--require ./evil.js` injects a module into every node child
 *   - `PATH`/`PATHEXT`/`LD_PRELOAD`/`DYLD_*` hijack which binary actually runs
 *   - `EDITOR`/`VISUAL`/`PAGER` turn `klyro config edit` into a shell execution
 *   - `npm_config_*` redirects package installs to another registry
 * Legitimate project config (KLYRO_*, provider keys, tool settings) is
 * unaffected — only the launcher/process-control namespace is refused.
 */
const BLOCKED_DOTENV_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SHELL',
  'SYSTEMROOT',
  'WINDIR',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'BASH_ENV',
  'PROMPT_COMMAND',
]);

/**
 * Klyro's own de-hardening switches. A repo may not loosen a security
 * boundary for the person who clones it: these are documented as explicit
 * user decisions (README "Environment"), so they are refused from `.env`
 * and must come from the real environment or ~/.klyro/settings.json.
 */
const BLOCKED_DOTENV_SECURITY_RELAXATIONS = new Set([
  'KLYRO_ALLOW_INSECURE',
  'KLYRO_CREDENTIALS_INSECURE_OK',
  'KLYRO_ALLOW_MAIN_PUSH',
  'KLYRO_YES',
  'KLYRO_WORKER',
]);

/** npm reads `npm_config_*` from the environment — a repo must not pick the registry. */
const BLOCKED_DOTENV_PREFIXES = ['NPM_CONFIG_'];

/** True when a `.env` key would change process behaviour or loosen a boundary. */
export function isBlockedDotenvKey(key: string): boolean {
  const k = key.toUpperCase();
  if (BLOCKED_DOTENV_KEYS.has(k)) return true;
  if (BLOCKED_DOTENV_SECURITY_RELAXATIONS.has(k)) return true;
  return BLOCKED_DOTENV_PREFIXES.some((p) => k.startsWith(p));
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
  const blocked: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (isBlockedDotenvKey(k)) {
      blocked.push(k);
      continue;
    }
    if (process.env[k] === undefined) {
      process.env[k] = v;
      loaded.push(k);
    }
  }
  if (blocked.length > 0) {
    try {
      process.stderr.write(
        `klyro: ignoring process-control vars in .env (${blocked.join(', ')}) — a repo's .env may not change how your shell, node, or editor runs\n`,
      );
    } catch { /* ignore */ }
  }
  return loaded;
}
