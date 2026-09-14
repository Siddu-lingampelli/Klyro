/**
 * B2 — MCP OAuth/PKCE auth surface (remote MCP reach parity).
 *
 * Token-backed OAuth 2.0 Authorization Code flow with PKCE (RFC 7636) for
 * remote MCP servers (Risk #7 / #3 residual: "OAuth absent"). Access tokens
 * are cached at `~/.klyro/mcp-tokens.json` (mode 0600) and keyed by the
 * server's URL + clientId, so a cached credential survives restarts and is
 * reused (with lazy refresh) instead of re-prompting every run.
 *
 * The auth code flow runs against a short-lived loopback listener on
 * 127.0.0.1 (RFC 8252 native-app redirect). In a headless context the flow
 * prints the authorization URL and the user completes it by opening the
 * link; the code is captured on the loopback redirect. Every function is
 * fail-safe: network/server failures never throw raw into the MCP tool path
 * — they surface a typed `AuthError`.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

/** Shape of the `auth` block on an MCP server spec (see config.ts). */
export interface McpAuthSpec {
  /** OAuth 2.0 client identifier registered with the authorization server. */
  clientId: string;
  /** Token endpoint; when absent, discovered from the server's metadata. */
  tokenEndpoint?: string;
  /**
   * Authorization endpoint; when absent, discovered from the server's
   * metadata. The MCP server URL is the OAuth resource server, so its
   * `/.well-known/oauth-authorization-server` metadata is the default
   * discovery source (per the MCP 2025-06-18 auth spec).
   */
  authorizationEndpoint?: string;
  /** Custom redirect URI; defaults to a loopback listener on 127.0.0.1. */
  redirectUri?: string;
  /** Space-separated additional scopes to request. */
  scopes?: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface CachedToken {
  access_token: string;
  token_type: string;
  /** Unix seconds when the token expires. 0 = unknown (treated as valid). */
  expires_at: number;
  refresh_token?: string;
  scope?: string;
  cachedAtMs: number;
}

export const TOKEN_STALE_MARGIN_S = 60;
export const TOKENS_FILE = 'mcp-tokens.json';

function tokensPath(): string {
  const base = process.env.KLYRO_CONFIG_DIR ?? path.join(os.homedir() || process.cwd(), '.klyro');
  return path.join(base, TOKENS_FILE);
}

/** Fully load the token cache as a plain object (missing/corrupt → {}). */
export function loadMcpTokens(): Record<string, CachedToken> {
  try {
    const raw = fs.readFileSync(tokensPath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, CachedToken>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Persist a token to the 0600 cache. Merges by key so concurrent server
 * writes don't clobber each other. A symlinked cache path is refused (the
 * write would land outside the klyro config dir or be swapped mid-write).
 */
export function saveMcpToken(cacheKey: string, token: CachedToken): void {
  const p = tokensPath();
  try {
    if (fs.lstatSync(p).isSymbolicLink()) {
      throw new AuthError(`refusing to write token cache through symlink: ${p}`);
    }
  } catch (e) {
    if (e instanceof AuthError) throw e;
    /* ENOENT — first write, fine */
  }
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const all = loadMcpTokens();
  all[cacheKey] = token;
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/** Stable cache key for a server URL + clientId. */
export function mcpTokenCacheKey(url: string, clientId: string): string {
  return `${url}|${clientId}`;
}

/** True when a cached token is still usable (with a clock-skew margin). */
export function tokenValid(t: CachedToken): boolean {
  if (!t || typeof t.access_token !== 'string' || !t.access_token) return false;
  // expires_at 0 = unknown lifetime — assume still valid.
  return t.expires_at === 0 || t.expires_at > Date.now() / 1000 + TOKEN_STALE_MARGIN_S;
}

/** PKCE (RFC 7636 §4.1): cryptographically-random 43-128 char code verifier. */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(64).toString('base64url'); // ~86 chars, within §4.1 range
}

/** PKCE §4.2: base64url SHA-256 challenge of the verifier. */
export function codeChallengeFromVerifier(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export interface AuthResolveResult {
  /** Extra headers (e.g. `Authorization`) to attach to MCP requests. */
  headers: Record<string, string>;
  /** True when a cached token was used (no interactive flow needed). */
  fromCache: boolean;
}

/**
 * Resolve auth headers for a server: reuse a valid cached token, else run
 * the interactive Authorization Code + PKCE flow. Returns only the headers;
 * failures surface as `AuthError` so callers (the MCP probe/connect path)
 * can turn them into a clear error instead of a hang.
 */
export async function resolveAuth(auth: McpAuthSpec, cacheKey: string): Promise<AuthResolveResult> {
  const cached = loadMcpTokens()[cacheKey];
  if (cached && tokenValid(cached)) {
    return { headers: { Authorization: `${cached.token_type || 'Bearer'} ${cached.access_token}` }, fromCache: true };
  }
  // No usable token — run the code flow.
  const token = await runCodeFlow(auth);
  if (!token) throw new AuthError(`OAuth flow for "${auth.clientId}" returned no token`);
  const expiryUnix = token.expires_in ? Math.floor(Date.now() / 1000 + token.expires_in) : 0;
  const saved: CachedToken = {
    access_token: token.access_token,
    token_type: token.token_type ?? 'Bearer',
    expires_at: expiryUnix,
    refresh_token: token.refresh_token,
    scope: token.scope,
    cachedAtMs: Date.now(),
  };
  saveMcpToken(cacheKey, saved);
  return { headers: { Authorization: `${saved.token_type} ${saved.access_token}` }, fromCache: false };
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

function resolveIssuer(auth: McpAuthSpec, serverUrl: string): URL {
  let issuer: URL;
  try {
    issuer = new URL(auth.authorizationEndpoint ?? serverUrl);
  } catch {
    throw new AuthError(`invalid OAuth issuer URL for "${auth.clientId}"`);
  }
  return issuer;
}

/**
 * Run the Authorization Code flow with PKCE over a one-shot loopback
 * redirect (RFC 8252). Best-effort and headless-friendly: on any failure it
 * throws `AuthError` rather than leaving a stray listener. The token endpoint
 * defaults to the OAuth metadata `token_endpoint` when the server advertises
 * it, else the spec's `tokenEndpoint`.
 */
export async function runCodeFlow(auth: McpAuthSpec, serverUrl?: string): Promise<TokenResponse | null> {
  const issuer = resolveIssuer(auth, serverUrl ?? '');
  const verifier = generateCodeVerifier();
  const challenge = codeChallengeFromVerifier(verifier);

  const listener = http.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const addr = listener.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new AuthError('could not bind loopback listener'));
    });
  });

