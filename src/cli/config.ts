/**
 * LEVEL 1 — klyro config (1.3)
 * Precedence: flags → env → .klyro/settings.local.json → .klyro/settings.json → ~/.klyro/settings.json → defaults
 * JSONC-tolerant, Zod schema, exit 3 on invalid.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { KlyroError } from '../shared/errors.js';

// --- Zod schema (Appendix A shape, L1 keys active, passthrough for future) ---
export const ConfigSchema = z
  .object({
    model: z.string().optional(),
    provider: z.enum(['openai', 'anthropic']).optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    // Persisted opt-in for plain-HTTP remote endpoints (set once via setup /
    // login confirmation — replaces per-terminal KLYRO_ALLOW_INSECURE=1).
    allowInsecure: z.boolean().optional(),
    baseURL: z.string().optional(),
    api_key: z.string().optional(),
    // Global flags persisted
    'model.default': z.string().optional(),
    'model.small': z.string().optional(),
    // Provider failover chain (L15): ordered fallbacks after the primary.
    // Optional so existing configs keep validating; invalid entries exit 3.
    providers: z
      .object({
        failover: z
          .array(
            z.object({
              provider: z.enum(['openai', 'anthropic']),
              baseURL: z.string().optional(),
              apiKey: z.string().optional(),
              apiKeyEnv: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  })
  .passthrough();

export type KlyroConfig = z.infer<typeof ConfigSchema>;

// --- Provider failover chain (L15 differentiator) ---
// `providers.failover` is an ordered list of fallback providers. Entries
// with unresolvable/missing API keys are skipped at chain-build time.
export const FailoverEntrySchema = z.object({
  provider: z.enum(['openai', 'anthropic']),
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});

export type FailoverEntry = z.infer<typeof FailoverEntrySchema>;

export const FailoverConfigSchema = z.object({
  failover: z.array(FailoverEntrySchema).optional(),
});

export interface ResolvedProviderEntry {
  provider: 'openai' | 'anthropic';
  baseURL?: string;
  apiKey?: string;
}

/**
 * Build the ordered provider chain: primary (existing precedence:
 * flags > env > merged config > defaults) followed by `providers.failover`
 * entries. `apiKeyEnv` names an env var resolved at build time; entries
 * whose key is missing/empty are skipped (with a stderr reason) so a
 * half-configured fallback can never become the active provider.
 */
export async function resolveProviderChain(cwd = process.cwd(), flags: Record<string, unknown> = {}): Promise<ResolvedProviderEntry[]> {
  const merged = await loadMergedConfig(cwd, flags);
  const chain: ResolvedProviderEntry[] = [];
  const skipped: string[] = [];

  // Primary — mirror the precedence resolveProvider uses: explicit flags,
  // then KLYRO_* env, then merged config.
  const flagProvider = typeof flags['provider'] === 'string' ? (flags['provider'] as string) : undefined;
  const flagBaseUrl = typeof flags['baseUrl'] === 'string' ? (flags['baseUrl'] as string) : typeof flags['baseURL'] === 'string' ? (flags['baseURL'] as string) : undefined;
  const flagApiKey = typeof flags['apiKey'] === 'string' ? (flags['apiKey'] as string) : undefined;
  const primaryProvider = (flagProvider ?? (merged.provider as string | undefined) ?? process.env.KLYRO_PROVIDER ?? 'openai') as 'openai' | 'anthropic';
  const primaryBaseURL = flagBaseUrl ?? (merged.baseUrl as string | undefined) ?? (merged.baseURL as string | undefined) ?? process.env.KLYRO_BASE_URL;
  const primaryApiKey = flagApiKey ?? (merged.apiKey as string | undefined) ?? (merged.api_key as string | undefined) ?? process.env.KLYRO_API_KEY;
  if (primaryProvider === 'openai' || primaryProvider === 'anthropic') {
    chain.push({
      provider: primaryProvider,
      ...(primaryBaseURL ? { baseURL: primaryBaseURL } : {}),
      ...(primaryApiKey ? { apiKey: primaryApiKey } : {}),
    });
  }

  // Failover list — validated leniently (invalid entries skipped, never fatal).
  const providersRaw = merged.providers as unknown;
  const parsed = FailoverConfigSchema.safeParse(providersRaw ?? {});
  if (parsed.success && parsed.data.failover) {
    for (const entry of parsed.data.failover) {
      let key = entry.apiKey;
      if (!key && entry.apiKeyEnv) {
        const v = process.env[entry.apiKeyEnv];
        if (v && v.length > 0) key = v;
      }
      if (!key) {
        skipped.push(`failover ${entry.provider}${entry.apiKeyEnv ? ` (env ${entry.apiKeyEnv} unset)` : ' (no apiKey)'}`);
        continue;
      }
      chain.push({
        provider: entry.provider,
        ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
        apiKey: key,
      });
    }
  }
  for (const reason of skipped) {
    try { process.stderr.write(`klyro: skipping failover entry — ${reason}\n`); } catch { /* ignore */ }
  }
  return chain;
}

