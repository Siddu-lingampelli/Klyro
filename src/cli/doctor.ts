/**
 * LEVEL 1 — klyro doctor
 * Runs quick diagnostics: node version, config, provider reachability,
 * persistence dir, git, tools.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
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

export async function runDoctor(opts: { json?: boolean; cwd?: string } = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const checks: Check[] = [];
  checks.push(checkNode());
  checks.push(await checkConfig());
  checks.push(await checkProvider());
  checks.push(await checkSessions());
  checks.push(await checkGit());
  checks.push(await checkTools());
  checks.push(checkPlatform());
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
    const color = c.ok ? '' : '';
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
