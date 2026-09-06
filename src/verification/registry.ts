/**
 * 6.1 — Verifier registry
 * Detects available verifiers from project heuristics (package.json / Makefile / pyproject / Cargo).
 * Each verifier is a named command that can be run via `verify` engine.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type VerifierKind = 'tests' | 'typecheck' | 'lint' | 'build' | 'format-check' | 'custom';

export interface Verifier {
  id: VerifierKind;
  label: string;
  command: string;
  priority: number;
}

function exists(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch { return null; }
}

function pm(cwd: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (exists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(cwd, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function runCmd(base: string, cwd: string): string {
  const m = pm(cwd);
  if (base === 'test') return `${m} test`;
  if (base === 'build') return `${m} run build`;
  if (base === 'lint') return `${m} run lint`;
  return `${m} run ${base}`;
}

export function detectVerifiers(cwd: string): Verifier[] {
  const out: Verifier[] = [];
  const pkg = readJson(path.join(cwd, 'package.json')) as { scripts?: Record<string, string> } | null;
  const hasPkg = !!pkg;

  // tests — highest priority
  if (hasPkg && pkg?.scripts?.test) {
    out.push({ id: 'tests', label: 'tests', command: runCmd('test', cwd), priority: 10 });
  } else if (exists(path.join(cwd, 'pyproject.toml')) || exists(path.join(cwd, 'requirements.txt')) || exists(path.join(cwd, 'setup.py'))) {
    // pytest heuristic — check pyproject for pytest
    out.push({ id: 'tests', label: 'pytest', command: 'pytest', priority: 10 });
  } else if (exists(path.join(cwd, 'go.mod'))) {
    out.push({ id: 'tests', label: 'go test', command: 'go test ./...', priority: 10 });
  } else if (exists(path.join(cwd, 'Cargo.toml'))) {
    out.push({ id: 'tests', label: 'cargo test', command: 'cargo test', priority: 10 });
  } else if (exists(path.join(cwd, 'Makefile')) || exists(path.join(cwd, 'makefile'))) {
    try {
      const mk = fs.readFileSync(path.join(cwd, exists(path.join(cwd, 'Makefile')) ? 'Makefile' : 'makefile'), 'utf-8');
      if (/^test:/m.test(mk)) out.push({ id: 'tests', label: 'make test', command: 'make test', priority: 10 });
    } catch { /* ignore */ }
  }

  // typecheck
  if (exists(path.join(cwd, 'tsconfig.json'))) {
    out.push({ id: 'typecheck', label: 'tsc', command: 'npx tsc --noEmit', priority: 20 });
  } else if (exists(path.join(cwd, 'pyproject.toml'))) {
    try {
      const py = fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf-8');
      if (py.includes('mypy')) out.push({ id: 'typecheck', label: 'mypy', command: 'mypy .', priority: 20 });
    } catch { /* ignore */ }
  }

  // lint — check for eslint config or lint script
  if (hasPkg && pkg?.scripts?.lint) {
    out.push({ id: 'lint', label: 'lint', command: runCmd('lint', cwd), priority: 30 });
  } else if (exists(path.join(cwd, '.eslintrc.json')) || exists(path.join(cwd, '.eslintrc.js')) || exists(path.join(cwd, '.eslintrc.cjs')) || exists(path.join(cwd, 'eslint.config.js')) || exists(path.join(cwd, 'eslint.config.cjs')) || exists(path.join(cwd, 'eslint.config.mjs'))) {
    out.push({ id: 'lint', label: 'eslint', command: 'npx eslint .', priority: 30 });
  } else if (exists(path.join(cwd, 'ruff.toml')) || exists(path.join(cwd, '.ruff.toml')) || exists(path.join(cwd, 'pyproject.toml'))) {
    try {
      if (exists(path.join(cwd, 'pyproject.toml'))) {
        const py2 = fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf-8');
        if (py2.includes('[tool.ruff]')) out.push({ id: 'lint', label: 'ruff', command: 'ruff check .', priority: 30 });
      }
    } catch { /* ignore */ }
  }

  // build
  if (hasPkg && pkg?.scripts?.build) {
    out.push({ id: 'build', label: 'build', command: runCmd('build', cwd), priority: 40 });
  }

  // format-check
  if (exists(path.join(cwd, '.prettierrc')) || exists(path.join(cwd, '.prettierrc.json')) || exists(path.join(cwd, 'prettier.config.js')) || exists(path.join(cwd, '.prettierrc.cjs'))) {
    out.push({ id: 'format-check', label: 'prettier', command: 'npx prettier --check .', priority: 50 });
  } else if (hasPkg && pkg?.scripts?.['format:check']) {
    out.push({ id: 'format-check', label: 'format:check', command: runCmd('format:check', cwd), priority: 50 });
  }

  return out.sort((a, b) => a.priority - b.priority);
}

export function primaryVerifyCommand(cwd: string): string | null {
  const v = detectVerifiers(cwd);
  return v[0]?.command ?? null;
}

export interface VerifySettings {
  commands?: string[];
  onEdit?: boolean;
  afterChange?: boolean;
  beforeDone?: boolean;
  maxRepairs?: number;
  requireVerify?: boolean;
}

export function resolveVerifySettings(raw: Record<string, unknown> | undefined): VerifySettings {
  if (!raw || typeof raw !== 'object') return {};
  const v = (raw as Record<string, unknown>).verify as Record<string, unknown> | undefined;
  if (!v || typeof v !== 'object') return {};
  return {
    commands: Array.isArray(v.commands) ? (v.commands as string[]) : undefined,
    onEdit: typeof v.onEdit === 'boolean' ? v.onEdit : undefined,
    afterChange: typeof v.afterChange === 'boolean' ? v.afterChange : undefined,
    beforeDone: typeof v.beforeDone === 'boolean' ? v.beforeDone : undefined,
    maxRepairs: typeof v.maxRepairs === 'number' ? v.maxRepairs : undefined,
    requireVerify: typeof v.requireVerify === 'boolean' ? v.requireVerify : undefined,
  };
}
