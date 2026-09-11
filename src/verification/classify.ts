/**
 * 6.4 — Repair classifier + context gather + guard
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { Failure, FailureType } from './detect.js';
import { detect } from './detect.js';
import type { BaselineResult } from './baseline.js';
import type { VerifyResult } from './engine.js';

export type FailureClass = 'introduced' | 'pre_existing' | 'flaky' | 'env';

interface FailureSignature {
  type: FailureType;
  files: Set<string>;
  exit: number;
}

function signatureOf(failure: Failure | undefined, fallbackExit: number): FailureSignature {
  return {
    type: failure?.type ?? 'unknown',
    files: new Set((failure?.files ?? []).map((f) => f.path).filter(Boolean)),
    exit: failure?.exitCode ?? fallbackExit,
  };
}

export function classifyFailure(
  current: { failure?: Failure; stdout: string; stderr: string },
  baseline: BaselineResult | null,
  flakyRerunOk?: boolean
): FailureClass {
  const combined = (current.stderr + '\n' + current.stdout).toLowerCase();
  // env: missing binary, network, permission, no such file, EACCES etc
  if (/enoent|command not found|no such file|network|econn|etimedout|eacces|permission denied|environment variable/.test(combined) && /error/i.test(combined)) {
    // only if not a real test failure but env
    if (!current.failure || current.failure.type === 'unknown') return 'env';
    // even test failures can be env if message hints
    if (/enoent|not found/.test(combined)) return 'env';
  }
  if (flakyRerunOk) return 'flaky';
  if (baseline && !baseline.ok) {
    // Structured signature compare (no substring matching): pre-existing
    // iff same failure type AND file-set overlap is non-empty (or same
    // exit + same type when both sides are fileless).
    const curSig = signatureOf(current.failure, -1);
    const baseFailure = detect(baseline.stdout, baseline.stderr, baseline.exitCode);
    const baseSig = signatureOf(baseFailure, baseline.exitCode);
    if (curSig.type !== 'unknown' && curSig.type === baseSig.type) {
      if (curSig.files.size > 0 && baseSig.files.size > 0) {
        for (const f of curSig.files) {
          if (baseSig.files.has(f)) return 'pre_existing';
        }
      } else if (curSig.files.size === 0 && baseSig.files.size === 0 && curSig.exit === baseSig.exit) {
        return 'pre_existing';
      }
    }
  }
  return 'introduced';
}

export async function rerunOnce(cwd: string, command: string, timeoutMs = 45_000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch {} resolve(false); } }, timeoutMs);
    child.on('close', (code) => { if (done) return; done = true; clearTimeout(t); resolve(code === 0); });
    child.on('error', () => { if (done) return; done = true; clearTimeout(t); resolve(false); });
  });
}

export interface RepairContext {
  failingTests: { file: string; content: string }[];
  hunks: string;
  blame: string;
}

export async function gatherRepairContext(cwd: string, failure: Failure | undefined): Promise<RepairContext> {
  const failingTests: { file: string; content: string }[] = [];
  if (failure) {
    for (const f of failure.files.slice(0, 3)) {
      if (!f.path) continue;
      const full = path.join(cwd, f.path);
      try {
        const raw = fs.readFileSync(full, 'utf-8');
        // slice around failing line if available
        const lines = raw.split('\n');
        const start = Math.max(0, (f.line ?? 1) - 20);
        const end = Math.min(lines.length, (f.line ?? 1) + 20);
        failingTests.push({ file: f.path, content: lines.slice(start, end).join('\n') });
      } catch { /* ignore */ }
    }
  }
  // hunks: git diff --stat + --unified=2 for changed files
  const hunks = await execCapturePipe(cwd, 'git diff --stat && echo "---" && git diff -U2 2>&1 | head -n 300');
  const blamePath = failure?.files[0]?.path;
  const blame = blamePath && /^[\w./-]+$/.test(blamePath) && !blamePath.includes('..')
    ? await execCaptureArgv(cwd, blamePath, ['--no-pager', 'blame', '--'])
    : '';
  return { failingTests, hunks, blame };
}

function execCapturePipe(cwd: string, cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, env: process.env });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => { chunks.push(b); });
    child.stderr.on('data', (b: Buffer) => { chunks.push(b); });
    child.on('close', () => resolve(Buffer.concat(chunks).toString().slice(0, 4000)));
    child.on('error', () => resolve(''));
  });
}

function execCaptureArgv(cwd: string, file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', [...args, file], { cwd, shell: false, env: process.env });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => { chunks.push(b); });
    child.stderr.on('data', (b: Buffer) => { chunks.push(b); });
    child.on('close', () => resolve(Buffer.concat(chunks).toString().split('\n').slice(0, 20).join('\n')));
    child.on('error', () => resolve(''));
  });
}

// Guard: does diff touch assertions or add skips?
const ASSERT_RE = /(?:expect\s*\(|assert\.|assert\(|should\.|chai\.)/;
const SKIP_RE = /(?:\.skip\(|\.todo\(|xdescribe\(|xit\(|xtest\(|@pytest\.mark\.skip|pytest\.skip|:\s*skip\b)/i;

export function guardRepair(diff: string, editedFiles: string[]): { blocked: boolean; reason?: string } {
  if (!diff) return { blocked: false };
  const addedLines = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const touchesAssert = addedLines.some((l) => ASSERT_RE.test(l));
  const addsSkip = addedLines.some((l) => SKIP_RE.test(l));
  if (touchesAssert && addedLines.length < 20) {
    // touching assertions in a small diff likely means editing test expectations — require approval
    return { blocked: true, reason: 'repair touches test assertions — requires explicit approval (edit expectations directly is discouraged)' };
  }
  if (addsSkip) {
    return { blocked: true, reason: 'repair adds skip/todo — requires explicit approval (skipping tests is not a fix)' };
  }
  return { blocked: false };
}
