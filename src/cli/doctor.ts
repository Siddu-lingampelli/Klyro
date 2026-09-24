/**
 * LEVEL 1 — klyro doctor
 * Runs quick diagnostics: node version, config, provider reachability,
 * persistence dir, git, tools.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { getConfigPath, loadConfig } from './config.js';
import { resolveProvider, providerHelp } from '../providers.js';
import { getDefaultSessionsDir } from '../persistence/session.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function checkNode(): Check {
  const v = process.versions.node;
  const major = Number(v.split('.')[0] ?? 0);
  const ok = major >= 20;
  return {
    name: 'Node.js',
    ok,
    detail: `${v} ${ok ? '✓' : '✗ requires >=20'} (${process.execPath})`,
  };
}

async function checkConfig(): Promise<Check> {
  const p = getConfigPath();
  try {
    await loadConfig();
    const exists = fsSync.existsSync(p);
    return { name: 'Config', ok: true, detail: exists ? `${p} ✓` : `${p} (not yet created) ✓` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Config', ok: false, detail: `${p} ✗ ${msg}` };
  }
}

async function checkProvider(): Promise<Check> {
  try {
    const prov = await resolveProvider();
    if (!prov) {
      return { name: 'Provider', ok: false, detail: `none ${providerHelp(null)}` };
    }
    const src = prov.source === 'local-probe' ? 'local-probe' : prov.source === 'env' ? 'env' : 'manual';
    const auth = prov.apiKey ? 'key set' : 'no key (local)';
    return { name: 'Provider', ok: true, detail: `${prov.baseURL} model=${prov.model} (${src}, ${auth}) ✓` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Provider', ok: false, detail: `error: ${msg}` };
  }
}

async function checkSessions(): Promise<Check> {
  const dir = getDefaultSessionsDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    const test = path.join(dir, `.doctor-${Date.now()}.tmp`);
    await fs.writeFile(test, 'ok', 'utf-8');
    await fs.unlink(test);
    return { name: 'Sessions dir', ok: true, detail: `${dir} writable ✓` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Sessions dir', ok: false, detail: `${dir} ✗ ${msg}` };
  }
}

function checkGit(): Promise<Check> {
  return new Promise((resolve) => {
    const child = spawn('git', ['--version'], { shell: false, windowsHide: true });
    let out = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      resolve({ name: 'git', ok: false, detail: 'timeout' });
    }, 3000);
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ name: 'git', ok: false, detail: 'not found (install git)' });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve({ name: 'git', ok: true, detail: out.trim() + ' ✓' });
      else resolve({ name: 'git', ok: false, detail: `exit ${code}` });
    });
  });
}

async function checkTools(): Promise<Check> {
  try {
    const { builtinRegistry } = await import('../tools/registry.js');
    const reg = builtinRegistry();
    return { name: 'Tools', ok: true, detail: `${reg.list().length} tools: ${reg.list().map((t) => t.name).join(', ')}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Tools', ok: false, detail: `registry unavailable: ${msg}` };
  }
}

function checkPlatform(): Check {
  const ok = ['win32', 'linux', 'darwin'].includes(process.platform);
  return { name: 'Platform', ok, detail: `${process.platform} ${process.arch} ${ok ? '✓' : '✗ unsupported'}` };
}

async function checkSandbox(): Promise<Check> {
  try {
    const { detectSandbox } = await import('../tools/shell/sandbox.js');
    const st = detectSandbox();
    if (st.active) return { name: 'Sandbox', ok: true, detail: `${st.backend} ✓` };
    return { name: 'Sandbox', ok: true, detail: `none — ${st.reason ?? 'policy+path guards only'}` };
  } catch {
    return { name: 'Sandbox', ok: true, detail: 'none — policy+path guards only' };
  }
}

function checkPackageManager(): Check {
  try {
    const npm = execFileSync('npm', ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
    return { name: 'npm', ok: true, detail: `npm ${npm} ✓` };
  } catch {
    return { name: 'npm', ok: false, detail: 'npm not on PATH — install Node ≥20' };
  }
}

function checkPath(): Check {
  const pathVar = process.env.PATH ?? process.env.Path ?? '';
  const nodeDir = process.execPath.includes('\\') || process.execPath.includes('/')
    ? process.execPath.slice(0, Math.max(process.execPath.lastIndexOf('\\'), process.execPath.lastIndexOf('/')))
    : '';
  const onPath = !!pathVar && !!nodeDir && pathVar.toLowerCase().split(path.delimiter).some((p) => p.toLowerCase() === nodeDir.toLowerCase());
  return { name: 'PATH', ok: true, detail: onPath ? `node dir on PATH ✓` : `node dir not on PATH (${nodeDir || 'unknown'}) — child shells may miss node` };
}

function checkRipgrep(): Check {
  try {
    const v = execFileSync('rg', ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0] ?? '';
    return { name: 'ripgrep', ok: true, detail: `${v} ✓` };
  } catch {
    return { name: 'ripgrep', ok: true, detail: 'not found — built-in grep tool is used instead' };
  }
}

function checkTerminal(): Check {
  const isTTY = !!process.stdout.isTTY;
  const term = process.env.TERM ?? '(unset)';
  const cols = process.stdout.columns ?? 0;
  return { name: 'Terminal', ok: true, detail: `${isTTY ? 'TTY' : 'non-TTY (headless/pipe mode)'}, TERM=${term}, cols=${cols}` };
}

function checkProxy(): Check {
  const vars = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
    .filter((k) => process.env[k] && (process.env[k] as string).length > 0);
  if (vars.length === 0) return { name: 'Proxy', ok: true, detail: 'no proxy env — direct connections' };
  return { name: 'Proxy', ok: true, detail: `${vars.join(', ')} set — honored for provider/web/update fetches` };
}

async function checkMcp(cwd: string): Promise<Check> {
  try {
    const { loadMcpServers } = await import('../mcp/config.js');
    const cfg = loadMcpServers(cwd);
    const names = Object.keys(cfg.servers);
    if (names.length === 0) return { name: 'MCP servers', ok: true, detail: 'none' };
    let project = 0;
    for (const n of names) {
      if (cfg.sources[n] === 'project') project++;
    }
    return { name: 'MCP servers', ok: true, detail: `${names.length} servers (global ${names.length - project}/project ${project})` };
  } catch {
    return { name: 'MCP servers', ok: true, detail: 'none' };
  }
}

function countTrustEntries(p: string): number | null {
  try {
    const raw = fsSync.readFileSync(p, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>).length;
    }
    return null;
  } catch {
    return null;
  }
}

async function checkTrust(): Promise<Check> {
  try {
    const [{ defaultTrustStorePath }] = [await import('../context/trust.js')];
    const [{ defaultMcpTrustStorePath }] = [await import('../mcp/trust.js')];
    const ctx = countTrustEntries(defaultTrustStorePath());
    const mcp = countTrustEntries(defaultMcpTrustStorePath());
    if (ctx === null && mcp === null) return { name: 'Trust stores', ok: true, detail: 'none' };
    return {
      name: 'Trust stores',
      ok: true,
      detail: `context-trust ${ctx ?? 0} entries, mcp-trust ${mcp ?? 0} entries`,
    };
  } catch {
    return { name: 'Trust stores', ok: true, detail: 'none' };
  }
}

/**
 * Pure byte interpreter for `doctor --keys` (unit-tested): names what a
 * terminal delivered so broken arrow/paste/scroll input becomes provable
 * fact instead of guesswork. Covers arrows, paging/home/end, Ctrl codes,
 * bracketed-paste markers, and SGR/X10 mouse sequences.
 */
