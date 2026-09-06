/**
 * `klyro eval` — drive the agent runtime against scripted scenarios.
 *
 * Useful for:
 *  - regression testing the loop (status code, tool call count, etc.)
 *  - reproducing a buggy run from a saved transcript
 *  - smoke-testing provider adapters without hitting a real API
 *
 * Each scenario in the JSONL input is one object:
 *
 *   {
 *     "name": "string-contains-shell",
 *     "task": "say hi and run shell_exec",
 *     "model": "mock",
 *     "maxSteps": 5,
 *     "scripted_events": [
 *       [["message_start"], ["text_delta", "Hello"], ["message_end", "stop"]],
 *       [["message_start"], ["tool_call_start", "c1", "shell_exec"],
 *        ["tool_call_delta", "c1", "{\"command\":\"echo hi\"}"],
 *        ["tool_call_end", "c1"], ["message_end", "tool_calls"]]
 *     ],
 *     "expect": {
 *       "status": "complete" | "max_steps" | "no_final" | "aborted",
 *       "textContains": "Hello",
 *       "toolCallsAtLeast": 1,
 *       "toolCallsAtMost": 3
 *     }
 *   }
 *
 * `scripted_events` is an array of *steps*; each step is an array of
 * [eventKind, ...args] tuples. The i-th step of the scenario is fed to
 * the i-th call to the adapter.stream() generator.
 *
 * If `scripted_events` is omitted or empty, the scenario just runs to
 * max_steps with no model output (useful for testing the harness
 * itself).
 *
 * Output: prints each scenario's pass/fail as a line; if --output json
 * is set, emits one JSON object per line. Exit code 0 if all pass, 1
 * otherwise.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout, stderr } from 'node:process';
import { run, type RunResult } from '../agent/runtime.js';
import type { ProviderAdapter, StreamEvent } from '../agent/provider-adapter.js';
import { builtinRegistry } from '../tools/registry.js';
import { builtinRules, DEFAULT_POLICY_CONFIG, PolicyEngine } from '../policy/engine.js';
import { DenyAllApprovalPrompt } from '../policy/approval.js';

export interface EvalScenario {
  name: string;
  task: string;
  model?: string;
  maxSteps?: number;
  maxTokens?: number;
  /** Adapter events to script, as [eventKind, ...args] tuples. */
  scripted_events?: Array<Array<unknown[]>>;
  expect?: {
    status?: RunResult['status'];
    textContains?: string;
    toolCallsAtLeast?: number;
    toolCallsAtMost?: number;
  };
}

export interface EvalResult {
  name: string;
  passed: boolean;
  failures: string[];
  status: RunResult['status'];
  steps: number;
  toolCalls: number;
  text: string;
  durationMs: number;
}

export interface RunEvalOptions {
  inputPath: string;
  output: 'human' | 'json' | 'silent';
}

