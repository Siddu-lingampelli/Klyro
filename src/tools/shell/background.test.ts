import { describe, it, expect } from 'vitest';
import { startBackground, startBackgroundArgv, getOutput, killJob, listJobs } from './background.js';

describe('background shell', () => {
  it('starts and lists jobs', () => {
    const id = startBackground('echo hello', process.cwd());
    expect(typeof id).toBe('string');
    const jobs = listJobs();
    expect(jobs.some((j) => j.id === id)).toBe(true);
    killJob(id);
  });

  it('getOutput returns output', async () => {
    const id = startBackground('echo hello', process.cwd());
    await new Promise((r) => setTimeout(r, 300));
    const out = getOutput(id);
    expect(out).toContain('hello');
    killJob(id);
  });

  it('blocks destructive patterns like shell_exec', () => {
    expect(() => startBackground('rm -rf /', process.cwd())).toThrow(/blocked/);
    const id = startBackground('echo hello', process.cwd());
    killJob(id);
    expect(listJobs().some((j) => j.id === id)).toBe(false);
  });

  it('argv form runs without a shell', async () => {
    const id = startBackgroundArgv([process.execPath, '--version'], process.cwd());
    await new Promise((r) => setTimeout(r, 800));
    expect(getOutput(id)).toMatch(/v\d+\./);
    try { killJob(id); } catch { /* already reaped */ }
  });

  it('argv form rejects empty argv', () => {
    expect(() => startBackgroundArgv([], process.cwd())).toThrow();
  });
});
