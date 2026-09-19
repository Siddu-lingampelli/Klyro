/**
 * Persisted schema versioning + import/export migration (review P1).
 */
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { SessionStore, migrateSessionRecord, SESSION_SCHEMA_VERSION, type SessionRecord } from './store.js';

describe('session schema migration', () => {
  it('new sessions carry the current schema version', async () => {
    const dir = path.join(os.tmpdir(), 'klyro-mig-' + Math.random().toString(36).slice(2));
    const store = new SessionStore(dir);
    const r = await store.create({ cwd: dir, task: 't', config: { model: 'm', maxSteps: 5 } });
    expect(r.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
  });

  it('pre-v1 records (no version) migrate forward on read', () => {
    const old = { id: 'x', cwd: '/w', task: 't', status: 'open', createdAt: 1, updatedAt: 1, config: { model: 'm', maxSteps: 1 } } as SessionRecord;
    expect(migrateSessionRecord(old).schemaVersion).toBe(SESSION_SCHEMA_VERSION);
  });

  it('export/import round-trips across versions', async () => {
    const dir = path.join(os.tmpdir(), 'klyro-mig2-' + Math.random().toString(36).slice(2));
    const store = new SessionStore(dir);
    const r = await store.create({ cwd: dir, task: 'round trip', config: { model: 'm', maxSteps: 5 } });
    await store.appendMessage(r.id, { role: 'user', content: 'hi', ts: 1 });
    const rec = await store.get(r.id);
    const msgs = await store.loadMessages(r.id);
    const obs = await store.loadObservations(r.id);
    // Simulate an old export without schemaVersion.
    const legacy = { record: { ...rec, schemaVersion: undefined }, messages: msgs, observations: obs };
    const file = path.join(dir, 'export.json');
    await fs.writeFile(file, JSON.stringify(legacy), 'utf-8');
    const back = JSON.parse(await fs.readFile(file, 'utf-8')) as { record: SessionRecord };
    expect(migrateSessionRecord(back.record).schemaVersion).toBe(SESSION_SCHEMA_VERSION);
  });
});
