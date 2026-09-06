import { describe, it, expect } from 'vitest';
import { startBackground, getOutput, killJob, listJobs } from './background.js';

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
});
