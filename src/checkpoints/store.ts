/**
 * 4.5 — Checkpoint snapshots: every mutation to checkpoints dir
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

function ckptDir(cwd: string): string {
  return path.join(cwd, '.klyro', 'checkpoints');
}

export async function snapshot(cwd: string, files: string[]): Promise<string> {
  const dir = ckptDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dest = path.join(dir, id);
  await fs.mkdir(dest, { recursive: true });
  for (const f of files) {
    try {
      const src = path.resolve(cwd, f);
      const data = await fs.readFile(src);
      const rel = path.relative(cwd, src);
      const out = path.join(dest, rel);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, data);
    } catch { /* ignore missing */ }
  }
  // Save meta
  await fs.writeFile(path.join(dest, '.meta.json'), JSON.stringify({ id, files, ts: Date.now() }, null, 2));
  return id;
}

export async function listCheckpoints(cwd: string): Promise<string[]> {
  const dir = ckptDir(cwd);
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((e) => !e.startsWith('.')).sort();
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
  const meta = JSON.parse(metaRaw) as { files: string[] };
  for (const f of meta.files) {
    const src = path.join(srcDir, f);
    const dest = path.resolve(cwd, f);
    try {
      const data = await fs.readFile(src);
      await fs.writeFile(dest, data);
    } catch { /* ignore */ }
  }
}

export async function rewind(cwd: string): Promise<void> {
  return undo(cwd, 1);
}
