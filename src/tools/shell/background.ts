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

export function startBackground(command: string, cwd: string): string {
  const id = `job-${++counter}-${Date.now().toString(36)}`;
  const proc = spawn(command, { cwd, shell: true, windowsHide: true });
  const job: Job = { id, command, cwd, proc, output: '', start: Date.now() };
  jobs.set(id, job);
  proc.stdout?.on('data', (b: Buffer) => { job.output += b.toString(); if (job.output.length > 1_000_000) job.output = job.output.slice(-1_000_000); });
  proc.stderr?.on('data', (b: Buffer) => { job.output += b.toString(); if (job.output.length > 1_000_000) job.output = job.output.slice(-1_000_000); });
  proc.on('close', () => { /* keep for logs */ });
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
