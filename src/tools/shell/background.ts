/**
 * 4.3 — Background shell: shell(run_in_background), bash_output, kill_shell, /jobs
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { findBlockedReason, filteredEnv } from './shell-exec.js';

interface Job {
  id: string;
  command: string;
  cwd: string;
  proc: ChildProcess;
  output: string;
  start: number;
}

const jobs = new Map<string, Job>();
let counter = 0;

const MAX_JOBS = 5;
const JOB_TTL_MS = 10 * 60 * 1000;

/** Tree-kill: proc.kill() alone leaves grandchildren behind (shell:true). */
function killTree(proc: ChildProcess): void {
  try {
    if (process.platform === 'win32') {
      if (proc.pid !== undefined) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true });
      }
    } else if (proc.pid !== undefined) {
      // Detached group kill when we own the group, else single kill.
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
    } else {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function watchJob(job: Job): void {
  // A failed spawn (bad cwd, missing shell) emits 'error' with no 'close'
  // guarantee — without a listener Node throws and takes down the process.
  job.proc.on('error', (e: Error) => {
    job.output += `\n[spawn failed: ${e?.message ?? e}]`;
  });
  job.proc.on('close', () => {
    setTimeout(() => { if (jobs.get(job.id)?.proc.exitCode !== null) jobs.delete(job.id); }, JOB_TTL_MS);
  });
}
function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const sorted = [...jobs.values()].sort((a, b) => a.start - b.start);
  for (const j of sorted.slice(0, jobs.size - MAX_JOBS)) {
    killTree(j.proc);
    jobs.delete(j.id);
  }
  for (const j of [...jobs.values()]) {
    if (Date.now() - j.start > JOB_TTL_MS && j.proc.exitCode !== null) jobs.delete(j.id);
  }
}
export function startBackground(command: string, cwd: string): string {
  pruneJobs();
  if (jobs.size >= MAX_JOBS) throw new Error(`Too many background jobs (max ${MAX_JOBS}) — kill one with /jobs`);
  // Same destructive-pattern gate as shell_exec (spawn is shell:true here too).
  const blocked = findBlockedReason(command);
  if (blocked) throw new Error(`Command blocked: ${blocked}`);
  const id = `job-${++counter}-${Date.now().toString(36)}`;
  // Filtered env, same call shape as shell_exec — background children must
  // not inherit secrets from the parent process. Detached on POSIX so
  // killTree can take the whole group (mirrors shell_exec).
  const proc = spawn(command, {
    cwd, shell: true, windowsHide: true, env: filteredEnv(),
    ...(process.platform === 'win32' ? {} : { detached: true }),
  });
  const job: Job = { id, command, cwd, proc, output: '', start: Date.now() };
  jobs.set(id, job);
  proc.stdout?.on('data', (b: Buffer) => { job.output += b.toString(); if (job.output.length > 1_000_000) job.output = job.output.slice(-1_000_000); });
  proc.stderr?.on('data', (b: Buffer) => { job.output += b.toString(); if (job.output.length > 1_000_000) job.output = job.output.slice(-1_000_000); });
  watchJob(job);
  return id;
}

/**
 * argv variant (shell:false) — no shell interpolation possible. Used for
 * constructed commands (e.g. opening an editor on a user-supplied path).
 */
export function startBackgroundArgv(argv: string[], cwd: string): string {
  pruneJobs();
  if (jobs.size >= MAX_JOBS) throw new Error(`Too many background jobs (max ${MAX_JOBS}) — kill one with /jobs`);
  if (argv.length === 0) throw new Error('startBackgroundArgv requires argv');
  const id = `job-${++counter}-${Date.now().toString(36)}`;
  // Filtered env, same call shape as shell_exec (see startBackground).
  const proc = spawn(argv[0]!, argv.slice(1), { cwd, shell: false, windowsHide: true, env: filteredEnv() });
  const job: Job = { id, command: argv.join(' '), cwd, proc, output: '', start: Date.now() };
  jobs.set(id, job);
  proc.stdout?.on('data', (b: Buffer) => { job.output += b.toString(); if (job.output.length > 1_000_000) job.output = job.output.slice(-1_000_000); });
  proc.stderr?.on('data', (b: Buffer) => { job.output += b.toString(); if (job.output.length > 1_000_000) job.output = job.output.slice(-1_000_000); });
  watchJob(job);
  return id;
}

export function getOutput(id: string, filter?: string): string {
  const job = jobs.get(id);
  if (!job) throw new Error(`No job ${id}`);
  if (filter) return job.output.split('\n').filter((l) => l.includes(filter)).join('\n');
  return job.output.slice(-5000);
}

export function killJob(id: string): void {
  const job = jobs.get(id);
  if (!job) throw new Error(`No job ${id}`);
  killTree(job.proc);
  jobs.delete(id);
}

/**
 * Abort cascade: kill every tracked background job. Called from the
 * runtime abort path and the REPL `/cancel` handler so a cancelled run
 * never leaks runaway shells. Returns the killed job ids for audit.
 */
export function killAllJobs(): string[] {
  const killed: string[] = [];
  for (const job of [...jobs.values()]) {
    killTree(job.proc);
    jobs.delete(job.id);
    killed.push(job.id);
  }
  return killed;
}

export function listJobs(): Array<{ id: string; command: string; cwd: string; running: boolean }> {
  return [...jobs.values()].map((j) => ({ id: j.id, command: j.command, cwd: j.cwd, running: j.proc.exitCode === null }));
}
