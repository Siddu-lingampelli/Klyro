#!/usr/bin/env node
/**
 * Clean-checkout release gate (review P0).
 *
 * Verifies a built `dist/` CLI:
 *  - `node dist/index.js --version` exits 0 and prints semver
 *  - `node dist/index.js --help` exits 0
 *  - `node dist/index.js eval --suite smoke --runs 1 --parallel 1` exits 0
 *    (fixture-backed, no live provider required)
 *  - final JSON envelope: `eval --suite smoke` with `--output json`-capable
 *    paths still emits parseable `kind:eval_summary` lines (checked via
 *    JSONL input path which supports --output json)
 *
 * Run in CI after `npm run build` and locally via `npm run release:check`.
 * Fails non-zero on any mismatch — never masked with `|| echo ok`.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function run(args, opts = {}) {
  return execFileSync('node', ['dist/index.js', ...args], {
    encoding: 'utf-8',
    timeout: 180_000,
    ...opts,
  });
}

function fail(msg) {
  process.stderr.write(`release-check FAILED: ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync('dist/index.js')) fail('dist/index.js missing — run npm run build first');

const version = run(['--version']).trim();
if (!/^\d+\.\d+\.\d+/.test(version)) fail(`--version not semver: ${version}`);

run(['--help']);

// Command-registration gate: the built CLI must expose the full verb set.
// NOTE: commands.md is the TUI *slash-command* roadmap (e.g. /resume), not
// the CLI reference (this --help output) — the two namespaces are different,
// so this gate checks the CLI against itself to catch accidental command
// loss during refactors (e.g. module extraction dropping a registration).
const help = run(['--help']);
const requiredVerbs = ['tui', 'run', 'chat', 'eval', 'eval:compare', 'session', 'sessions', 'resume', 'scan', 'project', 'mcp', 'hooks', 'agents', 'commit', 'audit', 'benchmark', 'doctor', 'config', 'login', 'logout', 'init', 'completion', 'update'];
const missing = requiredVerbs.filter((v) => !new RegExp(`^\\s{2}${v.replace(':', ':')}(?:\\s|\\[|<|$)`, 'm').test(help));
if (missing.length > 0) fail(`CLI registration drift: missing ${missing.join(', ')}`);

run(['eval', '--suite', 'smoke', '--runs', '1', '--parallel', '1']);

// JSON envelope check via a minimal scripted JSONL scenario (no provider).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-release-check-'));
const input = path.join(dir, 'smoke.jsonl');
fs.writeFileSync(
  input,
  JSON.stringify({
    name: 'release-check-smoke',
    task: 'say hello',
    model: 'mock',
    maxSteps: 2,
    scripted_events: [[['message_start'], ['text_delta', 'hello'], ['message_end', 'stop']]],
    expect: { status: 'complete', textContains: 'hello' },
  }) + '\n',
);
const out = run(['eval', input, '--output', 'json']);
const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
let summary = null;
for (const line of lines) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    fail(`non-JSON line in eval --output json: ${line.slice(0, 120)}`);
  }
  if (obj.kind === 'eval_summary') summary = obj;
}
if (!summary || summary.failed !== 0) fail(`eval JSON envelope missing failing summary: ${out.slice(0, 300)}`);

process.stdout.write(`release-check ok (version ${version})\n`);
