import { describe, it, expect } from 'vitest';
import { RuntimeTelemetry, emptyTelemetryBlock } from './level7.js';
import { toolUse } from '../agent/message.js';

describe('RuntimeTelemetry', () => {
  it('starts empty and formats a "no telemetry yet" block', () => {
    const t = new RuntimeTelemetry();
    expect(t.snapshot().toolCallCount).toBe(0);
    expect(t.format()).toMatch(/^# Runtime telemetry/);
    expect(t.format()).toMatch(/Step 0/);
  });

  it('records tool calls and surfaces them in the formatted block', () => {
    const t = new RuntimeTelemetry();
    t.setMaxSteps(10);
    t.recordStepStart(1);
    const call = toolUse('c1', 'read_file', { path: 'src/a.ts' });
    t.recordToolCall(call, 42, false);
    t.recordStepStart(2);
    const call2 = toolUse('c2', 'shell_exec', { command: 'ls' });
    t.recordToolCall(call2, 1500, true);
    const out = t.format();
    expect(out).toMatch(/Step 2\/10/);
    expect(out).toMatch(/tool calls: 2/);
    expect(out).toMatch(/errors: 1/);
    expect(out).toMatch(/read_file src\/a\.ts/);
    expect(out).toMatch(/shell_exec ls/);
    expect(out).toMatch(/1\.5s/);
    expect(out).toMatch(/ERR/);
  });

  it('caps recent calls at maxRecentCalls', () => {
    const t = new RuntimeTelemetry({ maxRecentCalls: 3 });
    for (let i = 0; i < 10; i++) {
      const c = toolUse('c' + i, 'read_file', { path: `f${i}.ts` });
      t.recordToolCall(c, 10, false);
    }
    const snap = t.snapshot();
    expect(snap.lastToolCalls).toHaveLength(3);
    expect(snap.lastToolCalls[0]?.brief).toBe('f7.ts');
    expect(snap.lastToolCalls[2]?.brief).toBe('f9.ts');
    expect(snap.toolCallCount).toBe(10);
  });

  it('records usage tokens across steps', () => {
    const t = new RuntimeTelemetry();
    t.recordUsage(100, 50);
    t.recordUsage(120, 60);
    expect(t.snapshot().inputTokens).toBe(220);
    expect(t.snapshot().outputTokens).toBe(110);
  });

  it('truncates the formatted block at maxChars with a [truncated] marker', () => {
    const t = new RuntimeTelemetry({ maxRecentCalls: 50, maxChars: 200 });
    for (let i = 0; i < 50; i++) {
      const c = toolUse('c' + i, 'read_file', { path: `long/file/path/file_${i}.ts` });
      t.recordToolCall(c, 1234, false);
    }
    const out = t.format();
    expect(out.length).toBeLessThanOrEqual(220); // allow [truncated] suffix
    expect(out).toContain('[truncated]');
  });

  it('records the last error verbatim', () => {
    const t = new RuntimeTelemetry();
    t.recordError('boom');
    expect(t.snapshot().lastError).toBe('boom');
    expect(t.format()).toMatch(/Last error: boom/);
  });

  it('emptyTelemetryBlock is a valid header', () => {
    const s = emptyTelemetryBlock();
    expect(s).toMatch(/^# Runtime telemetry/);
    expect(s).toMatch(/no telemetry yet/);
  });

  it('recordToolError increments both tool count and last error in one call', () => {
    const t = new RuntimeTelemetry();
    const call = toolUse('c1', 'shell_exec', { command: 'rm -rf /' });
    t.recordToolError(call, 'policy_denied');
    const s = t.snapshot();
    expect(s.toolCallCount).toBe(1);
    expect(s.errorCount).toBe(1);
    expect(s.lastError).toBe('policy_denied: shell_exec');
    expect(s.lastToolCalls).toHaveLength(1);
    expect(s.lastToolCalls[0]?.isError).toBe(true);
  });
});
