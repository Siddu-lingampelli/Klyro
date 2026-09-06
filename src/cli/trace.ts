/**
 * 3.1 — klyro trace <session> pretty-print, --stats
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getDefaultSessionStore, resolveSessionId } from '../persistence/session.js';

async function readTraceFile(sessionId: string): Promise<unknown[]> {
  // Try trace writer path first: .klyro/traces/<id>.jsonl
  const tracePath = path.join(process.cwd(), '.klyro', 'traces', `${sessionId}.jsonl`);
  try {
    const raw = await fs.readFile(tracePath, 'utf-8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    // Fallback to session store messages
    const { getDefaultSessionStore } = await import('../persistence/session.js');
    const store = getDefaultSessionStore();
    const msgs = await store.loadMessages(sessionId);
    return msgs;
  }
}

export async function runTrace(sessionId: string, opts: { stats?: boolean; json?: boolean } = {}): Promise<number> {
  const { getDefaultSessionStore, resolveSessionId } = await import('../persistence/session.js');
  const store = getDefaultSessionStore();
  const full = await resolveSessionId(store, sessionId);
  if (!full) {
    // Try direct trace file
    const events = await readTraceFile(sessionId);
    if (events.length > 0) {
      if (opts.json) process.stdout.write(JSON.stringify(events, null, 2) + '\n');
      else for (const ev of events) process.stdout.write(JSON.stringify(ev) + '\n');
      return 0;
    }
    process.stderr.write(`session/trace not found: ${sessionId}\n`);
    return 2;
  }

  const events = await readTraceFile(full);
  if (opts.stats) {
    const byType: Record<string, number> = {};
    for (const ev of events as Array<{ type?: string }>) {
      const t = ev.type ?? 'unknown';
      byType[t] = (byType[t] ?? 0) + 1;
    }
    const out = { sessionId: full, total: events.length, byType };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(events, null, 2) + '\n');
  } else {
    for (const ev of events) {
      const e = ev as { type?: string; text?: string; name?: string };
      if (e.type === 'stream.delta' && e.text) process.stdout.write(e.text);
      else process.stdout.write(JSON.stringify(ev) + '\n');
    }
  }
  return 0;
}
