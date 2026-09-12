/**
 * `klyro commit` — conventional commit of already-staged changes.
 *
 * Steps:
 *   (a) `git status --porcelain` must show staged entries (index column set).
 *       Nothing staged → error 'nothing staged (git add first)', exit 2.
 *       (`--yes` never bypasses this — there is nothing to commit.)
 *   (b) Secret-scan the staged diff via `redact()`: if redaction shrinks or
 *       alters the diff, refuse and list the files (exit 2) unless
 *       `--force-secret` is passed.
 *   (c) Build a conventional message: type heuristic + top-dir scope +
 *       `--message` summary (or `update <n> files`).
 *   (d) `git commit -m` via execFileSync (no shell). Verification hooks always
 *       run — by construction this file contains no flag that skips them.
 *   (e) `--dry-run` prints the message + files and exits 0 without committing.
 */

import { execFileSync } from 'node:child_process';
import { redact } from '../policy/secret-redactor.js';

export interface CommitOptions {
  cwd: string;
  yes?: boolean;
  dryRun?: boolean;
  message?: string;
  forceSecret?: boolean;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** Porcelain XY: staged iff the index (first) column is set. Handles renames. */
export function stagedFilesFromPorcelain(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    const indexStatus = line[0];
    if (indexStatus === ' ' || indexStatus === '?' || indexStatus === '!') continue;
    let file = line.slice(3).trim();
    // Rename/copy form: "old -> new" — the new path is what's committed.
    const arrow = file.indexOf(' -> ');
    if (arrow !== -1) file = file.slice(arrow + 4);
    // Quoted paths from core.quotePath — strip surrounding quotes.
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
    if (file) out.push(file);
  }
  return out;
}

const LOCKFILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock',
  'Gemfile.lock', 'poetry.lock', 'composer.lock',
]);

function isTestPath(f: string): boolean {
  const l = f.toLowerCase();
  return (
    l.includes('.test.') || l.includes('.spec.') ||
    l.includes('__tests__') || /(^|\/)tests?\//.test(l) || /(^|\/)spec\//.test(l)
  );
}

function isDocsPath(f: string): boolean {
  const l = f.toLowerCase();
  return l.endsWith('.md') || l.startsWith('docs/') || l.includes('/docs/');
}

/** Type heuristic: test-only→test, docs-only→docs, lockfiles→chore, else feat. */
export function commitTypeFor(files: string[]): string {
  if (files.length > 0 && files.every((f) => LOCKFILES.has(f.split('/').pop() ?? f))) return 'chore';
  if (files.length > 0 && files.every(isTestPath)) return 'test';
  if (files.length > 0 && files.every(isDocsPath)) return 'docs';
  return 'feat';
}

/** Scope = most common top-level dir among staged files with a dir; '' if none. */
export function commitScopeFor(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const slash = f.indexOf('/');
    if (slash > 0) {
      const top = f.slice(0, slash);
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
  }
  let best = '';
  let bestN = 0;
  for (const [dir, n] of counts) {
    if (n > bestN) { best = dir; bestN = n; }
  }
  return best;
}

export function buildCommitMessage(files: string[], summaryOpt?: string): string {
  const type = commitTypeFor(files);
  const scope = commitScopeFor(files);
  const summary = (summaryOpt ?? '').trim() || `update ${files.length} file${files.length === 1 ? '' : 's'}`;
  return scope ? `${type}(${scope}): ${summary}` : `${type}: ${summary}`;
}

export async function runCommit(opts: CommitOptions): Promise<number> {
  void opts.yes; // accepted for uniformity; never bypasses the staged check
  const cwd = opts.cwd;
  let porcelain: string;
  try {
    porcelain = git(cwd, ['status', '--porcelain']);
  } catch (err) {
    process.stderr.write(`klyro: commit: not a git repo or git unavailable (${err instanceof Error ? err.message.split('\n')[0] : String(err)})\n`);
    return 2;
  }
  const staged = stagedFilesFromPorcelain(porcelain);
  if (staged.length === 0) {
    process.stderr.write('klyro: commit: nothing staged (git add first)\n');
    return 2;
  }
  let namesOnly: string[];
  try {
    namesOnly = git(cwd, ['diff', '--cached', '--name-only']).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    namesOnly = staged;
  }
  const files = namesOnly.length > 0 ? namesOnly : staged;
  // (b) secret scan of the staged diff (read-only — redact() never writes).
  try {
    const diff = git(cwd, ['diff', '--cached', '--']);
    if (redact(diff) !== diff && !opts.forceSecret) {
      process.stderr.write(
        `klyro: commit: refused — possible secret in staged diff (files: ${files.join(', ')}). Review with \`git diff --cached\`, unstage the secret, or re-run with --force-secret.\n`,
      );
      return 2;
    }
  } catch {
    // Could not read the diff — proceed; the commit itself is authoritative.
  }
  const message = buildCommitMessage(files, opts.message);
  if (opts.dryRun) {
    process.stdout.write(`${message}\nfiles:\n${files.map((f) => `  ${f}`).join('\n')}\n`);
    return 0;
  }
  try {
    // NOTE: verification hooks must run — no skip flag is ever passed here.
    execFileSync('git', ['commit', '-m', message], { cwd, stdio: 'inherit' });
  } catch {
    process.stderr.write('klyro: commit: `git commit` failed (see output above)\n');
    return 1;
  }
  return 0;
}
