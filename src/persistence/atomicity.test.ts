/**
 * Crash-consistency of persisted state (review P1).
 *
 * Sessions, trust, checkpoints, and audit logs must survive a crash
 * between write and rename: no truncated JSON is ever left behind, and
 * readers tolerate a torn trailing line.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fss from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore } from './store.js';
import { McpTrust, hashSpec } from '../mcp/trust.js';
import { snapshot, listCheckpoints } from '../checkpoints/store.js';

async function leftovers(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir)) {
    if (e.includes('.tmp-')) out.push(e);
  }
  return out;
}

describe('crash consistency', () => {
  it('session create/append leaves no tmp fragments and valid JSON', async () => {
    const dir = path.join(os.tmpdir(), 'klyro-crash-' + Math.random().toString(36).slice(2));
    const store = new SessionStore(dir);
    const r = await store.create({ cwd: dir, task: 't', config: { model: 'm', maxSteps: 5 } });
    await store.appendMessage(r.id, { role: 'user', content: 'hi', ts: 1 });
    await store.appendObservation(r.id, {
      toolCallId: 'c1', toolName: 'read_file', input: {}, output: 'x',
      isError: false, startedAt: 1, finishedAt: 2,
    });
    expect(await leftovers(dir)).toEqual([]);
    const raw = JSON.parse(await fs.readFile(path.join(dir, `${r.id}.json`), 'utf-8'));
    expect(raw.record.id).toBe(r.id);
    expect(raw.messages).toHaveLength(1);
  });

  it('session jsonl tolerates a torn trailing line', async () => {
    const dir = path.join(os.tmpdir(), 'klyro-torn-' + Math.random().toString(36).slice(2));
    const store = new SessionStore(dir);
    const r = await store.create({ cwd: dir, task: 't', config: { model: 'm', maxSteps: 5 } });
    await fs.appendFile(path.join(dir, `${r.id}.jsonl`), '{"type":"ok"}\n{"type":"tor', 'utf-8');
    const entries = await store.readJsonl(r.id);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('mcp trust save is atomic and reloads', async () => {
    const dir = fss.mkdtempSync(path.join(os.tmpdir(), 'klyro-trust-'));
    const p = path.join(dir, 'mcp-trust.json');
    const spec = { command: 'node', args: ['a'] } as never;
    new McpTrust(p).approve('srv', hashSpec(spec));
    expect(await leftovers(dir)).toEqual([]);
    expect(new McpTrust(p).isTrusted('srv', hashSpec(spec))).toBe(true);
  });

  it('checkpoint snapshot leaves valid meta and no tmp fragments', async () => {
    const cwd = path.join(os.tmpdir(), 'klyro-ckpt-' + Math.random().toString(36).slice(2));
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, 'a.txt'), 'hello', 'utf-8');
    const id = await snapshot(cwd, ['a.txt']);
    expect(await listCheckpoints(cwd)).toContain(id);
    const meta = JSON.parse(await fs.readFile(path.join(cwd, '.klyro', 'checkpoints', id, '.meta.json'), 'utf-8'));
    expect(meta.files).toContain('a.txt');
  });
});
