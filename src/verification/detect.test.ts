import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { detect, summarize } from './detect.js';
import { runBaseline, getBaseline } from './baseline.js';

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
