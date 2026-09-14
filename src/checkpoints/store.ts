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

export async function snapshot(cwd: string, files: string[]): Promise<string> {
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
  // Save meta (fsync before the checkpoint is visible — mirrors the
  // SessionStore.writeIndex atomic pattern).
  const metaPath = path.join(dest, '.meta.json');
  await fs.writeFile(
    metaPath,
    JSON.stringify({ id, files: kept, missing, ts: Date.now() }, null, 2),
  );
  lockDown(metaPath, 0o600);
  await fsyncFile(metaPath);
  // Best-effort last.diff for the repair guard (guardRepair reads it).
  try {
    const { spawn } = await import('node:child_process');
    const args = ['diff', '--', ...kept.slice(0, 20)];
    const diffText = await new Promise<string>((resolve) => {
      const child = spawn('git', args, { cwd, shell: false, windowsHide: true });
      const chunks: Buffer[] = [];
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          try { child.kill(); } catch { /* ignore */ }
          resolve('');
        }
      }, 10_000);
      child.stdout.on('data', (b: Buffer) => {
        if (Buffer.concat(chunks).length < 20 * 1024) chunks.push(b);
      });
      child.on('close', () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(Buffer.concat(chunks).toString('utf-8').slice(0, 20 * 1024));
      });
      child.on('error', () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve('');
      });
    });
    if (diffText) {
      await fs.writeFile(path.join(dir, 'last.diff'), diffText, 'utf-8');
      // Per-checkpoint diff file (best-effort); the repair guard keeps
      // reading last.diff, so its behavior is unchanged.
      try {
        await fs.writeFile(path.join(dir, `${id}.diff`), diffText, 'utf-8');
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

export async function diff(cwd: string, id?: string): Promise<string> {
  const ckpts = await listCheckpoints(cwd);
  const target = id ?? ckpts[ckpts.length - 1];
  if (!target) return 'No checkpoints';
  // For stub, just show git diff vs HEAD
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('git', ['diff', '--stat'], { cwd, shell: false, windowsHide: true });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('close', () => resolve(out || 'No diff'));
    child.on('error', () => resolve('No git diff available'));
  });
}

export async function undo(cwd: string, n = 1): Promise<void> {
  const ckpts = await listCheckpoints(cwd);
  const target = ckpts[ckpts.length - n];
  if (!target) throw new Error('No checkpoint to undo');
  const srcDir = path.join(ckptDir(cwd), target);
  const metaRaw = await fs.readFile(path.join(srcDir, '.meta.json'), 'utf-8');
  const meta = JSON.parse(metaRaw) as { files: string[]; missing?: string[] };
  // Restore modified/created files to their snapshotted content…
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
