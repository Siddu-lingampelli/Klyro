/**
 * 6.1 — Baseline run (pre-existing failure cache per HEAD)
 * Before first edit, run primary verifier and cache result keyed by git HEAD.
 * Used to distinguish introduced vs pre-existing failures (6.4 classify).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { primaryVerifyCommand } from './registry.js';

export interface BaselineResult {
  head: string;
  command: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  capturedAt: number;
}

async function gitHead(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd, shell: false });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('close', () => resolve(out.trim() || 'no-head'));
    child.on('error', () => resolve('no-head'));
  });
}

function baselinePath(cwd: string, head: string): string {
  const safe = head.slice(0, 12) || 'no-head';
  return path.join(cwd, '.klyro', 'baselines', `${safe}.json`);
}

export async function getBaseline(cwd: string, command?: string): Promise<BaselineResult | null> {
  const cmd = command ?? primaryVerifyCommand(cwd);
  if (!cmd) return null;
  const head = await gitHead(cwd);
  const p = baselinePath(cwd, head);
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as BaselineResult;
    if (parsed.head === head && parsed.command === cmd) return parsed;
  } catch { /* miss */ }
  return null;
}

export async function runBaseline(cwd: string, command?: string, timeoutMs = 90_000): Promise<BaselineResult | null> {
  const cmd = command ?? primaryVerifyCommand(cwd);
  if (!cmd) return null;
  const head = await gitHead(cwd);
  const p = baselinePath(cwd, head);
  // if cached, return
  const cached = await getBaseline(cwd, cmd);
  if (cached) return cached;

  const result = await runCmd(cwd, cmd, timeoutMs);
  const baseline: BaselineResult = {
    head,
    command: cmd,
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 8000),
    stderr: result.stderr.slice(0, 8000),
    capturedAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(baseline, null, 2));
    fs.renameSync(tmp, p);
  } catch { /* ignore */ }
  return baseline;
}

function runCmd(cwd: string, command: string, timeoutMs: number): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, exitCode: -1, stdout, stderr: stderr + '\n[baseline timeout]' });
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const exit = typeof code === 'number' ? code : -1;
      resolve({ ok: exit === 0, exitCode: exit, stdout, stderr });
    });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, exitCode: -1, stdout, stderr: String(err) });
    });
  });
}

export async function ensureBaseline(cwd: string, command?: string): Promise<BaselineResult | null> {
  const existing = await getBaseline(cwd, command);
  if (existing) return existing;
  return runBaseline(cwd, command);
}
