import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { detect, summarize } from './detect.js';
import { runBaseline, getBaseline } from './baseline.js';
import { buildScopedCommand } from './scoped.js';
import { filteredVerifyEnv } from './registry.js';
import { verify } from './engine.js';
import { globalBus } from '../events/bus.js';
import { rerunOnce } from './classify.js';

describe('detect', () => {
  it('classifies TypeScript tsc errors', () => {
    const stderr = [
      "src/foo.ts(12,5): error TS2304: Cannot find name 'x'.",
      "src/bar.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join('\n');
    const f = detect('', stderr, 2);
    expect(f.type).toBe('type');
    expect(f.files).toHaveLength(2);
    expect(f.files[0]?.path).toBe('src/foo.ts');
    expect(f.files[0]?.code).toBe('TS2304');
    expect(f.files[0]?.line).toBe(12);
  });

  it('classifies test failures', () => {
    const stdout = 'FAIL src/foo.test.ts\n  ✘ should work\nTests: 1 failed';
    const f = detect(stdout, '', 1);
    expect(f.type).toBe('test');
  });

  it('classifies runtime exceptions', () => {
    const stderr = 'Error: cannot read property foo of undefined\n    at bar';
    const f = detect('', stderr, 1);
    expect(f.type).toBe('runtime');
  });

  it('classifies exit-0 as unknown (success path handled by caller)', () => {
    const f = detect('done', '', 0);
    expect(f.exitCode).toBe(0);
  });
});

describe('summarize', () => {
  it('produces a structured bullet list for type errors', () => {
    const stderr = "src/foo.ts(12,5): error TS2304: Cannot find name 'x'.";
    const f = detect('', stderr, 2);
    const s = summarize(f);
    expect(s).toContain('Verification failed');
    expect(s).toContain('type');
    expect(s).toContain('src/foo.ts:12:5');
    expect(s).toContain('TS2304');
  });
});

describe('baseline durability (N5: fsync before rename)', () => {
  it('writes a baseline file that reads back', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-baseline-'));
    // Quote execPath: it contains spaces on Windows (C:\Program Files\...).
    const cmd = `"${process.execPath}" -e "process.exit(0)"`;
    const b = await runBaseline(cwd, cmd, 30_000);
    expect(b).not.toBeNull();
    expect(b?.ok).toBe(true);
    const files = fs.readdirSync(path.join(cwd, '.klyro', 'baselines'));
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(files.filter((f) => f.includes('.tmp-'))).toEqual([]);
    const cached = await getBaseline(cwd, cmd);
    expect(cached?.ok).toBe(true);
    expect(cached?.command).toBe(cmd);
  }, 60_000);
});

describe('go scoped command (no toolchain — asserts command string only)', () => {
  it('derives go test ./<pkgdir> from a single related test file', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-go-scope-'));
    expect(buildScopedCommand(cwd, 'go test ./...', ['pkg/foo/foo_test.go'])).toBe('go test ./pkg/foo');
  });

  it('dedupes package dirs from multiple related test files', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-go-scope-'));
    expect(
      buildScopedCommand(cwd, 'go test ./...', ['pkg/a/a_test.go', 'pkg/a/b_test.go', 'pkg/b/c_test.go']),
    ).toBe('go test ./pkg/a ./pkg/b');
  });

  it('appends package dirs when the base has no ./...', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-go-scope-'));
    expect(buildScopedCommand(cwd, 'go test', ['pkg/foo/foo_test.go'])).toBe('go test ./pkg/foo');
  });

  it('falls back to full suite when more than 10 test files relate', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-go-scope-'));
    const many = Array.from({ length: 11 }, (_, i) => `pkg/p${i}/x_test.go`);
    expect(buildScopedCommand(cwd, 'go test ./...', many)).toBeNull();
  });

  it('drops unsafe/escaping paths; null when none survive (containment)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-go-scope-'));
    expect(buildScopedCommand(cwd, 'go test ./...', ['../escape_test.go'])).toBeNull();
    expect(buildScopedCommand(cwd, 'go test ./...', ['pkg/a/$(evil)_test.go'])).toBeNull();
    // mixed: offender dropped, safe survivor scoped
    expect(
      buildScopedCommand(cwd, 'go test ./...', ['../escape_test.go', 'pkg/ok/ok_test.go']),
    ).toBe('go test ./pkg/ok');
  });

  it('cargo keeps the full suite (no file-scoped selection)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-go-scope-'));
    expect(buildScopedCommand(cwd, 'cargo test', ['src/foo_test.rs'])).toBeNull();
  });
});

