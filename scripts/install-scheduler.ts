/**
 * install-scheduler — install / uninstall the per-user OS scheduler entry
 * that runs scripts/refresh-map.ts every 5 minutes on the user's project
 * directories.
 *
 * Subcommands:
 *   install   [--cwd <path>] [--every <minutes>]
 *   uninstall
 *   status
 *
 * Windows: registers a user-scoped Task Scheduler entry
 *   ("Klyro.refresh-<basename>") that runs the script via `npx tsx`.
 * macOS/Linux: writes a crontab line that runs the script.
 *
 * The scheduler entry runs the script against the directory passed via
 * `--cwd` at install time, and writes its cache to that same `<cwd>/.klyro/`.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';

interface InstallOptions {
  cwd: string;
  everyMinutes: number;
}

const TASK_PREFIX = 'Klyro.refresh-';
const CRON_TAG = 'klyro-refresh';

function parseArgs(argv: string[]): { sub: string; opts: InstallOptions & { raw: string[] } } {
  const sub = argv[2];
  if (!sub || !['install', 'uninstall', 'status', 'help', '-h', '--help'].includes(sub)) {
    console.error('Usage: install-scheduler <install|uninstall|status> [flags]');
    process.exit(2);
  }
  const opts: InstallOptions = { cwd: process.cwd(), everyMinutes: 5 };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') { const v = argv[++i]; if (v) opts.cwd = path.resolve(v); }
    else if (a === '--every') { const v = argv[++i]; if (v) opts.everyMinutes = Number(v); }
  }
  return { sub, opts: { ...opts, raw: argv } };
}

function cacheFile(cwd: string): string {
  return path.join(cwd, '.klyro', 'scheduler.json');
}

function readState(cwd: string): { taskName?: string; cronLine?: string } | null {
  try { return JSON.parse(fs.readFileSync(cacheFile(cwd), 'utf-8')) as { taskName?: string; cronLine?: string }; }
  catch { return null; }
}

function writeState(cwd: string, state: { taskName?: string; cronLine?: string }): void {
  const file = cacheFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function scriptCommand(cwd: string): string {
  // Use the project's local tsx so we don't require a global install.
  // On Windows, the .bin entry is a .cmd batch wrapper that must be
  // invoked through cmd.exe (it can't be passed directly to node).
  const repo = process.cwd();
  const tsxWin = path.join(repo, 'node_modules', '.bin', 'tsx.cmd');
  const tsxNix = path.join(repo, 'node_modules', '.bin', 'tsx');
  if (process.platform === 'win32') {
    if (fs.existsSync(tsxWin)) {
      // cmd /c "tsx script.ts --cwd X" — the inner quotes get tricky,
      // so we wrap the whole thing.
      return `cmd.exe /c "\"${tsxWin}\" \"${path.join(repo, 'scripts', 'refresh-map.ts')}\" --cwd \"${cwd}\""`;
    }
    return `cmd.exe /c "\"${process.execPath}\" \"${path.join(repo, 'scripts', 'refresh-map.ts')}\" --cwd \"${cwd}\""`;
  }
  if (fs.existsSync(tsxNix)) {
    return `"${process.execPath}" "${tsxNix}" "${path.join(repo, 'scripts', 'refresh-map.ts')}" --cwd "${cwd}"`;
  }
  return `"${process.execPath}" "${path.join(repo, 'scripts', 'refresh-map.ts')}" --cwd "${cwd}"`;
}

function installWindows(cwd: string, everyMinutes: number): string {
  const taskName = TASK_PREFIX + path.basename(cwd).replace(/[^A-Za-z0-9_.-]/g, '_');
  const cmd = scriptCommand(cwd);
  // /SC MINUTE /MO <n>  = every <n> minutes
  // /IT = interactive (not needed for backgrounded run; use /RL LIMITED)
  // /F = overwrite if exists
  const args = [
    '/Create', '/F', '/TN', taskName, '/SC', 'MINUTE', '/MO', String(everyMinutes),
    '/RL', 'LIMITED', '/TR', cmd,
  ];
  try {
    execFileSync('schtasks.exe', args, { stdio: 'pipe' });
  } catch (err) {
    throw new Error('Failed to register Task Scheduler entry: ' + (err instanceof Error ? err.message : String(err)));
  }
  return taskName;
}

function uninstallWindows(taskName: string): void {
  try { execFileSync('schtasks.exe', ['/Delete', '/F', '/TN', taskName], { stdio: 'pipe' }); } catch { /* already gone */ }
}