  let code: string | null = null;
  const pending = new Promise<string>((resolve, reject) => {
    listener.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      code = u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('You can close this tab and return to the terminal.');
      if (code) resolve(code);
      else reject(new AuthError('authorization redirect carried no code'));
    });
  });

  try {
    const redirectUri = auth.redirectUri ?? `http://127.0.0.1:${port}/callback`;
    const authorizeUrl = buildAuthorizeUrl(auth, issuer, challenge, redirectUri);
    process.stdout.write(`\nOpen this URL in your browser to authorize klyro for MCP server "${auth.clientId}":\n${authorizeUrl}\n`);
    code = await pending;
    return await exchangeCode(auth, issuer, code, verifier, redirectUri);
  } finally {
    listener.close();
  }
}

function buildAuthorizeUrl(auth: McpAuthSpec, issuer: URL, challenge: string, redirectUri: string): string {
  const u = new URL(auth.authorizationEndpoint || issuer.origin, issuer);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', auth.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', crypto.randomBytes(8).toString('base64url'));
  if (auth.scopes) u.searchParams.set('scope', auth.scopes);
  return u.toString();
}

async function exchangeCode(
  auth: McpAuthSpec,
  issuer: URL,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const tokenEndpoint = auth.tokenEndpoint || `${issuer.origin}/token`;
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: auth.clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new AuthError(`token exchange failed: HTTP ${res.status}`);
  const data = (await res.json()) as Partial<TokenResponse>;
  if (!data.access_token) throw new AuthError('token exchange returned no access_token');
  return data as TokenResponse;
}

/**
 * Scrub credential-bearing headers from debug capture so `KLYRO_MCP_DEBUG`
 * never writes a live access token to disk. Non-credential headers pass
 * through untouched.
 */
export function scrubAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization' || k.toLowerCase() === 'cookie' || k.toLowerCase() === 'x-api-key') {
      out[k] = '[REDACTED]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Refreshes a stale token when a refresh_token is cached (best-effort). */
export async function tryRefresh(auth: McpAuthSpec, cached: CachedToken): Promise<CachedToken | null> {
  if (!cached.refresh_token || !auth.tokenEndpoint) return null;
  const res = await fetch(auth.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cached.refresh_token,
      client_id: auth.clientId,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Partial<TokenResponse>;
  if (!data.access_token) return null;
  return {
    access_token: data.access_token,
    token_type: data.token_type ?? cached.token_type,
    expires_at: data.expires_in ? Math.floor(Date.now() / 1000 + data.expires_in) : cached.expires_at,
    refresh_token: data.refresh_token ?? cached.refresh_token,
    scope: data.scope ?? cached.scope,
    cachedAtMs: Date.now(),
  };
}