/**
 * 1.5 — Logging (pino JSON to ~/.klyro/logs/klyro-YYYY-MM-DD.log, 14-day rotation, secret redaction)
 * Minimal implementation: JSONL append, redaction via secret-redactor, --debug pretty tee.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { redact } from '../policy/secret-redactor.js';

function getLogDir(): string {
  if (process.env.KLYRO_LOG_DIR) return process.env.KLYRO_LOG_DIR;
  const home = os.homedir() || process.cwd();
  return path.join(home, '.klyro', 'logs');
}

function getLogFile(): string {
  const dir = getLogDir();
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, `klyro-${date}.log`);
}

async function rotateLogs(): Promise<void> {
  const dir = getLogDir();
  try {
    const files = await fs.readdir(dir);
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const f of files) {
      if (!f.startsWith('klyro-') || !f.endsWith('.log')) continue;
      const fp = path.join(dir, f);
      try {
        const st = await fs.stat(fp);
        if (st.mtimeMs < cutoff) await fs.unlink(fp);
      } catch { /* ignore */ }
    }
  } catch { /* ignore dir not exists */ }
}

export interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  data?: unknown;
}

let _rotateDone = false;

export async function log(entry: LogEntry): Promise<void> {
  if (!_rotateDone) {
    _rotateDone = true;
    rotateLogs().catch(() => undefined);
  }
  const redactedMsg = redact(entry.msg);
  const redactedData = entry.data ? JSON.parse(redact(JSON.stringify(entry.data))) : undefined;
  const line = JSON.stringify({ ...entry, msg: redactedMsg, data: redactedData }) + '\n';
  const file = getLogFile();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, line, 'utf-8');
  } catch { /* ignore */ }
  if (process.env.KLYRO_LOG_LEVEL === 'debug' || process.env.DEBUG) {
    const pretty = `[${entry.level}] ${entry.msg}${entry.data ? ' ' + JSON.stringify(entry.data) : ''}`;
    if (entry.level === 'error') process.stderr.write(pretty + '\n');
    else process.stdout.write(pretty + '\n');
  }
}

export function logSync(entry: LogEntry): void {
  const redactedMsg = redact(entry.msg);
  const line = JSON.stringify({ ...entry, msg: redactedMsg, ts: entry.ts }) + '\n';
  const file = getLogFile();
  try {
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.appendFileSync(file, line, 'utf-8');
  } catch { /* ignore */ }
  if (process.env.KLYRO_LOG_LEVEL === 'debug') {
    process.stderr.write(`[${entry.level}] ${redactedMsg}\n`);
  }
}
