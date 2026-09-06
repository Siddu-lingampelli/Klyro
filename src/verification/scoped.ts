/**
 * 6.3 — Scoped runs & sanity checks
 * Edited files → related tests (name match), scoped verify command, syntax + import checks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export function findRelatedTests(cwd: string, editedFiles: string[]): string[] {
  if (editedFiles.length === 0) return [];
  const allTests: string[] = [];
  // collect candidate test files via simple walk (respect .gitignore minimally)
  function walk(dir: string, depth = 0): void {
    if (depth > 6) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === '.klyro') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && /(?:\.test\.|\.spec\.|__tests__|test_)/.test(p)) allTests.push(p);
    }
  }
  walk(cwd);

  const related = new Set<string>();
  for (const edited of editedFiles) {
    const base = path.basename(edited, path.extname(edited)); // foo.ts -> foo
    const dir = path.dirname(edited);
    for (const t of allTests) {
      const tb = path.basename(t);
      // name match: foo.ts -> foo.test.ts, test_foo.py, foo_spec.ts, etc.
      if (tb.includes(base) || base.includes(path.basename(t, path.extname(t)).replace(/\.test|\.spec|test_/g, ''))) {
        related.add(path.relative(cwd, t));
      }
      // same directory prefix also counts
      if (t.startsWith(dir) && tb.includes(base.slice(0, 4))) related.add(path.relative(cwd, t));
    }
  }
  return [...related];
}

export function buildScopedCommand(cwd: string, baseCommand: string, relatedTests: string[]): string | null {
  if (relatedTests.length === 0) return null;
  if (relatedTests.length > 10) return null; // too many → full suite
  // npm test heuristic: npm test -- <files> or vitest/jest file list
  if (baseCommand.includes('npm test') || baseCommand.includes('pnpm test') || baseCommand.includes('yarn test') || baseCommand.includes('bun test')) {
    return `${baseCommand} -- ${relatedTests.map((f) => `"${f}"`).join(' ')}`;
  }
  if (baseCommand.includes('pytest')) {
    return `pytest ${relatedTests.map((f) => `"${f}"`).join(' ')}`;
  }
  if (baseCommand.includes('go test')) {
    // go test ./... with file filter — fallback to full
    return null;
  }
  if (baseCommand.includes('cargo test')) {
    // cargo test --test <name>
    return null;
  }
  return null;
}

const MAX_SCOPED_BYTES = 256 * 1024;
export async function runScopedVerify(cwd: string, command: string, timeoutMs = 45_000): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      const so = Buffer.concat(outChunks).toString('utf-8').slice(0, MAX_SCOPED_BYTES);
      const se = Buffer.concat(errChunks).toString('utf-8').slice(0, MAX_SCOPED_BYTES);
      resolve({ ok: false, exitCode: -1, stdout: so, stderr: se + '\n[scoped timeout]' });
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => { if (Buffer.concat(outChunks).length < MAX_SCOPED_BYTES) outChunks.push(b); });
    child.stderr.on('data', (b: Buffer) => { if (Buffer.concat(errChunks).length < MAX_SCOPED_BYTES) errChunks.push(b); });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const exit = typeof code === 'number' ? code : -1;
      const so = Buffer.concat(outChunks).toString('utf-8').slice(0, MAX_SCOPED_BYTES);
      const se = Buffer.concat(errChunks).toString('utf-8').slice(0, MAX_SCOPED_BYTES);
      resolve({ ok: exit === 0, exitCode: exit, stdout: so, stderr: se });
    });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const so = Buffer.concat(outChunks).toString('utf-8').slice(0, MAX_SCOPED_BYTES);
      resolve({ ok: false, exitCode: -1, stdout: so, stderr: String(err) });
    });
  });
}

/** Quick syntax check: try to parse file with node --check or tsc snippet */
export async function syntaxCheck(cwd: string, file: string): Promise<{ ok: boolean; error?: string }> {
  const full = path.join(cwd, file);
  const ext = path.extname(file);
  if (ext === '.ts' || ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    // Use tsc transpileModule if available, else node --check for js
    try {
      const content = fs.readFileSync(full, 'utf-8');
      // minimal check: try to parse via new Function (for js) or just check no obvious syntax error via tsc
      // For now, use tsc --noEmit --skipLibCheck on single file quickly
      if (ext === '.ts') {
        const ok = await new Promise<boolean>((resolve) => {
          const child = spawn('npx', ['tsc', '--noEmit', '--skipLibCheck', full], { cwd, shell: false, env: process.env });
          let done = false;
          const t = setTimeout(() => { if (!done) { done = true; try { child.kill(); } catch {} resolve(false); } }, 10_000);
          child.on('close', (code) => { if (done) return; done = true; clearTimeout(t); resolve(code === 0); });
          child.on('error', () => { if (done) return; done = true; clearTimeout(t); resolve(false); });
        });
        if (!ok) return { ok: false, error: `syntax error in ${file} (tsc)` };
        return { ok: true };
      }
      const ok2 = await new Promise<boolean>((resolve) => {
        const child = spawn(process.execPath, ['--check', full], { cwd, shell: false, env: process.env });
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; try { child.kill(); } catch {} resolve(false); } }, 5000);
        child.on('close', (code) => { if (done) return; done = true; clearTimeout(t); resolve(code === 0); });
        child.on('error', () => { if (done) return; done = true; clearTimeout(t); resolve(false); });
      });
      if (!ok2) return { ok: false, error: `syntax error in ${file} (node --check)` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  if (ext === '.py') {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn('python', ['-m', 'py_compile', full], { cwd, shell: false, env: process.env });
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; try { child.kill(); } catch {} resolve(false); } }, 5000);
      child.on('close', (code) => { if (done) return; done = true; clearTimeout(t); resolve(code === 0); });
      child.on('error', () => { if (done) return; done = true; clearTimeout(t); resolve(true); });
    });
    if (!ok) return { ok: false, error: `syntax error in ${file} (py_compile)` };
  }
  return { ok: true };
}

/** Import-path existence check (TS/JS): read file, extract imports, verify targets exist */
export function checkImports(cwd: string, file: string): { ok: boolean; missing: string[] } {
  const full = path.join(cwd, file);
  const ext = path.extname(file);
  if (!['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs'].includes(ext)) return { ok: true, missing: [] };
  let content = '';
  try { content = fs.readFileSync(full, 'utf-8'); } catch { return { ok: true, missing: [] }; }
  const importRe = /(?:import\s+.*?from\s+['"](.+?)['"]|require\(['"](.+?)['"]\))/g;
  const missing: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content))) {
    const spec = m[1] ?? m[2];
    if (!spec || !spec.startsWith('.')) continue; // only relative imports
    const target = path.resolve(path.dirname(full), spec);
    const candidates = [target, `${target}.ts`, `${target}.js`, `${target}/index.ts`, `${target}/index.js`, `${target}.tsx`];
    const exists = candidates.some((p) => fs.existsSync(p));
    if (!exists) missing.push(spec);
  }
  return { ok: missing.length === 0, missing };
}
