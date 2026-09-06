/**
 * Failure-type classifier + diagnostic parser. Given the stderr/stdout of
 * a verify command, decide which kind of failure it represents and pull
 * out a structured Failure object the runtime can feed back to the model.
 *
 * Supported types: 'type' (TypeScript tsc), 'test' (vitest/jest/mocha),
 * 'lint' (eslint), 'build' (esbuild/webpack/tsc bundled), 'runtime'
 * (uncaught exception).
 *
 * This is intentionally a heuristic, not a parser. The model still sees
 * the raw output; we just pre-structure the high-signal lines.
 */

export type FailureType = 'type' | 'test' | 'lint' | 'build' | 'runtime' | 'unknown';

export interface FailureFile {
  path: string;
  line?: number;
  column?: number;
  message: string;
  code?: string;
}

export interface Failure {
  type: FailureType;
  files: FailureFile[];
  raw: string;
  exitCode: number;
}

const TS_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
const TEST_FAIL = /^\s*✘|FAIL\s+(\S+)|✗\s+(\S+)|×\s+(.+?)\s/;
const LINT_LINE = /^(.+?)\s*$/;
const RUNTIME_LINE = /^(?:Error|TypeError|ReferenceError):\s+(.+)$/;

export function detect(stdout: string, stderr: string, exitCode: number): Failure {
  const combined = stderr + '\n' + stdout;

  if (exitCode === 0) {
    return { type: 'unknown', files: [], raw: combined, exitCode };
  }

  // TypeScript tsc.
  const tsMatches: FailureFile[] = [];
  for (const line of combined.split(/\r?\n/)) {
    const m = TS_LINE.exec(line);
    if (m && m[1] && m[2] && m[3] && m[4] && m[5]) {
      tsMatches.push({ path: m[1], line: Number(m[2]), column: Number(m[3]), code: m[4], message: m[5] });
    }
  }
  if (tsMatches.length > 0) return { type: 'type', files: tsMatches, raw: combined, exitCode };

  // Test runner.
  if (/Test Suites:|FAIL\s|Tests:.*failed|✘|✗/.test(combined)) {
    const files: FailureFile[] = [];
    for (const line of combined.split(/\r?\n/)) {
      const m = TEST_FAIL.exec(line);
      if (m) {
        const target = m[1] ?? m[2] ?? m[3] ?? line.trim();
        files.push({ path: target, message: line.trim() });
      }
    }
    return { type: 'test', files, raw: combined, exitCode };
  }

  // ESLint.
  if (/error\s+at\s+|eslint.*problem|✖/.test(combined)) {
    return { type: 'lint', files: extractFirstLines(combined, 5), raw: combined, exitCode };
  }

  // Runtime exception.
  const lines = combined.split(/\r?\n/);
  const rt = lines.some((l) => RUNTIME_LINE.test(l));
  if (rt) {
    return { type: 'runtime', files: extractFirstLines(combined, 5), raw: combined, exitCode };
  }

  // Generic build.
  if (/error/i.test(combined)) {
    return { type: 'build', files: extractFirstLines(combined, 5), raw: combined, exitCode };
  }

  return { type: 'unknown', files: extractFirstLines(combined, 3), raw: combined, exitCode };
}

function extractFirstLines(s: string, n: number): FailureFile[] {
  return s
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, n)
    .map((message) => ({ path: '', message }));
}

/** Build a short, structured summary the model can act on. */
export function summarize(failure: Failure): string {
  if (failure.files.length === 0) {
    return `Verification failed (exit ${failure.exitCode}, type=${failure.type}). No structured files parsed; see raw output below.\n\n${truncate(failure.raw, 2000)}`;
  }
  const lines: string[] = [`Verification failed (${failure.type}, exit ${failure.exitCode}).`];
  for (const f of failure.files.slice(0, 8)) {
    const loc = f.line ? `:${f.line}${f.column ? `:${f.column}` : ''}` : '';
    const code = f.code ? ` [${f.code}]` : '';
    lines.push(`- ${f.path}${loc}${code} — ${f.message}`);
  }
  lines.push('');
  lines.push('Raw output (truncated):');
  lines.push(truncate(failure.raw, 1500));
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n... [truncated]' : s;
}
