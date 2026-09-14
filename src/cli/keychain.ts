/**
 * OS keychain for provider API keys — no new dependencies, platform CLIs only.
 *
 *   - macOS: `security` (Keychain Services; always present)
 *   - Linux: `secret-tool` (libsecret; present on most GNOME desktops)
 *   - Windows: unavailable (no dependency-free read path) → file fallback
 *
 * Every function is best-effort and never throws: missing CLIs, locked
 * keychains, and headless sessions all degrade to `null`/`false`, and
 * callers fall back to the 0600 credentials file. Service name is fixed
 * (`klyro`), accounts are provider ids (`openai`, `anthropic`).
 */
import { execFileSync, spawnSync } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'klyro';

export type KeychainBackend = 'macos' | 'linux';

/** Which OS backend (if any) can store keys on this machine. */
export function keychainAvailable(): KeychainBackend | null {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') {
    try {
      const r = spawnSync('secret-tool', ['--version'], { stdio: 'ignore', timeout: 5000 });
      if (r.error) return null;
      return typeof r.status === 'number' && r.status === 0 ? 'linux' : null;
    } catch {
      return null;
    }
  }
  return null;
}

function run(args: string[], input?: string): { ok: boolean; out: string } {
  try {
    const res = execFileSync(args[0]!, args.slice(1), {
      input: input ?? undefined,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return { ok: true, out: typeof res === 'string' ? res : '' };
  } catch {
    return { ok: false, out: '' };
  }
}

/** Read a secret. Returns null when unavailable, missing, or denied. */
export async function keychainGet(account: string): Promise<string | null> {
  const backend = keychainAvailable();
  if (!backend) return null;
  if (backend === 'macos') {
    const r = run(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w']);
    const v = r.out.trim();
    return r.ok && v ? v : null;
  }
  const r = run(['secret-tool', 'lookup', 'service', KEYCHAIN_SERVICE, 'account', account]);
  const v = r.out.replace(/\n$/, '');
  return r.ok && v ? v : null;
}

/** Store a secret. Returns false when unavailable or denied (caller falls back). */
export async function keychainSet(account: string, secret: string): Promise<boolean> {
  if (!secret) return false;
  const backend = keychainAvailable();
  if (!backend) return false;
  if (backend === 'macos') {
    // -U updates an existing item instead of erroring on duplicates.
    const r = run(['security', 'add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', secret]);
    return r.ok;
  }
  const r = run(['secret-tool', 'store', '--label', `klyro ${account}`, 'service', KEYCHAIN_SERVICE, 'account', account], secret);
  return r.ok;
}

/** Delete a secret. Returns false when unavailable (caller falls back). */
export async function keychainDelete(account: string): Promise<boolean> {
  const backend = keychainAvailable();
  if (!backend) return false;
  if (backend === 'macos') {
    const r = run(['security', 'delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]);
    return r.ok;
  }
  const r = run(['secret-tool', 'clear', 'service', KEYCHAIN_SERVICE, 'account', account]);
  return r.ok;
}
