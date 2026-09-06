/**
 * 4.5 — Checkpoint snapshots: every mutation to checkpoints dir
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

function ckptDir(cwd: string): string {
  return path.join(cwd, '.klyro', 'checkpoints');
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
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dest = path.join(dir, id);
  await fs.mkdir(dest, { recursive: true });
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
      kept.push(rel);
    } catch (e: unknown) {
      // Record deletions so undo() can restore the deleted state.
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') missing.push(f);
    }
  }
  // Save meta
  await fs.writeFile(
    path.join(dest, '.meta.json'),
    JSON.stringify({ id, files: kept, missing, ts: Date.now() }, null, 2),
  );
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
    if (diffText) await fs.writeFile(path.join(dir, 'last.diff'), diffText, 'utf-8');
  } catch { /* best-effort only */ }
  return id;
}

export async function listCheckpoints(cwd: string): Promise<string[]> {
  const dir = ckptDir(cwd);
  try {
    const entries = await fs.readdir(dir);
    // last.diff is a guard artifact, not a checkpoint (must never be an undo target).
    return entries.filter((e) => !e.startsWith('.') && e !== 'last.diff').sort();
  } catch { return []; }
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
