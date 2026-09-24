/**
 * Structured logging (1.5): pino JSON logs with secret redaction.
 *
 * - Destination: `KLYRO_LOG_DIR/klyro.log` (falls back to `~/.klyro`), with
 *   the same 2 MiB rotate-to-`.1` cap as the TUI debug log.
 * - Level from `KLYRO_LOG_LEVEL` (or `DEBUG`→debug); unknown values fall
 *   back to `info` instead of throwing.
 * - Every string is passed through the secret redactor first, and pino's
 *   own `redact` paths cover common credential object shapes.
 * - Under VITEST the logger is silent (level `silent`) so tests never touch
 *   the real log file.
 * - The logger never throws: an unwritable destination degrades to silent.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino, { type Logger } from 'pino';
import { redact } from '../policy/secret-redactor.js';

const ROTATE_BYTES = 2 * 1024 * 1024;

const LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function level(): pino.LevelWithSilent {
  if (process.env.VITEST) return 'silent';
  const raw = (process.env.KLYRO_LOG_LEVEL ?? (process.env.DEBUG ? 'debug' : 'info')).toLowerCase();
  return (LEVELS.has(raw) ? raw : 'info') as pino.LevelWithSilent;
}

function logFile(): string {
  const dir = process.env.KLYRO_LOG_DIR ?? path.join(os.homedir() || process.cwd(), '.klyro');
  return path.join(dir, 'klyro.log');
}

function rotateBestEffort(file: string): void {
  try {
    if (fs.statSync(file).size > ROTATE_BYTES) {
      try { fs.rmSync(`${file}.1`, { force: true }); } catch { /* ignore */ }
      fs.renameSync(file, `${file}.1`);
    }
  } catch { /* missing — fine */ }
}

let cached: Logger | null = null;

/** Shared process logger. Never throws; silent when logging is unavailable. */
export function getLogger(): Logger {
  if (cached) return cached;
  try {
    // Tests must never touch the real log file: silent logger, no destination.
    if (process.env.VITEST) {
      cached = pino({ level: 'silent' });
      return cached;
    }
    const file = logFile();
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
    rotateBestEffort(file);
    cached = pino(
      {
        level: level(),
        redact: {
          paths: ['apiKey', 'api_key', '*.apiKey', '*.api_key', '*.token', '*.password', '*.secret', 'headers.authorization', '*.authorization'],
          censor: '[REDACTED]',
        },
      },
      pino.destination({ dest: file, sync: true }),
    );
  } catch {
    try {
      cached = pino({ level: 'silent' });
    } catch {
      cached = { info: () => undefined, debug: () => undefined, error: () => undefined, warn: () => undefined } as unknown as Logger;
    }
  }
  return cached;
}

/** For tests: drop the cached instance so env changes take effect. */
export function resetLoggerForTests(): void {
  cached = null;
}

/** Log helpers that redact string payloads before they reach pino. */
export function logInfo(msg: string, data?: unknown): void {
  try {
    if (data === undefined) getLogger().info(redact(msg));
    else getLogger().info(redactStructured(data), redact(msg));
  } catch { /* logging never breaks the run */ }
}

export function logDebug(msg: string, data?: unknown): void {
  try {
    if (data === undefined) getLogger().debug(redact(msg));
    else getLogger().debug(redactStructured(data), redact(msg));
  } catch { /* logging never breaks the run */ }
}

function redactStructured(data: unknown): unknown {
  if (typeof data === 'string') return redact(data);
  try {
    return JSON.parse(redact(JSON.stringify(data)));
  } catch {
    return '[unserializable]';
  }
}
