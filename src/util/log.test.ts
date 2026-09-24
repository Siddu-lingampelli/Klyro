/**
 * Structured logging (1.5): silent under VITEST, redacting, never throwing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLogger, resetLoggerForTests, logInfo, logDebug } from './log.js';

afterEach(() => {
  resetLoggerForTests();
});

describe('util/log', () => {
  it('is silent under VITEST and never throws', () => {
    expect(getLogger().level).toBe('silent');
    expect(() => logInfo('hello')).not.toThrow();
    expect(() => logDebug('sk-ant-abcdefghij1234567890XY')).not.toThrow();
    expect(getLogger()).toBe(getLogger()); // cached instance
  });

  it('writes redacted JSON lines when enabled (isolated log dir)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-log-'));
    const savedVitest = process.env.VITEST;
    const savedLogDir = process.env.KLYRO_LOG_DIR;
    const savedLevel = process.env.KLYRO_LOG_LEVEL;
    try {
      delete process.env.VITEST;
      process.env.KLYRO_LOG_DIR = dir;
      process.env.KLYRO_LOG_LEVEL = 'debug';
      resetLoggerForTests();
      logInfo('token sk-ant-abcdefghij1234567890XY here');
      const raw = await fs.readFile(path.join(dir, 'klyro.log'), 'utf-8');
      expect(raw).toContain('[REDACTED]');
      expect(raw).not.toContain('sk-ant-abcdefghij1234567890XY');
      expect(() => JSON.parse(raw.trim().split('\n').pop() as string)).not.toThrow();
    } finally {
      if (savedVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = savedVitest;
      if (savedLogDir === undefined) delete process.env.KLYRO_LOG_DIR;
      else process.env.KLYRO_LOG_DIR = savedLogDir;
      if (savedLevel === undefined) delete process.env.KLYRO_LOG_LEVEL;
      else process.env.KLYRO_LOG_LEVEL = savedLevel;
      resetLoggerForTests();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