export function describeKeyBytes(chunk: Buffer): string {
  const s = chunk.toString('latin1');
  switch (s) {
    case '\x1b[A': return 'Up arrow (history prev)';
    case '\x1b[B': return 'Down arrow (history next)';
    case '\x1b[C': return 'Right arrow';
    case '\x1b[D': return 'Left arrow';
    case '\x1b[5~': return 'PageUp (scroll half-page up)';
    case '\x1b[6~': return 'PageDown (scroll half-page down)';
    case '\x1b[H': case '\x1b[1~': return 'Home (jump top)';
    case '\x1b[F': case '\x1b[4~': return 'End (jump bottom)';
    case '\x1b[Z': return 'Shift+Tab';
    case '\r': case '\n': return 'Enter';
    case '\x7f': return 'Backspace';
    case '\x1b': return 'Escape (lone — arrow/paste sequences arrive joined; lone ESC means the terminal split them or you pressed Esc)';
    case '\x1b[200~': return 'Bracketed-paste START (terminal supports bulk paste)';
    case '\x1b[201~': return 'Bracketed-paste END';
    case '\x03': return 'Ctrl+C';
    case '\x10': return 'Ctrl+P (history prev, escape-free)';
    case '\x0e': return 'Ctrl+N (history next, escape-free)';
    case '\x15': return 'Ctrl+U (scroll half-page up)';
    case '\x04': return 'Ctrl+D (scroll half-page down)';
    case '\x09': return 'Tab';
  }
  // eslint-disable-next-line no-control-regex -- intentional: parsing SGR mouse sequences requires ESC matching
  if (/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(s)) {
    const cb = Number(s.slice(3).split(';')[0]);
    return (cb & 64) !== 0
      ? `Mouse wheel ${(cb & 1) === 0 ? 'up' : 'down'} (reporting active)`
      : 'Mouse click/drag (reporting active — plain selection needs Shift+drag)';
  }
  // eslint-disable-next-line no-control-regex -- intentional: parsing X10 mouse sequences requires ESC matching
  if (/^\x1b\[M...$/.test(s)) return 'Mouse event, X10 encoding (reporting active)';
  if (/^[\x20-\x7e]+$/.test(s)) return `Printable text (${s.length} chars — typing/paste-as-typing works)`;
  return 'Unrecognized sequence (terminal-specific — paste the bytes line into a bug report)';
}

/**
 * Interactive key probe: raw-mode stdin echo of every chunk with its
 * meaning. Proves what THIS terminal delivers for arrows, Ctrl+P/N,
 * paste, and wheel — run it when TUI input misbehaves.
 */
export async function runKeysProbe(): Promise<number> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    process.stderr.write('klyro: doctor --keys needs an interactive terminal (stdin is not a TTY)\n');
    return 2;
  }
  stdout.write('klyro doctor --keys — press keys, see exactly what your terminal sends.\n');
  stdout.write('Try: ↑ ↓ PgUp PgDn Home End Ctrl+P Ctrl+N, then paste text, then scroll the wheel. Ctrl+C quits.\n');
  stdin.setRawMode(true);
  stdin.resume();
  try {
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer): void => {
        const bytes = [...chunk].map((b) => (b as number).toString(16).padStart(2, '0')).join(' ');
        stdout.write(`bytes: ${bytes}  →  ${describeKeyBytes(chunk)}\n`);
        if (chunk.length === 1 && chunk[0] === 0x03) {
          stdin.off('data', onData);
          resolve();
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    try { stdin.setRawMode(false); } catch { /* ignore */ }
    try { stdin.pause(); } catch { /* ignore */ }
  }
  return 0;
}

