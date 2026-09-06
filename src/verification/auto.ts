/**
 * Level 8 — auto-detect verification command from project.
 * Picks the most relevant check for the repo so the harness
 * can verify without explicit user config.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function detectVerifyCommand(cwd: string): string | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const raw = fs.readFileSync(pkgPath, 'utf-8');
      const json = JSON.parse(raw) as { scripts?: Record<string, string> };
      // Prefer test if available — it's the strongest signal
      if (json.scripts?.test) {
        if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm test';
        if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn test';
        if (fs.existsSync(path.join(cwd, 'bun.lockb'))) return 'bun test';
        return 'npm test';
      }
      if (json.scripts?.build) return 'npm run build';
    } catch {
      // ignore parse errors
    }
    if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) return 'npx tsc --noEmit';
  }
  if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) return 'npx tsc --noEmit';
  if (fs.existsSync(path.join(cwd, 'Makefile')) || fs.existsSync(path.join(cwd, 'makefile'))) return 'make test';
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'requirements.txt'))) return 'pytest';
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go test ./...';
  return null;
}

/** Human-readable reason why a command was chosen. */
export function describeVerifyCommand(cmd: string | null): string {
  if (!cmd) return 'no verification command auto-detected';
  if (cmd.includes('test')) return `auto-detected: ${cmd}`;
  if (cmd.includes('tsc')) return `auto-detected: ${cmd} (typecheck)`;
  return `auto-detected: ${cmd}`;
}
