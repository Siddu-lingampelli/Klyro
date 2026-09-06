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
const TSC_LINE2 = /^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s+(.+)$/;
const TEST_FAIL = /^\s*✘|FAIL\s+(\S+)|✗\s+(\S+)|×\s+(.+?)\s/;
const RUNTIME_LINE = /^(?:Error|TypeError|ReferenceError):\s+(.+)$/;

// 6.2 — dedicated patterns for each runner/linter/compiler
const PYTEST_FAIL = /FAILED\s+(\S+?)(?:::\S+)?\s+-\s+(.+)/;
const PYTEST_ASSERT = /AssertionError:\s*(.+)/;
const GO_FAIL = /^---\s+FAIL:\s+(\S+)\s+\((.+)\)/;
const GO_PKG_FAIL = /^FAIL\s+(\S+)\s/;
const CARGO_FAIL = /^test\s+(\S+)\s+\.\.\.\s+FAILED/;
const CARGO_PANIC = /thread\s+'(.+?)'\s+panicked at\s+'(.+?)',\s+(.+?):(\d+):(\d+)/;
const MOCHA_FAIL = /^\s*\d+\)\s+(.+)$/;
const JUNIT_FAIL = /<(?:failure|error)[\s>]/;
const ESLINT_LINE = /^(.+?):(\d+):(\d+):\s+(error|warning)\s+(.+?)\s+\((.+?)\)\s*$/;
const RUFF_LINE = /^(.+?):(\d+):(\d+):\s+([A-Z]\d+)\s+(.+)$/;
const MYPY_LINE = /^(.+?):(\d+):\s+error:\s+(.+?)\s+\[(.+?)\]\s*$/;
const GCC_LINE = /^(.+?):(\d+):(\d+):\s+(?:fatal\s+)?error:\s+(.+)$/;
const VITE_ERROR = /ERROR\s+in\s+(.+)|Module build failed.+/;
const DOTNET_CS = /^(.+?)\((\d+),(\d+)\):\s+error\s+(CS\d+):\s+(.+)$/;
const GENERIC_FILE_LINE = /^(.+?):(\d+)(?::(\d+))?:\s*(.+)$/;

