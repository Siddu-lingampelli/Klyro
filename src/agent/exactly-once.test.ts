/**
 * Exactly-once tool execution (review P1).
 *
 * A provider transport retry — or a resume replay — that re-issues an
 * already-completed tool-call id must NOT re-execute the side effect.
 * The runtime recommits the cached observation instead.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, defaultSystemPrompt } from './runtime.js';
import { ToolRegistry } from '../tools/registry.js';
import { writeFileTool } from '../tools/fs/write-file.js';
import { PolicyEngine, builtinRules, DEFAULT_POLICY_CONFIG } from '../policy/engine.js';
import { DenyAllApprovalPrompt } from '../policy/approval.js';
import type { ProviderAdapter, StreamEvent } from './provider-adapter.js';

function scriptedAdapter(events: StreamEvent[][]): ProviderAdapter {
  let i = 0;
  return {
    id: 'mock',
    async *stream() {
      if (i < events.length) {
        for (const ev of events[i++]) yield ev;
      }
    },
  };
}

describe('exactly-once tool execution', () => {
  it('replayed tool-call id reuses the cached result without re-executing', async () => {
    const cwd = path.join(os.tmpdir(), 'klyro-once-' + Math.random().toString(36).slice(2));
    await fs.mkdir(cwd, { recursive: true });
    const reg = new ToolRegistry().register(writeFileTool);
    const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
    // Turn 2 replays id c1 with DIFFERENT content (what a transport retry
    // replay looks like). If executed twice, x.txt would read "second".
    const adapter = scriptedAdapter([
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"x.txt","content":"first"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"x.txt","content":"second"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'done' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ]);
    const r = await run(
      { task: 'write once', cwd, model: 'mock', maxSteps: 5, nonInteractive: true },
      { adapter, registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );
    expect(r.status).toBe('complete');
    await expect(fs.readFile(path.join(cwd, 'x.txt'), 'utf-8')).resolves.toBe('first');
  });
});
