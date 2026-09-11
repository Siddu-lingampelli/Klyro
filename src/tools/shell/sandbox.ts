/**
 * G1-1 — OS-level sandbox shim for shell/subprocess tools.
 *
 * Bounds even a *compromised* tool call by the kernel, not by policy. Path
 * guards + the destructive-pattern denylist stop a cooperative model; this
 * is the layer that stops an exploited one.
 *
 * Backend strategy (defense-in-depth, cheapest-first):
 *   - `bwrap` (bubblewrap) — rootless, cross-distro, the same primitive Claude
 *     Code's sandbox docs reference. Primary backend when present.
 *   - landlock — kernel LSM, no helper binary needed, but requires a native
 *     syscall helper Node can't invoke directly. Tracked for the next step.
 *
 * Detection is done once at startup and cached. When no backend is present we
 * *degrade cleanly* to `undefined` — an empty sandbox command and a clearly
 * reported status, never a pretend "sandboxed" that isn't.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type SandboxBackend = 'bwrap' | 'none';

export interface SandboxStatus {
  backend: SandboxBackend;
  /** True when a real kernel/namespace boundary will be applied. */
  active: boolean;
  /** Human-readable why — for /sandbox and the trust gate. */
  reason: string;
}

let cachedStatus: SandboxStatus | null = null;

/** Walk $PATH for an executable without shells. Returns null when absent. */
function findOnPath(bin: string): string | null {
  const paths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of paths) {
    const p = path.join(dir, bin);
    try {
      if (fs.statSync(p).isFile() && p.endsWith(bin)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** True when `bwrap --version` runs and reports a sane bubblewrap build. */
function bwrapUsable(binPath: string): boolean {
  try {
    const r = spawnSync(binPath, ['--version'], { encoding: 'utf-8', timeout: 2000, windowsHide: true });
    return r.status === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * One-time detection. Cached for the process lifetime so we don't fork a
 * probe on every tool call. bwrap only — landlock is a follow-on.
 */
export function detectSandbox(): SandboxStatus {
  if (cachedStatus) return cachedStatus;

  // bubblewrap is POSIX-only; Windows guards are policy+path only (documented
  // honestly — Windows receives a native sandbox in G1-3 via a microVM).
  if (process.platform === 'win32') {
    cachedStatus = {
      backend: 'none',
      active: false,
      reason: 'native sandbox not yet available on win32 (G1-3 microVM planned); policy+path guards active',
    };
    return cachedStatus;
  }

  const bwrap = findOnPath('bwrap');
  if (bwrap && bwrapUsable(bwrap)) {
    cachedStatus = { backend: 'bwrap', active: true, reason: `bubblewrap at ${bwrap}` };
    return cachedStatus;
  }

  cachedStatus = {
    backend: 'none',
    active: false,
    reason:
      'bwrap not found on $PATH — install bubblewrap (e.g. `apt install bubblewrap`) or run unsandboxed; policy+path guards remain active',
  };
  return cachedStatus;
}

/**
 * Build a bwrap argv-wrapper for a command, bounding:
 *   - filesystem: read-only root, bind cwd read-write (only the permitted dir)
 *   - network: disabled (--unshare-net) for tool calls by default
 *   - process: new PID/user namespace (--unshare-pid --unshare-user)
 *   - devices/sockets: stripped of host access
 *
 * Returns `undefined` when no backend is active — the caller then runs the
 * command normally. Sandbox is opt-out of the *command namespace*, never a
 * silent no-op that claims to be sandboxed.
 */
export function sandboxCommand(
  cmd: string,
  args: string[],
  opts: { cwd: string; readWriteDirs?: string[]; allowNetwork?: boolean },
): { cmd: string; args: string[] } | undefined {
  const status = detectSandbox();
  if (!status.active) return undefined;

  const roDirs = ['/usr', '/bin', '/etc', '/lib', '/lib64', '/opt'];
  const bwrapArgs: string[] = [
    '--unshare-all',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/etc',
    '/etc',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/lib64',
    '/lib64',
    '--ro-bind',
    '/opt',
    '/opt',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
  ];

  // Read-write: the permitted cwd (and any explicitly allowed dirs) only.
  const rw = [opts.cwd, ...(opts.readWriteDirs ?? [])];
  for (const d of roDirs) void d; // (kept for parity with the read-only surface)
  for (const d of rw) {
    bwrapArgs.push('--bind', d, d);
  }
  // A clean, empty HOME so the child can't read the operator's dotfiles.
  bwrapArgs.push('--tmpfs', '/root');
  bwrapArgs.push('--clearenv');
  bwrapArgs.push('--setenv', 'PATH', '/usr/bin:/bin:/usr/local/bin');
  bwrapArgs.push('--setenv', 'HOME', '/root');
  bwrapArgs.push('--chdir', opts.cwd);

  if (!opts.allowNetwork) {
    // Default: sandboxed tool calls are offline. Exfiltration via curl/wget is
    // already denylisted at the policy layer; this is the belt-and-suspenders.
    bwrapArgs.push('--unshare-net');
  }

  bwrapArgs.push('--', cmd, ...args);
  return { cmd: 'bwrap', args: bwrapArgs };
}

/** Reset detection (tests). */
export function resetSandbox(): void {
  cachedStatus = null;
}