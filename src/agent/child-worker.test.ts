/**
 * G2 — process-isolation protocol tests.
 *
 * The full child path (orchestrator → fork → run → ChildResult) needs a live
 * provider, so these tests pin the *protocol* honestly: JSON on stdin → one
 * JSON ChildResult line on stdout, exit 0 on success / non-zero on crash,
 * via stub entry scripts that speak the same wire format the real
 * `child-worker.ts` does. Plus direct unit checks of `buildChildDeps`.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { forkChild, buildChildDeps, workerEntryPath, ChildCrashError } from './child-worker.js';
import type { ChildWorkerPayload } from './child-worker.js';

const tmpDirs: string[] = [];

afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Write a stub worker entry that speaks the ChildWorker protocol. */
function writeStubWorker(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-child-test-'));
  tmpDirs.push(dir);
  const entry = path.join(dir, 'stub-worker.cjs');
  // CommonJS because os.tmpdir() sits outside the repo's `"type":"module"`.
  fs.writeFileSync(entry, `'use strict';\n${body}`);
  return entry;
}

const TRIVIAL_PAYLOAD: ChildWorkerPayload = {
  cwd: process.cwd(),
  task: 'list files',
  model: 'mock',
  systemPrompt: 'you are a test worker',
  agentId: 'explorer',
};

describe('workerEntryPath', () => {
  it('resolves to child-worker in the current layout (js or ts)', () => {
    const p = workerEntryPath();
    expect(path.basename(p).replace(/\.(js|ts)$/, '')).toBe('child-worker');
    expect(fs.existsSync(p)).toBe(true);
  });
});

describe('forkChild — wire protocol', () => {
  it('resolves a ChildResult from a worker that reads stdin and prints one JSON line', async () => {
    const entry = writeStubWorker(`
      let raw = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { raw += c; });
      process.stdin.on('end', () => {
        const payload = JSON.parse(raw);
        if (typeof payload.task !== 'string' || typeof payload.systemPrompt !== 'string') {
          process.stderr.write('bad payload');
          process.exit(1);
        }
        const out = { status: 'complete', steps: 2, toolCalls: 1, finalText: 'did it',
          hasEdits: false, usage: { input: 10, output: 5 } };
        process.stdout.write(JSON.stringify(out));
        process.exit(0);
      });
    `);
    const r = await forkChild(entry, TRIVIAL_PAYLOAD);
    expect(r.status).toBe('complete');
    expect(r.steps).toBe(2);
    expect(r.finalText).toBe('did it');
    expect(r.usage.input).toBe(10);
  });

  it('rejects with ChildCrashError when the worker exits non-zero without a result line', async () => {
    const entry = writeStubWorker(`process.stderr.write('boom\\n'); process.exit(1);`);
    await expect(forkChild(entry, TRIVIAL_PAYLOAD)).rejects.toMatchObject({
      name: 'ChildCrashError',
      likelyCause: 'exit',
    });
    await expect(forkChild(entry, TRIVIAL_PAYLOAD)).rejects.toThrow(/without a ChildResult|boom/);
  });

  it('rejects with ChildCrashError on malformed stdout (exit 0 but unparseable line)', async () => {
    const entry = writeStubWorker(`process.stdout.write('not-json'); process.exit(0);`);
    const e = await forkChild(entry, TRIVIAL_PAYLOAD).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ChildCrashError);
    expect((e as ChildCrashError).message).toMatch(/malformed ChildResult/);
  });

  it('passes the abort signal through to kill the child', async () => {
    const entry = writeStubWorker(`
      const t = setInterval(() => {}, 1000);
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => {});
    `);
    const ac = new AbortController();
    const promise = forkChild(entry, TRIVIAL_PAYLOAD, { signal: ac.signal, timeoutMs: 5000 }).catch((err: unknown) => err);
    ac.abort();
    const err = await promise;
    expect(err).toBeInstanceOf(ChildCrashError);
  });
});

describe('buildChildDeps', () => {
  const origKey = process.env.KLYRO_API_KEY;
  const origBase = process.env.KLYRO_BASE_URL;
  const origProv = process.env.KLYRO_PROVIDER;

  beforeEach(() => {
    if (origKey === undefined) delete process.env.KLYRO_API_KEY;
    else process.env.KLYRO_API_KEY = origKey;
    if (origBase === undefined) delete process.env.KLYRO_BASE_URL;
    else process.env.KLYRO_BASE_URL = origBase;
    if (origProv === undefined) delete process.env.KLYRO_PROVIDER;
    else process.env.KLYRO_PROVIDER = origProv;
  });

  it('throws when the provider key is absent in the child env', async () => {
    delete process.env.KLYRO_API_KEY;
    delete process.env.KLYRO_BASE_URL;
    await expect(buildChildDeps(TRIVIAL_PAYLOAD)).rejects.toThrow(/KLYRO_API_KEY is not set/);
  });

  it('builds an OpenAI adapter + options from the child env', async () => {
    process.env.KLYRO_API_KEY = 'test-key';
    process.env.KLYRO_BASE_URL = 'https://example.com/v1';
    process.env.KLYRO_PROVIDER = 'openai';
    const { deps, options } = await buildChildDeps({ ...TRIVIAL_PAYLOAD, maxSteps: 4, cwd: process.cwd() });
    expect(deps.adapter).toBeDefined();
    expect(deps.registry).toBeDefined();
    expect(options.task).toBe(TRIVIAL_PAYLOAD.task);
    expect(options.model).toBe('mock');
    expect(options.maxSteps).toBe(4);
    expect(options.nonInteractive).toBe(true);
    expect(deps.systemPrompt({ cwd: process.cwd() })).toBe(TRIVIAL_PAYLOAD.systemPrompt);
  });

  it('selects the anthropic adapter when KLYRO_PROVIDER=anthropic', async () => {
    process.env.KLYRO_API_KEY = 'test-key';
    process.env.KLYRO_PROVIDER = 'anthropic';
    delete process.env.KLYRO_BASE_URL;
    const { deps } = await buildChildDeps(TRIVIAL_PAYLOAD);
    expect(deps.adapter).toBeDefined();
  });
});