// --- Paths ---
export function getConfigDir(): string {
  if (process.env.KLYRO_CONFIG_DIR) return process.env.KLYRO_CONFIG_DIR;
  const home = os.homedir();
  if (home) return path.join(home, '.klyro');
  return path.join(process.cwd(), '.klyro');
}

export function getConfigPath(): string {
  if (process.env.KLYRO_CONFIG) return process.env.KLYRO_CONFIG;
  // New canonical path per spec
  return path.join(getConfigDir(), 'settings.json');
}

function getLegacyConfigPath(): string {
  if (process.env.KLYRO_CONFIG) return process.env.KLYRO_CONFIG;
  const home = os.homedir();
  if (home) return path.join(home, '.klyro', 'config.json');
  return path.join(process.cwd(), '.klyro', 'config.json');
}

export function getConfigSearchPaths(cwd = process.cwd()): Array<{ path: string; layer: string; exists: boolean }> {
  const homeSettings = path.join(getConfigDir(), 'settings.json');
  const projSettings = path.join(cwd, '.klyro', 'settings.json');
  const projLocal = path.join(cwd, '.klyro', 'settings.local.json');
  const legacy = getLegacyConfigPath();
  const paths = [
    { path: homeSettings, layer: '~/.klyro/settings.json' },
    { path: legacy, layer: '~/.klyro/config.json (legacy)' },
    { path: projSettings, layer: '.klyro/settings.json' },
    { path: projLocal, layer: '.klyro/settings.local.json' },
  ];
  return paths.map((p) => ({ ...p, exists: fsSync.existsSync(p.path) }));
}