export async function runDoctor(opts: { json?: boolean; cwd?: string } = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const checks: Check[] = [];
  checks.push(checkNode());
  checks.push(checkPackageManager());
  checks.push(checkPath());
  checks.push(await checkConfig());
  checks.push(await checkProvider());
  checks.push(await checkSessions());
  checks.push(await checkGit());
  checks.push(checkRipgrep());
  checks.push(checkTerminal());
  checks.push(checkProxy());
  checks.push(await checkTools());
  checks.push(checkPlatform());
  checks.push(await checkSandbox());
  const mcpCheck = await checkMcp(cwd);
  const trustCheck = await checkTrust();
  checks.push(mcpCheck);
  checks.push(trustCheck);

  const allOk = checks.every((c) => c.ok);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      ok: allOk,
      checks,
      mcp: { ok: mcpCheck.ok, detail: mcpCheck.detail },
      trust: { ok: trustCheck.ok, detail: trustCheck.detail },
    }, null, 2) + '\n');
    return allOk ? 0 : 1;
  }

  process.stdout.write('\nklyro doctor\n');
  process.stdout.write('─'.repeat(40) + '\n');
  for (const c of checks) {
    const glyph = c.ok ? '✓' : '✗';
    process.stdout.write(`${glyph} ${c.name.padEnd(14)} ${c.detail}\n`);
  }
  process.stdout.write('─'.repeat(40) + '\n');
  if (allOk) {
    process.stdout.write('All checks passed.\n');
  } else {
    process.stdout.write('Some checks failed — see ✗ above. Fix env/config and re-run.\n');
    process.stdout.write(`Config path: ${getConfigPath()}\n`);
    process.stdout.write(`Sessions : ${getDefaultSessionsDir()}\n`);
  }
  return allOk ? 0 : 1;
}