export function detect(stdout: string, stderr: string, exitCode: number): Failure {
  const combined = stderr + '\n' + stdout;

  if (exitCode === 0) {
    return { type: 'unknown', files: [], raw: combined, exitCode };
  }

  // TypeScript tsc (both formats)
  const tsMatches: FailureFile[] = [];
  for (const line of combined.split(/\r?\n/)) {
    let m = TS_LINE.exec(line);
    if (m && m[1] && m[2] && m[3] && m[4] && m[5]) {
      tsMatches.push({ path: m[1], line: Number(m[2]), column: Number(m[3]), code: m[4], message: m[5] });
      continue;
    }
    m = TSC_LINE2.exec(line);
    if (m && m[1] && m[2] && m[3] && m[4] && m[5]) {
      tsMatches.push({ path: m[1], line: Number(m[2]), column: Number(m[3]), code: m[4], message: m[5] });
    }
    const dm = DOTNET_CS.exec(line);
    if (dm && dm[1] && dm[2] && dm[3] && dm[4] && dm[5]) {
      tsMatches.push({ path: dm[1], line: Number(dm[2]), column: Number(dm[3]), code: dm[4], message: dm[5] });
    }
  }
  if (tsMatches.length > 0) return { type: 'type', files: dedupe(tsMatches), raw: combined, exitCode };

  // JUnit XML
  if (JUNIT_FAIL.test(combined)) {
    const files: FailureFile[] = [];
    for (const line of combined.split(/\r?\n/)) {
      if (JUNIT_FAIL.test(line)) files.push({ path: '', message: line.trim() });
    }
    // also extract file:line fallback
    if (files.length === 0) return { type: 'test', files: extractGeneric(combined, 5), raw: combined, exitCode };
    return { type: 'test', files: dedupe(files), raw: combined, exitCode };
  }

  // pytest
  if (/FAILED\s+\S+|AssertionError|pytest/.test(combined)) {
    const files: FailureFile[] = [];
    for (const line of combined.split(/\r?\n/)) {
      let m = PYTEST_FAIL.exec(line);
      if (m && m[1]) { files.push({ path: m[1], message: m[2] ?? line.trim() }); continue; }
      m = PYTEST_ASSERT.exec(line) as unknown as RegExpExecArray | null;
      if (m) { files.push({ path: '', message: m[0] }); continue; }
    }
    if (files.length > 0) return { type: 'test', files: dedupe(files), raw: combined, exitCode };
  }

  // go test
  if (/---\s+FAIL:|FAIL\s+\S+/.test(combined)) {
    const files: FailureFile[] = [];
    for (const line of combined.split(/\r?\n/)) {
      let m = GO_FAIL.exec(line);
      if (m && m[1]) { files.push({ path: m[1], message: line.trim() }); continue; }
      m = GO_PKG_FAIL.exec(line);
      if (m && m[1]) { files.push({ path: m[1], message: line.trim() }); }
    }
    if (files.length > 0) return { type: 'test', files: dedupe(files), raw: combined, exitCode };
  }

  // cargo test
  if (/test result: FAILED|FAILED.*cargo|panicked at/.test(combined)) {
    const files: FailureFile[] = [];
    for (const line of combined.split(/\r?\n/)) {
      let m = CARGO_FAIL.exec(line);
      if (m && m[1]) { files.push({ path: m[1], message: line.trim() }); continue; }
      m = CARGO_PANIC.exec(line);
      if (m && m[3] && m[4] && m[5]) { files.push({ path: m[3], line: Number(m[4]), column: Number(m[5]), message: m[2] ?? line.trim() }); }
    }
    if (files.length > 0) return { type: 'test', files: dedupe(files), raw: combined, exitCode };
  }

  // Generic test runner (vitest/jest/mocha)
  if (/Test Suites:|FAIL\s|Tests:.*failed|✘|✗|×\s+/.test(combined) || MOCHA_FAIL.test(combined)) {
    const files: FailureFile[] = [];
    for (const line of combined.split(/\r?\n/)) {
      const m = TEST_FAIL.exec(line);
      if (m) {
        const target = m[1] ?? m[2] ?? m[3] ?? line.trim();
        files.push({ path: target, message: line.trim() });
        continue;
      }
      const mm = MOCHA_FAIL.exec(line);
      if (mm && mm[1]) files.push({ path: '', message: mm[1] });
    }
    if (files.length > 0) return { type: 'test', files: dedupe(files), raw: combined, exitCode };
    // fallback: any FAIL line
    if (/FAIL/.test(combined)) return { type: 'test', files: extractGeneric(combined, 5), raw: combined, exitCode };
  }

  // ESLint
  {
    const es: FailureFile[] = [];
    for (const line of combined.split(/\r?\n/)) {
      const m = ESLINT_LINE.exec(line);
      if (m && m[1] && m[2] && m[3] && m[5]) es.push({ path: m[1], line: Number(m[2]), column: Number(m[3]), code: m[6], message: m[5] });
    }
    if (es.length > 0) return { type: 'lint', files: dedupe(es), raw: combined, exitCode };
  }

  // ruff / flake8
  {
    const rf: FailureFile[] = [];
    for (const line of combined.split(/\r?\n/)) {
      const m = RUFF_LINE.exec(line);
      if (m && m[1] && m[2] && m[3] && m[4] && m[5]) rf.push({ path: m[1], line: Number(m[2]), column: Number(m[3]), code: m[4], message: m[5] });
    }
    if (rf.length > 0) return { type: 'lint', files: dedupe(rf), raw: combined, exitCode };
  }

  // mypy
  {
    const mp: FailureFile[] = [];
    for (const line of combined.split(/\r?\n/)) {
      const m = MYPY_LINE.exec(line);
      if (m && m[1] && m[2] && m[3] && m[4]) mp.push({ path: m[1], line: Number(m[2]), code: m[4], message: m[3] });
    }
    if (mp.length > 0) return { type: 'type', files: dedupe(mp), raw: combined, exitCode };
  }

  // gcc/clang, vite/webpack
  {
    const gc: FailureFile[] = [];
    for (const line of combined.split(/\r?\n/)) {
      const m = GCC_LINE.exec(line);
      if (m && m[1] && m[2] && m[3] && m[4]) gc.push({ path: m[1], line: Number(m[2]), column: Number(m[3]), message: m[4] });
      else if (VITE_ERROR.test(line)) gc.push({ path: '', message: line.trim() });
    }
    if (gc.length > 0) return { type: 'build', files: dedupe(gc), raw: combined, exitCode };
  }

  // Runtime exception.
  const lines = combined.split(/\r?\n/);
  const rt = lines.some((l) => RUNTIME_LINE.test(l));
  if (rt) {
    return { type: 'runtime', files: extractFirstLines(combined, 5), raw: combined, exitCode };
  }

  // Generic build.
  if (/error/i.test(combined)) {
    const gf = extractGeneric(combined, 5);
    if (gf.length > 0) return { type: 'build', files: gf, raw: combined, exitCode };
    return { type: 'build', files: extractFirstLines(combined, 5), raw: combined, exitCode };
  }

  return { type: 'unknown', files: extractFirstLines(combined, 3), raw: combined, exitCode };
}

function dedupe(files: FailureFile[]): FailureFile[] {
  const seen = new Set<string>();
  const out: FailureFile[] = [];
  for (const f of files) {
    const key = `${f.path}:${f.line ?? ''}:${f.column ?? ''}:${f.message}`;
    if (!seen.has(key)) { seen.add(key); out.push(f); }
  }
  return out;
}

function extractGeneric(s: string, n: number): FailureFile[] {
  const out: FailureFile[] = [];
  for (const line of s.split(/\r?\n/)) {
    const m = GENERIC_FILE_LINE.exec(line);
    if (m && m[1] && m[2] && m[4]) out.push({ path: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined, message: m[4] });
    if (out.length >= n) break;
  }
  return out;
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
