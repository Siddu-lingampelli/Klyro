import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { runCommit, buildCommitMessage, commitTypeFor } from './commit.js';

const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-commit-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

/** Capture stdout+stderr writes for the duration of fn(). */
async function capture<T>(fn: () => Promise<T>): Promise<{ out: string; err: string; value: T }> {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error — overloads are not worth modelling
  process.stdout.write = (chunk: string | Uint8Array, ..._rest: unknown[]) => {
    outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  };
  // @ts-expect-error — overloads are not worth modelling
  process.stderr.write = (chunk: string | Uint8Array, ..._rest: unknown[]) => {
    errChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  };
  try {
    const value = await fn();
    return {
      out: Buffer.concat(outChunks).toString('utf8'),
      err: Buffer.concat(errChunks).toString('utf8'),
      value,
    };
  } finally {
    process.stdout.write = origOut as typeof process.stdout.write;
    process.stderr.write = origErr as typeof process.stderr.write;
  }
}

describe.runIf(gitAvailable)('runCommit', () => {
  let dir = '';
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('errors 2 with "nothing staged" when nothing is staged', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n', 'utf-8');
    const r = await capture(() => runCommit({ cwd: dir }));
    expect(r.value).toBe(2);
    expect(r.err).toContain('nothing staged (git add first)');
  });

  it('dryRun prints message + files and exits 0 without committing', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n', 'utf-8');
    execFileSync('git', ['add', 'a.txt'], { cwd: dir, stdio: 'ignore' });
    const r = await capture(() => runCommit({ cwd: dir, dryRun: true }));
    expect(r.value).toBe(0);
    expect(r.out).toContain('feat: update 1 file');
    expect(r.out).toContain('a.txt');
    // No commit created
    expect(() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: 'ignore' })).toThrow();
  });

  it('commits staged changes with a conventional message', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n', 'utf-8');
    execFileSync('git', ['add', 'a.txt'], { cwd: dir, stdio: 'ignore' });
    const code = await runCommit({ cwd: dir, message: 'add a' });
    expect(code).toBe(0);
    const log = execFileSync('git', ['log', '--format=%s', '-1'], { cwd: dir, encoding: 'utf-8' }).toString().trim();
    expect(log).toBe('feat: add a');
  });

  it('refuses staged secrets unless --force-secret', async () => {
    fs.writeFileSync(path.join(dir, 'key.txt'), 'token sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX\n', 'utf-8');
    execFileSync('git', ['add', 'key.txt'], { cwd: dir, stdio: 'ignore' });
    const refused = await capture(() => runCommit({ cwd: dir, dryRun: true }));
    expect(refused.value).toBe(2);
    expect(refused.err).toContain('possible secret');
    expect(refused.err).toContain('key.txt');
    const forced = await capture(() => runCommit({ cwd: dir, dryRun: true, forceSecret: true }));
    expect(forced.value).toBe(0);
  });

  it('never skips verification hooks (by construction)', async () => {
    const src = fs.readFileSync(new URL('./commit.ts', import.meta.url), 'utf-8');
    expect(src).not.toContain('--no-verify');
  });
});

describe('commit message heuristics', () => {
  it('test-only → test, docs-only → docs, lockfiles → chore, else feat', () => {
    expect(commitTypeFor(['src/foo.test.ts', 'tests/bar.test.ts'])).toBe('test');
    expect(commitTypeFor(['README.md', 'docs/guide.md'])).toBe('docs');
    expect(commitTypeFor(['package-lock.json', 'pnpm-lock.yaml'])).toBe('chore');
    expect(commitTypeFor(['src/a.ts', 'README.md'])).toBe('feat');
  });

  it('scope comes from the top dir', () => {
    expect(buildCommitMessage(['src/cli/run.ts', 'src/cli/repl.ts'], 'add x')).toBe('feat(src): add x');
    expect(buildCommitMessage(['a.txt'], 'add a')).toBe('feat: add a');
    expect(buildCommitMessage(['a.txt', 'b.txt'])).toBe('feat: update 2 files');
  });
});
