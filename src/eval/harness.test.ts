import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runHarness, formatReport, runAgentFixture, loadFileFixture } from './harness.js';
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

  it('runAgentFixture executes the script with real tools then asserts check.sh', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-agentfix-'));
    try {
      fs.writeFileSync(path.join(dir, 'task.md'), 'write it');
      fs.writeFileSync(
        path.join(dir, 'script.json'),
        JSON.stringify([
          [
            { kind: 'message_start' },
            { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
            { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"out.txt","content":"real"}' },
            { kind: 'tool_call_end', id: 'c1' },
            { kind: 'message_end', finishReason: 'tool_calls' },
          ],
          [
            { kind: 'message_start' },
            { kind: 'text_delta', text: 'done' },
            { kind: 'message_end', finishReason: 'stop' },
          ],
        ]),
      );
      fs.writeFileSync(path.join(dir, 'check.sh'), 'test "$(cat out.txt)" = "real"');
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ type: 'smoke', expectStatus: 'complete', expectToolCalls: 1 }));
      const fixture = await loadFileFixture(dir);
      expect(fixture.script).toHaveLength(2);
      const r = await runAgentFixture(fixture);
      expect(r.status).toBe('pass');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runAgentFixture fails when check.sh disagrees with the agent run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyro-agentfix-'));
    try {
      fs.writeFileSync(path.join(dir, 'task.md'), 'write it');
      fs.writeFileSync(
        path.join(dir, 'script.json'),
        JSON.stringify([
          [
            { kind: 'message_start' },
            { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
            { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"out.txt","content":"wrong"}' },
            { kind: 'tool_call_end', id: 'c1' },
            { kind: 'message_end', finishReason: 'tool_calls' },
          ],
          [
            { kind: 'message_start' },
            { kind: 'text_delta', text: 'done' },
            { kind: 'message_end', finishReason: 'stop' },
          ],
        ]),
      );
      fs.writeFileSync(path.join(dir, 'check.sh'), 'test "$(cat out.txt)" = "right"');
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ type: 'smoke' }));
      const r = await runAgentFixture(await loadFileFixture(dir));
      expect(r.status).toBe('fail');
      expect(r.details).toContain('check.sh');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
