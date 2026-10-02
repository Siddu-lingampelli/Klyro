/**
 * 4.5 — Checkpoint snapshots: every mutation to checkpoints dir
 *
 * Snapshot bytes stay RAW (no redaction): checkpoint copies must be
 * bit-identical to the working tree so undo() restores exact fidelity —
 * redacting at snapshot time would corrupt restores (a redacted snapshot
 * written back would permanently replace real code with [REDACTED]).
 * Same-trust-domain rationale: snapshots never leave the project dir and
 * are only read back by undo() into the same tree, so secret hygiene is
 * enforced at the trace/persist boundaries (TraceWriter, SessionStore)
 * instead of here.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { cappedOutput } from '../shared/output-cap.js';

function ckptDir(cwd: string): string {
  return path.join(cwd, '.klyro', 'checkpoints');
}

/**
 * Best-effort permission lockdown (0600 files / 0700 dirs).
 * Windows ACLs ignore POSIX mode bits — no-op by design.
 */
function lockDown(p: string, mode: number): void {
  if (process.platform === 'win32') return;
  try { fsSync.chmodSync(p, mode); } catch { /* best-effort only */ }
}

/** Best-effort fsync of a just-written file (crash safety). */
async function fsyncFile(p: string): Promise<void> {
  try {
    const fh = await fs.open(p, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
  } catch { /* ignore on Windows */ }
}

/**
 * Resolve a checkpoint file list entry inside cwd. Returns null for anything
 * escaping the project (no arbitrary read/write outside cwd, via either the
 * source read, the snapshot copy, or a tampered .meta.json on undo).
 */
function containedPath(cwd: string, base: string, rel: string): string | null {
  const out = path.resolve(base, rel);
  const relOut = path.relative(cwd, out);
  if (relOut.startsWith('..') || path.isAbsolute(relOut)) return null;
  return out;
}

/** Optional provenance recorded into a checkpoint's .meta.json. */
export interface SnapshotOptions {
  sessionId?: string;
  eventId?: string;
  transcript?: unknown[];
}

/** Checkpoint meta on disk — sessionId/eventId are absent on old metas. */
export interface CheckpointMeta {
  id: string;
  files: string[];
  missing: string[];
  ts: number;
  sessionId?: string;
  eventId?: string;
  transcriptHash?: string;
}

export async function snapshot(cwd: string, files: string[], opts?: SnapshotOptions): Promise<string> {
  const dir = ckptDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  lockDown(dir, 0o700);
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dest = path.join(dir, id);
  await fs.mkdir(dest, { recursive: true });
  lockDown(dest, 0o700);
  const missing: string[] = [];
  const kept: string[] = [];
  for (const f of files) {
    try {
      const src = containedPath(cwd, cwd, f);
      if (!src) continue;
      const data = await fs.readFile(src);
      const rel = path.relative(cwd, src);
      const out = containedPath(cwd, dest, rel);
      if (!out) continue;
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, data);
      lockDown(out, 0o600);
      await fsyncFile(out);
      kept.push(rel);
    } catch (e: unknown) {
      // Record deletions so undo() can restore the deleted state.
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') missing.push(f);
    }
  }
  // Save meta (tmp + fsync + rename before the checkpoint is visible —
  // mirrors the SessionStore.writeIndex atomic pattern so a crash never
  // leaves a truncated .meta.json that undo() then trusts).
  const metaPath = path.join(dest, '.meta.json');
  const metaTmp = `${metaPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const meta: CheckpointMeta = { id, files: kept, missing, ts: Date.now() };
  if (opts?.sessionId !== undefined) meta.sessionId = opts.sessionId;
  if (opts?.eventId !== undefined) meta.eventId = opts.eventId;
  if (opts?.transcript) {
    const transcriptPath = path.join(dest, 'transcript.json');
    await fs.writeFile(transcriptPath, JSON.stringify(opts.transcript), 'utf-8');
    lockDown(transcriptPath, 0o600);
    await fsyncFile(transcriptPath);
    const hash = crypto.createHash('sha256').update(JSON.stringify(opts.transcript)).digest('hex');
    meta.transcriptHash = hash;
  }
  await fs.writeFile(
    metaTmp,
    JSON.stringify(meta, null, 2),
  );
  lockDown(metaTmp, 0o600);
  await fsyncFile(metaTmp);
  try {
    await fs.rename(metaTmp, metaPath);
  } catch {
    await fs.unlink(metaTmp).catch(() => undefined);
    throw new Error(`Failed to write checkpoint meta ${id}`);
  }
  // Best-effort last.diff for the repair guard (guardRepair reads it).
  try {
    const { spawn } = await import('node:child_process');
    const args = ['diff', '--', ...kept.slice(0, 20)];
    const diffText = await new Promise<string>((resolve) => {
      const child = spawn('git', args, { cwd, shell: false, windowsHide: true });
      const sink = cappedOutput(20 * 1024);
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          try { child.kill(); } catch { /* ignore */ }
          resolve('');
        }
      }, 10_000);
      child.stdout.on('data', (b: Buffer) => sink.push(b));
      child.on('close', () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(sink.text());
      });
      child.on('error', () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve('');
      });
    });
    if (diffText) {
      const atomicWrite = async (p: string, data: string): Promise<void> => {
        const tmp = `${p}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        await fs.writeFile(tmp, data, 'utf-8');
        try {
          await fs.rename(tmp, p);
        } catch {
          await fs.unlink(tmp).catch(() => undefined);
        }
      };
      await atomicWrite(path.join(dir, 'last.diff'), diffText);
      // Per-checkpoint diff file (best-effort); the repair guard keeps
      // reading last.diff, so its behavior is unchanged.
      try {
        await atomicWrite(path.join(dir, `${id}.diff`), diffText);
      } catch { /* best-effort only */ }
    }
  } catch { /* best-effort only */ }
  return id;
}

