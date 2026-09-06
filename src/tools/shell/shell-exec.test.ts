import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { shellExecTool } from './shell-exec.js';
import type { ToolContext } from '../types.js';
import { TOOL_ERROR_CODES } from '../normalize.js';

const IS_WIN = process.platform === 'win32';

function makeCtx(): ToolContext {
  return { cwd: tmpdir(), env: {}, signal: undefined };
}

async function withTempCwd<R>(fn: (cwd: string, ctx: ToolContext) => Promise<R>): Promise<R> {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), 'klyro-shell-'));
  try {
    return await fn(cwd, { cwd, env: {}, signal: undefined });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

describe('shellExecTool', () => {
  afterEach(() => {});

  it('runs a command and returns exit code 0', async () => {
    await withTempCwd(async (cwd, ctx) => {
      const r = await shellExecTool.execute({
        command: IS_WIN ? 'echo hi' : 'printf hi',
      }, ctx);
      assertExactOk(r);
      expect(r.value.exitCode).toBe(0);
      expect(r.value.stdout.trim()).toBe('hi');
    });
  });

  it('returns non-zero exit as a tool success with exitCode', async () => {
    await withTempCwd(async (_cwd, ctx) => {
      const r = await shellExecTool.execute({
        command: IS_WIN ? 'exit /b 3' : 'exit 3',
      }, ctx);
      assertExactOk(r);
      expect(r.value.exitCode).toBe(3);
    });
  });

  it('blocks dangerous patterns', async () => {
    const ctx = makeCtx();
    const r = await shellExecTool.execute({ command: 'rm -rf /' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.code).toBe(TOOL_ERROR_CODES.COMMAND_DENIED);
  });

  it('honors timeoutMs', async () => {
    await withTempCwd(async (_cwd, ctx) => {
      const r = await shellExecTool.execute({
        command: IS_WIN ? 'ping -n 5 127.0.0.1' : 'sleep 5',
        timeoutMs: 300,
      }, ctx);
      assertExactOk(r);
      expect(r.value.timedOut).toBe(true);
    });
  });

  it('respects cwd input', async () => {
    await withTempCwd(async (cwd, _ctx) => {
      await fs.writeFile(path.join(cwd, 'marker.txt'), 'yes');
      const r = await shellExecTool.execute({
        command: IS_WIN ? 'type marker.txt' : 'cat marker.txt',
        cwd: cwd,
      }, makeCtx());
      assertExactOk(r);
      expect(r.value.stdout.trim()).toBe('yes');
    });
  });
});

function assertExactOk(
  r: { ok: boolean; value?: unknown; error?: { code: string } },
): asserts r is { ok: true; value: any } {
  if (!r.ok) {
    throw new Error(`expected ok, got error: ${r.error?.code}`);
  }
}