// --- JSONC ---
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let inSingleLineComment = false;
  let inMultiLineComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const nxt = text[i + 1];
    if (inSingleLineComment) {
      if (ch === '\n') {
        inSingleLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inMultiLineComment) {
      if (ch === '*' && nxt === '/') {
        inMultiLineComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && nxt === '/') {
      inSingleLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && nxt === '*') {
      inMultiLineComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonc(raw: string, filePath: string): Record<string, unknown> {
  const stripped = stripJsonComments(raw);
  try {
    const parsed = JSON.parse(stripped);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new KlyroError('CONFIG_INVALID', `config is not a JSON object: ${filePath}`, {
        hint: 'Fix the file to be a JSON object, e.g. {"model":"gpt-4o-mini"}',
        exitCode: 3,
      });
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof KlyroError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new KlyroError('CONFIG_INVALID', `invalid JSON in ${filePath}: ${msg}`, {
      hint: `Check ${filePath} for trailing commas or comments — JSONC is allowed but must be valid`,
      exitCode: 3,
    });
  }
}

function validateConfig(obj: Record<string, unknown>, filePath: string): Record<string, unknown> {
  const res = ConfigSchema.safeParse(obj);
  if (!res.success) {
    const issues = res.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`).join('; ');
    throw new KlyroError('CONFIG_INVALID', `invalid config ${filePath}: ${issues}`, {
      hint: 'Fix the key per expected type, e.g. "model": "gpt-4o-mini"',
      exitCode: 3,
    });
  }
  return res.data as Record<string, unknown>;
}

// --- Helpers for dotted paths (unchanged) ---
function getByPath(obj: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setByPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  if (parts.some((p) => UNSAFE_KEYS.has(p))) {
    throw new Error(`refusing to set prototype-polluting key: ${dotted}`);
  }
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    const nxt = cur[p];
    if (nxt == null || typeof nxt !== 'object' || Array.isArray(nxt)) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function deleteByPath(obj: Record<string, unknown>, dotted: string): boolean {
  const parts = dotted.split('.');
  if (parts.some((p) => UNSAFE_KEYS.has(p))) return false;
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    const nxt = cur[p];
    if (nxt == null || typeof nxt !== 'object') return false;
    cur = nxt as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (!(last in cur)) return false;
  delete cur[last];
  return true;
}

function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

// --- Single-file load (backward compat) ---
export async function loadConfig(): Promise<Record<string, unknown>> {
  const p = getConfigPath();
  const legacy = getLegacyConfigPath();
  // Try canonical first, then legacy
  for (const file of [p, legacy]) {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const obj = parseJsonc(raw, file);
      return validateConfig(obj, file);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: string };
      if (e.code === 'ENOENT') continue;
      if (err instanceof KlyroError) throw err;
      throw new KlyroError('CONFIG_INVALID', `cannot read ${file}: ${e.message}`, { exitCode: 3 });
    }
  }
  return {};
}

// --- Synchronous single-file load (for sync call sites like buildProvider) ---
export function loadConfigSync(): Record<string, unknown> {
  const files = [getConfigPath(), getLegacyConfigPath()];
  for (const file of files) {
    try {
      const raw = fsSync.readFileSync(file, 'utf-8');
      const obj = parseJsonc(raw, file);
      return validateConfig(obj, file);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: string };
      if (e.code === 'ENOENT') continue;
      // Corrupt config must not crash provider resolution — ignore here
      // (klyro config/doctor surface the error properly).
      return {};
    }
  }
  return {};
}

/**
 * Project-layer trust boundary (P1): `.klyro/settings*.json` ship with the
 * repo, so a hostile checkout can plant them. API keys are NEVER accepted
 * from project layers — keys load only from ~/.klyro, env, or flags. A
 * project baseUrl pointing at a public host (which would receive the user's
 * key + prompts) warns loudly; loopback/RFC1918 stay silent for shared
 * local setups (Ollama etc.).
 */
function isPublicHostUrl(raw: string): boolean {
  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true; // unparseable endpoint — treat as hostile, warn
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host.startsWith('127.')) return false;
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return false;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(host)) return false;
  return true;
}

function scrubProjectLayer(obj: Record<string, unknown>, file: string): Record<string, unknown> {
  const warn = (msg: string): void => {
    try { process.stderr.write(msg); } catch { /* ignore */ }
  };
  for (const k of ['apiKey', 'api_key']) {
    if (obj[k] !== undefined) {
      delete obj[k];
      warn(
        `klyro: ignoring apiKey in project config ${file} — keys load only from ~/.klyro/settings.json, env (KLYRO_API_KEY), or --api-key\n`,
      );
    }
  }
  for (const k of ['baseUrl', 'baseURL']) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0 && isPublicHostUrl(v)) {
      warn(
        `klyro: warning: project config ${file} points the provider at ${v} — API requests (including your key) will go there\n`,
      );
    }
  }
  scrubProjectFailover(obj['providers'], file, warn);
  return obj;
}

/**
 * Failover entries from a project layer get the same trust treatment as the
 * primary endpoint. Two reasons `apiKeyEnv` is dropped rather than warned
 * about: (a) a fallback fires *without a prompt*, so a repo-chosen env var
 * name would silently ship the user's credential to a repo-chosen host, and
 * (b) the name can also cross providers (`provider:'openai'` + an Anthropic
 * env var). A literal `apiKey` in project config is left alone — that is the
 * repo's own key, not the user's secret — matching the accepted
 * `providers.failover[].apiKey` behaviour. Keys for a project-authored
 * fallback belong in ~/.klyro/settings.json.
 */
function scrubProjectFailover(
  providers: unknown,
  file: string,
  warn: (msg: string) => void,
): void {
  if (providers === null || typeof providers !== 'object') return;
  const failover = (providers as { failover?: unknown }).failover;
  if (!Array.isArray(failover)) return;
  for (const entry of failover) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e['apiKeyEnv'] !== undefined) {
      delete e['apiKeyEnv'];
      warn(
        `klyro: ignoring apiKeyEnv in project config ${file} — a repo must not choose which env var holds your key; configure that fallback in ~/.klyro/settings.json\n`,
      );
    }
    for (const k of ['baseURL', 'baseUrl']) {
      const v = e[k];
      if (typeof v === 'string' && v.length > 0 && isPublicHostUrl(v)) {
        warn(
          `klyro: warning: project config ${file} routes a failover provider to ${v} — API requests (including your key) will go there\n`,
        );
      }
    }
  }
}

// --- Merged load with 5-layer precedence ---
export async function loadMergedConfig(cwd = process.cwd(), flags: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const layers: Record<string, unknown>[] = [];
  // 1) defaults (empty)
  layers.push({});
  // 2) ~/.klyro/settings.json
  for (const file of [path.join(getConfigDir(), 'settings.json'), getLegacyConfigPath()]) {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const obj = parseJsonc(raw, file);
      layers.push(validateConfig(obj, file));
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: string };
      if (e.code === 'ENOENT') continue;
      throw err;
    }
  }
  // 3) .klyro/settings.json
  try {
    const raw = await fs.readFile(path.join(cwd, '.klyro', 'settings.json'), 'utf-8');
    const obj = parseJsonc(raw, path.join(cwd, '.klyro/settings.json'));
    layers.push(scrubProjectLayer(validateConfig(obj, path.join(cwd, '.klyro/settings.json')), path.join(cwd, '.klyro/settings.json')));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string };
    if (e.code !== 'ENOENT') throw err;
  }
  // 4) .klyro/settings.local.json
  try {
    const raw = await fs.readFile(path.join(cwd, '.klyro', 'settings.local.json'), 'utf-8');
    const obj = parseJsonc(raw, path.join(cwd, '.klyro/settings.local.json'));
    layers.push(scrubProjectLayer(validateConfig(obj, path.join(cwd, '.klyro/settings.local.json')), path.join(cwd, '.klyro/settings.local.json')));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string };
    if (e.code !== 'ENOENT') throw err;
  }
  // 5) env
  const envLayer: Record<string, unknown> = {};
  if (process.env.KLYRO_MODEL) envLayer.model = process.env.KLYRO_MODEL;
  if (process.env.KLYRO_PROVIDER) envLayer.provider = process.env.KLYRO_PROVIDER;
  if (process.env.KLYRO_BASE_URL) envLayer.baseUrl = process.env.KLYRO_BASE_URL;
  if (process.env.KLYRO_API_KEY) envLayer.apiKey = process.env.KLYRO_API_KEY;
  if (process.env.OPENAI_API_KEY) envLayer.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.ANTHROPIC_API_KEY) envLayer.apiKey = process.env.ANTHROPIC_API_KEY;
  layers.push(envLayer);
  // 6) flags (highest)
  layers.push(flags);

  // Merge shallow (dotted keys are already nested via setByPath, but we treat flat)
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue;
      try {
        setByPath(merged, k, v);
      } catch {
        continue; // e.g. prototype-polluting keys in a config file — skip, never crash startup
      }
    }
  }
  return merged;
}

export interface PermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : [];
}

/**
 * Permission glob rules (`tool(glob)` grammar) from the merged config
 * layers — home settings, project settings, project local. Fed into the
 * policy engine at startup so persisted "always allow" patterns apply
 * without re-prompting.
 */
export async function loadPermissionRules(cwd = process.cwd()): Promise<PermissionRules> {
  const merged = await loadMergedConfig(cwd, {});
  return {
    allow: asStringArray(merged.allow),
    deny: asStringArray(merged.deny),
    ask: asStringArray(merged.ask),
  };
}

/**
 * Strict allow-rule grammar: `tool` or `tool(glob)` where tool is
 * lowercase alnum+underscore and glob contains no parens.
 */
const ALLOW_RULE_RE = /^[a-z0-9_]+\([^()]*\)$|^[a-z0-9_]+$/;

export function isValidAllowRule(rule: string): boolean {
  return ALLOW_RULE_RE.test(rule.trim());
}

function isProjectDir(cwd: string): boolean {
  try {
    const st = fsSync.statSync(cwd);
    if (!st.isDirectory()) return false;
  } catch {
    return false;
  }
  return fsSync.existsSync(path.join(cwd, '.git')) || fsSync.existsSync(path.join(cwd, '.klyro'));
}

/**
 * Persist an "always allow" pattern. Validates the rule against the strict
 * grammar (throws `invalid rule` otherwise). When `cwd` is a project dir
 * (exists + contains .git or .klyro), writes to <cwd>/.klyro/settings.json;
 * otherwise writes to the home settings file. Returns whether it was
 * added (false when already present) and the file written.
 *
 * NOTE for the repl integrator (sibling-owned repl.ts): pass the session
 * cwd as the second arg to persist project-scoped allows.
 */
export async function persistAllowRule(rule: string, cwd?: string): Promise<{ added: boolean; path: string }> {
  if (!isValidAllowRule(rule)) {
    throw new Error(`invalid rule: ${rule}`);
  }
  // Project-scoped persist when cwd is a project dir.
  if (cwd && isProjectDir(cwd)) {
    const projPath = path.join(cwd, '.klyro', 'settings.json');
    let cfg: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(projPath, 'utf-8');
      cfg = validateConfig(parseJsonc(raw, projPath), projPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
    }
    const allow = asStringArray(cfg.allow);
    if (allow.includes(rule)) return { added: false, path: projPath };
    cfg.allow = [...allow, rule];
    await fs.mkdir(path.dirname(projPath), { recursive: true });
    const tmp = `${projPath}.tmp-${process.pid}-${Date.now()}`;
    const data = JSON.stringify(validateConfig(cfg, projPath), null, 2) + '\n';
    await fs.writeFile(tmp, data, { mode: 0o600 });
    try {
      await fs.rename(tmp, projPath);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
    try { await fs.chmod(projPath, 0o600); } catch { /* ignore on Windows */ }
    return { added: true, path: projPath };
  }
  const cfg = await loadConfig();
  const allow = asStringArray(cfg.allow);
  if (allow.includes(rule)) return { added: false, path: getConfigPath() };
  cfg.allow = [...allow, rule];
  await saveConfig(cfg);
  return { added: true, path: getConfigPath() };
}

export async function saveConfig(obj: Record<string, unknown>): Promise<void> {
  const p = getConfigPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  const data = JSON.stringify(validateConfig(obj, p), null, 2) + '\n';
  await fs.writeFile(tmp, data, { mode: 0o600 });
  try {
    await fs.rename(tmp, p);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  try { await fs.chmod(p, 0o600); } catch { /* ignore on Windows */ }
}

export async function runConfig(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  const cfgPath = getConfigPath();

  if (!cmd || cmd === 'list') {
    try {
      const cfg = await loadMergedConfig(process.cwd(), {});
      if (Object.keys(cfg).length === 0) {
        process.stdout.write(`# ${cfgPath} (empty)\n# No config yet. Use: klyro config set <key> <value>\n`);
      } else {
        process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
      }
      return 0;
    } catch (err) {
      if (err instanceof KlyroError) {
        process.stderr.write(`✖ ${err.message}\n hint: ${err.hint ?? ''}\n`);
        return err.exitCode;
      }
      throw err;
    }
  }

  if (cmd === 'path') {
    const paths = getConfigSearchPaths(process.cwd());
    for (const p of paths) {
      const status = p.exists ? 'exists' : 'missing';
      process.stdout.write(`${p.layer}: ${p.path} [${status}]\n`);
    }
    // Also show env
    process.stdout.write(`env: KLYRO_MODEL=${process.env.KLYRO_MODEL ?? '(not set)'} KLYRO_PROVIDER=${process.env.KLYRO_PROVIDER ?? '(not set)'}\n`);
    return 0;
  }

  if (cmd === 'edit') {
    const p = getConfigPath();
    // Try to open $EDITOR
    const editor = process.env.EDITOR || process.env.VISUAL;
    if (editor) {
      const { spawn } = await import('node:child_process');
      const child = spawn(editor, [p], { stdio: 'inherit', shell: true });
      const code: number = await new Promise((res) => child.on('close', (c) => res(typeof c === 'number' ? c : 1)));
      return code;
    }
    process.stderr.write('klyro: config edit — open ' + p + ' in $EDITOR\n');
    process.stdout.write(p + '\n');
    return 0;
  }

  if (cmd === 'get') {
    const key = rest[0];
    if (!key) { process.stderr.write('klyro: config get <key> — missing key\n'); return 2; }
    try {
      const cfg = await loadMergedConfig(process.cwd(), {});
      const val = getByPath(cfg, key);
      if (val === undefined) { process.stderr.write(`klyro: key not found: ${key}\n`); return 1; }
      if (typeof val === 'string') process.stdout.write(val + '\n');
      else process.stdout.write(JSON.stringify(val, null, 2) + '\n');
      return 0;
    } catch (err) {
      if (err instanceof KlyroError) { process.stderr.write(`✖ ${err.message}\n hint: ${err.hint ?? ''}\n`); return err.exitCode; }
      throw err;
    }
  }

  if (cmd === 'set') {
    const key = rest[0];
    const rawVal = rest.slice(1).join(' ');
    if (!key) { process.stderr.write('klyro: config set <key> <value> — missing key\n'); return 2; }
    if (rawVal === '' && rest.length < 2) { process.stderr.write('klyro: config set <key> <value> — missing value\n'); return 2; }
    try {
      const cfg = await loadConfig();
      const val = parseValue(rawVal);
      setByPath(cfg, key, val);
      // Validate before save
      validateConfig(cfg, cfgPath);
      await saveConfig(cfg);
      process.stdout.write(`set ${key} = ${typeof val === 'string' ? val : JSON.stringify(val)}\n`);
      return 0;
    } catch (err) {
      if (err instanceof KlyroError) { process.stderr.write(`✖ ${err.message}\n hint: ${err.hint ?? ''}\n`); return err.exitCode; }
      throw err;
    }
  }

  if (cmd === 'unset' || cmd === 'delete' || cmd === 'rm') {
    const key = rest[0];
    if (!key) { process.stderr.write(`klyro: config ${cmd} <key> — missing key\n`); return 2; }
    const cfg = await loadConfig();
    const ok = deleteByPath(cfg, key);
    if (!ok) { process.stderr.write(`klyro: key not found: ${key}\n`); return 1; }
    await saveConfig(cfg);
    process.stdout.write(`unset ${key}\n`);
    return 0;
  }

  process.stderr.write(`klyro: unknown config command: ${cmd}\n`);
  process.stderr.write('Usage: klyro config [list|get <key>|set <key> <value>|unset <key>|path|edit]\n');
  return 2;
}

export const _helpers = { getByPath, setByPath, deleteByPath, parseValue, stripJsonComments: stripJsonComments };