export async function listCheckpoints(cwd: string): Promise<string[]> {
  const dir = ckptDir(cwd);
  try {
    const entries = await fs.readdir(dir);
    // last.diff is a guard artifact and <id>.diff files are per-checkpoint
    // diffs — neither is a checkpoint (must never be an undo target).
    return entries.filter((e) => !e.startsWith('.') && e !== 'last.diff' && !e.endsWith('.diff')).sort();
  } catch { return []; }
}

export interface CheckpointInfo {
  /** 1-based index from the latest (1 = newest, like `undo(n)`). */
  index: number;
  id: string;
  ts: number;
  files: number;
}

/** Numbered snapshot list for `/checkpoints` and the `/rewind` menu. */
export async function listCheckpointInfo(cwd: string): Promise<CheckpointInfo[]> {
  const ids = await listCheckpoints(cwd);
  const out: CheckpointInfo[] = [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]!;
    let ts = 0;
    let files = 0;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(ckptDir(cwd), id, '.meta.json'), 'utf-8')) as { ts?: number; files?: string[] };
      if (typeof meta.ts === 'number') ts = meta.ts;
      if (Array.isArray(meta.files)) files = meta.files.length;
    } catch { /* best-effort */ }
    out.push({ index: ids.length - i, id, ts, files });
  }
  return out;
}

/** File paths a snapshot would restore (for `/rewind <n> preview`). */
export async function snapshotFiles(cwd: string, id: string): Promise<string[]> {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(ckptDir(cwd), id, '.meta.json'), 'utf-8')) as { files?: string[]; missing?: string[] };
    const files = Array.isArray(meta.files) ? meta.files : [];
    const missing = Array.isArray(meta.missing) ? meta.missing.map((f) => `${f} (deleted)`) : [];
    return [...files, ...missing];
  } catch {
    return [];
  }
}

/**
 * Transcript captured at a checkpoint, or null when the snapshot predates
 * transcript capture or the payload is missing/corrupt.
 *
 * The stored hash is verified on read: a checkpoint is only ever trusted for
 * restoring the conversation when its transcript.json still matches the
 * transcriptHash recorded in .meta.json. A mismatch (partial write, manual
 * edit, tampering) yields null so the caller can report "conversation
 * untouched" instead of rewinding onto unverified content.
 */
export async function readSnapshotTranscript(cwd: string, id: string): Promise<unknown[] | null> {
  try {
    const dir = path.join(ckptDir(cwd), id);
    const meta = JSON.parse(await fs.readFile(path.join(dir, '.meta.json'), 'utf-8')) as { transcriptHash?: string };
    const raw = await fs.readFile(path.join(dir, 'transcript.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (typeof meta.transcriptHash === 'string') {
      const actual = crypto.createHash('sha256').update(raw).digest('hex');
      if (actual !== meta.transcriptHash) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function diff(cwd: string, id?: string): Promise<string> {
  const ckpts = await listCheckpoints(cwd);
  const target = id ?? ckpts[ckpts.length - 1];
  if (!target) return 'No checkpoints';
  // For stub, just show git diff vs HEAD
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('git', ['diff', '--stat'], { cwd, shell: false, windowsHide: true });
    const sink = cappedOutput(64 * 1024);
    let done = false;
    // A wedged git (locked index) must not hang undo diagnostics forever.
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve('No diff (git timed out)');
    }, 10_000);
    child.stdout.on('data', (b: Buffer) => sink.push(b));
    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(sink.text() || 'No diff');
    });
    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve('No git diff available');
    });
  });
}

export async function undo(cwd: string, n = 1): Promise<void> {
  const ckpts = await listCheckpoints(cwd);
  const target = ckpts[ckpts.length - n];
  if (!target) throw new Error('No checkpoint to undo');
  const srcDir = path.join(ckptDir(cwd), target);
  const metaRaw = await fs.readFile(path.join(srcDir, '.meta.json'), 'utf-8');
  const meta = JSON.parse(metaRaw) as { files: string[]; missing?: string[]; transcriptHash?: string };
  // Restore modified/created files to their snapshotted content…
  // Transcript restore is handled by caller via transcript snapshot — read via
  // readSnapshotTranscript() if the caller wants conversation rewind.
  for (const f of meta.files) {
    const src = containedPath(cwd, srcDir, f);
    const dest = src ? containedPath(cwd, cwd, f) : null;
    if (!src || !dest) continue;
    try {
      const data = await fs.readFile(src);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data);
    } catch { /* ignore */ }
  }
  // …and re-delete files that did not exist at snapshot time.
  for (const f of meta.missing ?? []) {
    const dest = containedPath(cwd, cwd, f);
    if (!dest) continue;
    try {
      await fs.unlink(dest);
    } catch { /* already gone */ }
  }
}

export async function rewind(cwd: string): Promise<void> {
  return undo(cwd, 1);
}
