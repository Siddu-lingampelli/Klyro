/**
 * Verification engine — run a command, classify failures, and run a
 * bounded repair loop. The model is asked to fix the same task again
 * with the structured diagnostic injected as a user message.
 *
 * On success: returns { ok: true }.
 * On failure: returns { ok: false, failure } with the most recent
 * structured Failure (and the model has had up to N attempts to fix).
 */

import { spawn } from 'node:child_process';
import { detect, summarize, type Failure, type FailureType } from './detect.js';
import { redact } from '../policy/secret-redactor.js';

export interface VerifyOptions {
  cwd: string;
  command: string;
  timeoutMs?: number;
}

export interface VerifyResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  failure?: Failure;
}

const MAX_VERIFY_BYTES = 256 * 1024;
function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_VERIFY_BYTES) return current;
  const next = current + chunk;
  return next.length > MAX_VERIFY_BYTES ? next.slice(0, MAX_VERIFY_BYTES) + '\n... [truncated]' : next;
}

// SEC-004: denylist for dangerous patterns in verify commands.
// Destructive-only: the verify command comes from CLI flags, project config,
// or auto-detected package scripts (never model-controlled), so shell
// metacharacters ($(), backticks, pipes) that are legitimate in test scripts
// are allowed here — unlike shell_exec's model-facing denylist.
const DANGEROUS_VERIFY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-rf?\s+\//, reason: 'recursive delete at filesystem root' },
  { pattern: /rm\s+-rf?\s+\/\/+/, reason: 'recursive delete at filesystem root (//)' },
  { pattern: /rm\s+-rf?\s+\/\*/, reason: 'recursive delete at filesystem root (/*)' },
  { pattern: /rm\s+-rf?\s+\.\s*($|[;&|])/, reason: 'recursive delete current directory' },
  { pattern: /rm\s+-rf?\s+\*\s*($|[;&|])/, reason: 'recursive delete all files via *' },
  { pattern: /rm\s+-rf?\s+\.\/\*\s*($|[;&|])/, reason: 'recursive delete all files' },
  { pattern: /rm\s+-rf?\s+~(\/|$)/, reason: 'recursive delete home directory via ~' },
  { pattern: /rm\s+-rf?\s+\$HOME\b/, reason: 'recursive delete home via $HOME' },
  { pattern: /rm\s+-rf?\s+\$PWD\b/, reason: 'recursive delete via $PWD' },
  { pattern: /del\s+\/s\s+\/q\s+[a-z]:\\/i, reason: 'recursive delete on Windows drive root' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { pattern: /bomb\(\)\s*\{\s*bomb\|bomb/, reason: 'fork bomb variant' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'overwrite raw block device' },
  { pattern: /mkfs(\.|\s)/, reason: 'format filesystem' },
  { pattern: /dd\s+.*of=\/dev\//, reason: 'dd write to device' },
  { pattern: /chmod\s+-R\s+777\s+\//, reason: 'chmod 777 on root' },
  { pattern: /curl.*\|\s*(sh|bash|zsh|python|python3|perl|ruby|php)/i, reason: 'curl|sh to unknown host' },
  { pattern: /wget.*\|\s*(sh|bash|python|perl|ruby)/i, reason: 'wget|sh pipe' },
  { pattern: /rm\s+-rf\s+--no-preserve-root\s+\//, reason: 'recursive delete --no-preserve-root' },
  { pattern: /;\s*rm\s+-rf/, reason: 'chained rm -rf' },
  { pattern: /&&\s*rm\s+-rf/, reason: 'chained rm -rf' },
  { pattern: /\|\|\s*rm\s+-rf/, reason: 'chained rm -rf' },
];

export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  // SEC-004: reject dangerous patterns before spawning
  for (const { pattern, reason } of DANGEROUS_VERIFY_PATTERNS) {
    if (pattern.test(opts.command)) {
      return {
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: `Command blocked: ${reason}`,
        failure: { type: 'runtime' as FailureType, files: [], raw: `Command blocked: ${reason}`, exitCode: -1 },
      };
    }
  }
  const timeout = opts.timeoutMs ?? 5 * 60 * 1000;
  return new Promise((resolve) => {
    const child = spawn(opts.command, { cwd: opts.cwd, shell: true, env: process.env });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      child.kill();
      done = true;
      const so = Buffer.concat(outChunks).toString('utf-8').slice(0, MAX_VERIFY_BYTES);
      const se = Buffer.concat(errChunks).toString('utf-8').slice(0, MAX_VERIFY_BYTES);
      const raw = se + '\n' + so;
      resolve({
        ok: false,
        exitCode: -1,
        stdout: so,
        stderr: se + '\n[verify timeout]',
        failure: { type: 'runtime' as FailureType, files: [], raw, exitCode: -1 },
      });
    }, timeout);

    child.stdout.on('data', (b: Buffer) => { if (Buffer.concat(outChunks).length < MAX_VERIFY_BYTES) outChunks.push(b); });
    child.stderr.on('data', (b: Buffer) => { if (Buffer.concat(errChunks).length < MAX_VERIFY_BYTES) errChunks.push(b); });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const so = Buffer.concat(outChunks).toString('utf-8').slice(0, MAX_VERIFY_BYTES);
      const se = Buffer.concat(errChunks).toString('utf-8').slice(0, MAX_VERIFY_BYTES);
      const exit = typeof code === 'number' ? code : -1;
      if (exit === 0) {
        resolve({ ok: true, exitCode: 0, stdout: so, stderr: se });
        return;
      }
      const failure = detect(so, se, exit);
      resolve({ ok: false, exitCode: exit, stdout: so, stderr: se, failure });
    });
  });
}

/** Format a failure for injection into the model's transcript. */
export function diagnosticForModel(result: VerifyResult): string {
  if (result.ok) return 'Verification passed.';
  if (!result.failure) return `Verification failed with exit ${result.exitCode}.`;
  // redact raw before summarizing so secrets don't enter transcript
  const redactedRaw = redact(result.failure.raw);
  const redactedFailure: Failure = { ...result.failure, raw: redactedRaw, files: result.failure.files.map((f) => ({ ...f, message: redact(f.message) })) };
  return summarize(redactedFailure);
}