export async function runEval(opts: RunEvalOptions): Promise<number> {
  const scenarios = await readScenarios(opts.inputPath);
  if (scenarios.length === 0) {
    stderr.write('klyro eval: no scenarios in input\n');
    return 2;
  }

  const results: EvalResult[] = [];
  for (const sc of scenarios) {
    const start = Date.now();
    const r = await runScenario(sc);
    r.durationMs = Date.now() - start;
    results.push(r);
    if (opts.output === 'json') {
      stdout.write(JSON.stringify({ kind: 'eval_result', ...r }) + '\n');
    } else if (opts.output === 'human') {
      const tag = r.passed ? 'PASS' : 'FAIL';
      stdout.write(`[${tag}] ${r.name} (${r.durationMs}ms, ${r.steps} steps, ${r.toolCalls} tools)\n`);
      for (const f of r.failures) stdout.write(`         - ${f}\n`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  if (opts.output === 'json') {
    stdout.write(JSON.stringify({ kind: 'eval_summary', total: results.length, passed, failed }) + '\n');
  } else if (opts.output === 'human') {
    stdout.write(`\n${passed}/${results.length} passed\n`);
  }
  return failed === 0 ? 0 : 1;
}

async function readScenarios(path: string): Promise<EvalScenario[]> {
  const text = await readAll(path);
  const out: EvalScenario[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    out.push(JSON.parse(trimmed) as EvalScenario);
  }
  return out;
}

async function readAll(path: string): Promise<string> {
  if (path === '-') {
    // Drain stdin.
    const chunks: Buffer[] = [];
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) chunks.push(Buffer.from(line + '\n', 'utf8'));
    return Buffer.concat(chunks).toString('utf8');
  }
  return fs.promises.readFile(path, 'utf8');
}

export function scriptedAdapterFromSpec(spec: Array<Array<unknown[]>> | undefined): ProviderAdapter {
  const steps = spec ?? [];
  let i = 0;
  return {
    id: 'scripted',
    async *stream() {
      if (i < steps.length) {
        const step = steps[i++];
        if (!step) return;
        for (const tuple of step) {
          yield tupleToEvent(tuple);
        }
      } else {
        // No more scripted output — emit message_end so the loop terminates
        // with status='no_final' if max_steps isn't reached, or max_steps otherwise.
        yield { kind: 'message_start' };
        yield { kind: 'message_end', finishReason: 'stop' };
      }
    },
  };
}

function tupleToEvent(tuple: unknown[]): StreamEvent {
  const [kind, ...args] = tuple as [string, ...unknown[]];
  switch (kind) {
    case 'message_start':
      return { kind: 'message_start', id: args[0] as string | undefined, model: args[1] as string | undefined };
    case 'text_delta':
      return { kind: 'text_delta', text: args[0] as string };
    case 'message_end':
      return { kind: 'message_end', finishReason: args[0] as string | undefined, usage: args[1] as { input: number; output: number } | undefined };
    case 'tool_call_start':
      return { kind: 'tool_call_start', id: args[0] as string, name: args[1] as string };
    case 'tool_call_delta':
      return { kind: 'tool_call_delta', id: args[0] as string, argsJson: args[1] as string };
    case 'tool_call_end':
      return { kind: 'tool_call_end', id: args[0] as string };
    case 'error':
      return { kind: 'error', code: args[0] as string, message: args[1] as string, retryable: Boolean(args[2]) };
    default:
      throw new Error(`scriptedAdapterFromSpec: unknown event kind: ${kind}`);
  }
}

export async function runScenario(sc: EvalScenario): Promise<EvalResult> {
  const failures: string[] = [];
  const model = sc.model ?? 'mock';
  const adapter = scriptedAdapterFromSpec(sc.scripted_events);
  const registry = builtinRegistry();
  const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);
  const result = await run(
    {
      task: sc.task,
      cwd: process.cwd(),
      model,
      maxSteps: sc.maxSteps,
      maxTokens: sc.maxTokens,
      nonInteractive: true,
    },
    {
      adapter,
      registry,
      policy,
      approval: new DenyAllApprovalPrompt(),
      systemPrompt: ({ cwd }) => `You are Klyro. cwd=${cwd}.`,
    },
  );

  const exp = sc.expect ?? {};
  if (exp.status !== undefined && result.status !== exp.status) {
    failures.push(`status: expected ${exp.status}, got ${result.status}`);
  }
  if (exp.textContains !== undefined && !result.finalText.includes(exp.textContains)) {
    failures.push(`text: expected to contain "${exp.textContains}", got "${result.finalText}"`);
  }
  if (exp.toolCallsAtLeast !== undefined && result.toolCalls < exp.toolCallsAtLeast) {
    failures.push(`toolCalls: expected >= ${exp.toolCallsAtLeast}, got ${result.toolCalls}`);
  }
  if (exp.toolCallsAtMost !== undefined && result.toolCalls > exp.toolCallsAtMost) {
    failures.push(`toolCalls: expected <= ${exp.toolCallsAtMost}, got ${result.toolCalls}`);
  }

  return {
    name: sc.name,
    passed: failures.length === 0,
    failures,
    status: result.status,
    steps: result.steps,
    toolCalls: result.toolCalls,
    text: result.finalText,
    durationMs: 0,
  };
}
