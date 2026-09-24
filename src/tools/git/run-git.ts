import { spawn } from 'node:child_process';

export function runGit(args: string[], cwd: string, timeoutMs: number = 15_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out: Buffer.concat(out).toString('utf-8'), err: Buffer.concat(err).toString('utf-8') });
    });
  });
}
