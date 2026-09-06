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

export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  const timeout = opts.timeoutMs ?? 5 * 60 * 1000;
  return new Promise((resolve) => {
    const child = spawn(opts.command, { cwd: opts.cwd, shell: true, env: process.env });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      child.kill();
      done = true;
      const raw = stderr + '\n' + stdout;
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: stderr + '\n[verify timeout]',
        failure: { type: 'runtime' as FailureType, files: [], raw, exitCode: -1 },
      });
    }, timeout);

    child.stdout.on('data', (b: Buffer) => { stdout = appendCapped(stdout, b.toString()); });
    child.stderr.on('data', (b: Buffer) => { stderr = appendCapped(stderr, b.toString()); });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const exit = typeof code === 'number' ? code : -1;
      if (exit === 0) {
        resolve({ ok: true, exitCode: 0, stdout, stderr });
        return;
      }
      const failure = detect(stdout, stderr, exit);
      resolve({ ok: false, exitCode: exit, stdout, stderr, failure });
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