describe('S2: filtered verify env', () => {
  it('strips secret/KEY names and preload vectors, forces PATH', () => {
    const key = 'MY_TEST_SECRET_XYZ';
    const secret = 's3cr3t-filtered-' + Math.random().toString(36).slice(2);
    process.env[key] = secret;
    process.env.NODE_API_KEY = 'should-be-stripped-by-KEY-rule';
    try {
      const env = filteredVerifyEnv();
      expect(env[key]).toBeUndefined();
      expect(env.NODE_API_KEY).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.LD_PRELOAD).toBeUndefined();
      expect(env.LD_LIBRARY_PATH).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env[key];
      delete process.env.NODE_API_KEY;
    }
  });

  // classify.ts rerunOnce/gatherRepairContext route through filteredVerifyEnv().
  it('S2 remainder: secret env var absent in rerunOnce child output', async () => {
    const key = 'MY_TEST_SECRET_XYZ';
    const secret = 's3cr3t-filtered-' + Math.random().toString(36).slice(2);
    process.env[key] = secret;
    try {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-rerun-'));
      // Probe writes the env value to a file so the boolean-only rerunOnce
      // return still yields observable child output.
      const cmd = `"${process.execPath}" -e "require('fs').writeFileSync('out.txt', String(process.env.${key}))"`;
      const ok = await rerunOnce(cwd, cmd, 30_000);
      expect(ok).toBe(true); // guard against a vacuous pass: probe must run
      const out = fs.readFileSync(path.join(cwd, 'out.txt'), 'utf-8');
      expect(out).not.toContain(secret);
    } finally {
      delete process.env[key];
    }
  }, 60_000);
});

describe('engine.verify bus events (contract: optional sessionId)', () => {
  it('emits started/succeeded with the passed sessionId', async () => {
    const sid = 'sess-' + Math.random().toString(36).slice(2);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-eng-'));
    const cmd = `"${process.execPath}" -e "process.exit(0)"`;
    const r = await verify({ cwd, command: cmd, timeoutMs: 30_000, sessionId: sid });
    expect(r.ok).toBe(true);
    const hist = globalBus.getHistory().filter((e) => 'sessionId' in e && (e as { sessionId: string }).sessionId === sid);
    expect(hist.some((e) => e.type === 'verification.started' && (e as { command: string }).command === cmd)).toBe(true);
    expect(hist.some((e) => e.type === 'verification.succeeded' && (e as { command: string }).command === cmd)).toBe(true);
  }, 60_000);

  it("emits started/failed with fallback sessionId 'ephemeral'", async () => {
    const cmd = `"${process.execPath}" -e "process.exit(1)"`;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-eng-'));
    const before = globalBus.getHistory().length;
    const r = await verify({ cwd, command: cmd, timeoutMs: 30_000 });
    expect(r.ok).toBe(false);
    const fresh = globalBus.getHistory().slice(before).filter((e) => e.type.startsWith('verification.'));
    expect(fresh).toHaveLength(2);
    expect(fresh[0]?.type).toBe('verification.started');
    expect(fresh[1]?.type).toBe('verification.failed');
    for (const e of fresh) {
      expect((e as { sessionId: string }).sessionId).toBe('ephemeral');
      expect((e as { command: string }).command).toBe(cmd);
    }
  }, 60_000);
});
