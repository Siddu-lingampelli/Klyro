/**
 * Eval cwd isolation (regression: scripted JSONL scenarios used to execute
 * tool calls in process.cwd(), so a scenario writing a.txt/b.txt polluted
 * the caller's directory and then "exited by itself" when done).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runScenario, runEval, type EvalScenario } from './eval.js';

const tag = () => `${process.pid}-${Math.random().toString(36).slice(2)}`;

function writeScenario(name: string, file: string, content: string): EvalScenario {
  return {
    name,
    task: `write ${file}`,
    maxSteps: 4,
    scripted_events: [
      [
        ['message_start'],
        ['tool_call_start', 'c1', 'write_file'],
        ['tool_call_delta', 'c1', JSON.stringify({ path: file, content })],
        ['tool_call_end', 'c1'],
        ['message_end', 'tool_calls'],
      ],
      [
        ['message_start'],
        ['text_delta', 'done'],
        ['message_end', 'stop'],
      ],
    ],
    expect: { status: 'complete', toolCallsAtLeast: 1 },
  };
}

describe('eval cwd isolation', () => {
  it('default: scenario files never land in process.cwd()', async () => {
    const file = `eval-cwd-probe-${tag()}.txt`;
    const r = await runScenario(writeScenario('iso', file, 'x'));
    expect(r.passed).toBe(true);
    expect(r.workDir).toBeDefined();
    expect(path.resolve(r.workDir!)).not.toBe(path.resolve(process.cwd()));
    await expect(fs.stat(path.join(process.cwd(), file))).rejects.toThrow();
  });

  it('explicit workDir is honored and kept for inspection', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-eval-cwd-'));
    try {
      const file = `probe-${tag()}.txt`;
      const r = await runScenario(writeScenario('explicit', file, 'kept'), undefined, dir);
      expect(r.passed).toBe(true);
      expect(r.workDir).toBe(dir);
      await expect(fs.readFile(path.join(dir, file), 'utf-8')).resolves.toBe('kept');
      await expect(fs.stat(path.join(process.cwd(), file))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('runEval JSONL writing a.txt/b.txt leaves the caller directory clean', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klyro-eval-jsonl-'));
    try {
      const input = path.join(dir, 'in.jsonl');
      const lines = [
        JSON.stringify(writeScenario('s1', `a-${tag()}.txt`, '1')),
        JSON.stringify(writeScenario('s2', `b-${tag()}.txt`, '2')),
      ];
      await fs.writeFile(input, lines.join('\n') + '\n', 'utf-8');
      const before = new Set(await fs.readdir(process.cwd()));
      const code = await runEval({ inputPath: input, output: 'silent' });
      expect(code).toBe(0);
      const after = new Set(await fs.readdir(process.cwd()));
      for (const f of after) {
        if (!before.has(f)) {
          throw new Error(`eval polluted cwd with ${f}`);
        }
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