function installCrontab(cwd: string, everyMinutes: number): string {
  const cmd = scriptCommand(cwd);
  // Run the script, suppress any stdout/stderr (we don't want cron emailing us).
  const line = `*/${everyMinutes} * * * * ${cmd} >/dev/null 2>&1 # ${CRON_TAG}-${path.basename(cwd)}`;
  let current = '';
  try { current = execSync('crontab -l', { encoding: 'utf-8' }); } catch { /* no crontab yet */ }
  // Strip any prior klyro-refresh lines for this cwd.
  const tag = `${CRON_TAG}-${path.basename(cwd)}`;
  const filtered = current.split('\n').filter((l) => !l.includes(tag)).join('\n');
  const next = filtered.trimEnd() + '\n' + line + '\n';
  try {
    execSync('crontab', { input: next, encoding: 'utf-8' });
  } catch (err) {
    throw new Error('Failed to update crontab: ' + (err instanceof Error ? err.message : String(err)));
  }
  return line;
}

function uninstallCrontab(tag: string): void {
  let current = '';
  try { current = execSync('crontab -l', { encoding: 'utf-8' }); } catch { return; }
  const filtered = current.split('\n').filter((l) => !l.includes(tag)).join('\n');
  execSync('crontab', { input: filtered, encoding: 'utf-8' });
}

function statusWindows(taskName: string): { installed: boolean; info?: string } {
  try {
    const out = execFileSync('schtasks.exe', ['/Query', '/TN', taskName, '/FO', 'LIST', '/V'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    return { installed: true, info: out };
  } catch { return { installed: false }; }
}

function statusCrontab(tag: string): { installed: boolean; line?: string } {
  try {
    const current = execSync('crontab -l', { encoding: 'utf-8' });
    const line = current.split('\n').find((l) => l.includes(tag));
    return line ? { installed: true, line } : { installed: false };
  } catch { return { installed: false }; }
}

function main(): void {
  const { sub, opts } = parseArgs(process.argv);
  if (sub === 'help' || sub === '-h' || sub === '--help') {
    console.log('Usage: install-scheduler <install|uninstall|status> [--cwd <path>] [--every <minutes>]');
    process.exit(0);
  }
  if (sub === 'install') {
    if (process.platform === 'win32') {
      const taskName = installWindows(opts.cwd, opts.everyMinutes);
      writeState(opts.cwd, { taskName });
      console.log(`Installed: ${taskName} (every ${opts.everyMinutes} min)`);
    } else {
      const line = installCrontab(opts.cwd, opts.everyMinutes);
      writeState(opts.cwd, { cronLine: line });
      console.log(`Installed crontab line (every ${opts.everyMinutes} min):\n${line}`);
    }
    return;
  }
  if (sub === 'uninstall') {
    const state = readState(opts.cwd);
    if (!state) { console.log('No scheduler entry recorded for ' + opts.cwd); return; }
    if (process.platform === 'win32') {
      if (state.taskName) uninstallWindows(state.taskName);
    } else {
      const tag = `${CRON_TAG}-${path.basename(opts.cwd)}`;
      uninstallCrontab(tag);
    }
    try { fs.unlinkSync(cacheFile(opts.cwd)); } catch { /* noop */ }
    console.log('Uninstalled.');
    return;
  }
  if (sub === 'status') {
    if (process.platform === 'win32') {
      const state = readState(opts.cwd);
      if (!state?.taskName) { console.log('Not installed for ' + opts.cwd); return; }
      const s = statusWindows(state.taskName);
      console.log(s.installed ? `Installed: ${state.taskName}` : 'Recorded but not present in Task Scheduler.');
    } else {
      const tag = `${CRON_TAG}-${path.basename(opts.cwd)}`;
      const s = statusCrontab(tag);
      console.log(s.installed ? `Installed: ${s.line}` : 'Not installed.');
    }
    return;
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
