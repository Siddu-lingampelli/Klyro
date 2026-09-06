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
import { builtinRegistry } from '../tools/registry.js';

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

function checkTools(): Check {
  const reg = builtinRegistry();
  return { name: 'Tools', ok: true, detail: `${reg.list().length} tools: ${reg.list().map((t) => t.name).join(', ')}` };
}

function checkPlatform(): Check {
  const ok = ['win32', 'linux', 'darwin'].includes(process.platform);
  return { name: 'Platform', ok, detail: `${process.platform} ${process.arch} ${ok ? '✓' : '✗ unsupported'}` };
}

export async function runDoctor(opts: { json?: boolean } = {}): Promise<number> {
  const checks: Check[] = [];
  checks.push(checkNode());
  checks.push(await checkConfig());
  checks.push(await checkProvider());
  checks.push(await checkSessions());
  checks.push(await checkGit());
  checks.push(checkTools());
  checks.push(checkPlatform());

  const allOk = checks.every((c) => c.ok);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: allOk, checks }, null, 2) + '\n');
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
