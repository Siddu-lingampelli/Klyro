import { describe, it, expect } from 'vitest';
import { runHarness, formatReport } from './harness.js';
import { MVP_TASKS } from './tasks.js';

describe('harness', () => {
  it('runs the MVP suite and produces a summary', async () => {
    const summary = await runHarness(MVP_TASKS);
    expect(summary.total).toBe(MVP_TASKS.length);
    expect(summary.passed + summary.failed).toBe(summary.total);
    for (const r of summary.results) {
      expect(['pass', 'fail']).toContain(r.status);
    }
  });

  it('formats a markdown report', () => {
    const md = formatReport({
      total: 1, passed: 1, failed: 0, passRate: 1, durationMs: 5,
      results: [{ id: 't1', status: 'pass', details: 'ok', durationMs: 5 }],
    });
    expect(md).toContain('Klyro Harness Report');
    expect(md).toContain('t1');
  });
});
