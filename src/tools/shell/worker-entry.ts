/**
 * G2 — Worker entry point for subprocess isolation.
 *
 * When the OS sandbox (bwrap) is unavailable (Windows, no-bwrap Linux),
 * shell_exec routes its command through this worker so a crash/OOM in the
 * child cannot take down the parent harness.
 *
 * Protocol: single JSON arg on argv[2] -> single JSON line on stdout.
 * Input:  { cmd: string; args: string[]; cwd: string; env?: Record<string,string> }
 * Output: { status: number|null; signal: string|null; stdout: string; stderr: string }
 */

import { spawnSync } from 'node:child_process';
import { filteredEnv } from './shell-exec.js';

function main(): void {
  const raw = process.argv[2];
  if (!raw) {
    process.stderr.write('worker-entry: missing payload\n');
    process.exit(2);
  }
  let payload: { cmd: string; args: string[]; cwd: string; env?: Record<string, string> };
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`worker-entry: bad JSON: ${e}\n`);
    process.exit(2);
  }
  const { cmd, args, cwd, env } = payload;
  const child = spawnSync(cmd, args, {
    cwd,
    env: filteredEnv(env),
    shell: false,
    windowsHide: true,
  });
  const out = {
    status: child.status,
    signal: child.signal,
    stdout: child.stdout ? Buffer.from(child.stdout).toString('base64') : '',
    stderr: child.stderr ? Buffer.from(child.stderr).toString('base64') : '',
  };
  process.stdout.write(JSON.stringify(out));
}

main();