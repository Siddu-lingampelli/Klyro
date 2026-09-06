/**
 * 4.3 — Background shell: shell(run_in_background), bash_output, kill_shell, /jobs
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

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
function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const sorted = [...jobs.values()].sort((a, b) => a.start - b.start);
  for (const j of sorted.slice(0, jobs.size - MAX_JOBS)) {
    try { j.proc.kill('SIGKILL'); } catch { /* ignore */ }
    jobs.delete(j.id);
  }
  for (const j of [...jobs.values()]) {
    if (Date.now() - j.start > JOB_TTL_MS && j.proc.exitCode !== null) jobs.delete(j.id);
  }
}
export function startBackground(command: string, cwd: string): string {
  pruneJobs();
  if (jobs.size >= MAX_JOBS) throw new Error(`Too many background jobs (max ${MAX_JOBS}) — kill one with /jobs`);
  const id = `job-${++counter}-${Date.now().toString(36)}`;
  const proc = spawn(command, { cwd, shell: true, windowsHide: true });
  const job: Job = { id, command, cwd, proc, output: '', start: Date.now() };
  jobs.set(id, job);
  proc.stdout?.on('data', (b: Buffer) => { job.output += b.toString(); if (job.output.length > 1_000_000) job.output = job.output.slice(-1_000_000); });
  proc.stderr?.on('data', (b: Buffer) => { job.output += b.toString(); if (job.output.length > 1_000_000) job.output = job.output.slice(-1_000_000); });
  proc.on('close', () => {
    setTimeout(() => { if (jobs.get(id)?.proc.exitCode !== null) jobs.delete(id); }, JOB_TTL_MS);
  });
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
  try { job.proc.kill('SIGKILL'); } catch { /* ignore */ }
  jobs.delete(id);
}

export function listJobs(): Array<{ id: string; command: string; cwd: string; running: boolean }> {
  return [...jobs.values()].map((j) => ({ id: j.id, command: j.command, cwd: j.cwd, running: j.proc.exitCode === null }));
}
