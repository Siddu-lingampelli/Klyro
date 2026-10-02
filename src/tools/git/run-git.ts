import { spawn } from 'node:child_process';

export function runGit(args: string[], cwd: string, timeoutMs: number = 15_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      resolve({ code: 1, out: Buffer.concat(out).toString('utf-8'), err: 'git timed out' });
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    // Missing git binary / bad cwd emits 'error' with no 'close' — without
    // this every caller hangs to its own timeout instead of failing fast.
    child.on('error', (e: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: 1, out: Buffer.concat(out).toString('utf-8'), err: String(e?.message ?? e) });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, out: Buffer.concat(out).toString('utf-8'), err: Buffer.concat(err).toString('utf-8') });
    });
  });
}
