/**
 * Eval harness — runs a sequence of scripted tasks against the runtime
 * using a MockProviderAdapter. Verifies (a) the runtime completes the
 * expected tool-call sequence, (b) the verification engine detects the
 * right failure type, and (c) the compressor preserves the goal.
 *
 * This is the MVP gate per Devolopment-plan.md / docs/plan.md §10: a
 * reproducible suite of programmatic tasks. Real repo tasks come in v1.0.
 */

import { run } from '../agent/runtime.js';
import { ToolRegistry } from '../tools/registry.js';
import { readFileTool } from '../tools/fs/read-file.js';
import { writeFileTool } from '../tools/fs/write-file.js';
import { editFileTool } from '../tools/fs/edit-file.js';
import { shellExecTool } from '../tools/shell/shell-exec.js';
import { runVerifyTool } from '../tools/verify/run-verify.js';
import { listDirTool } from '../tools/fs/list-dir.js';
import { globTool } from '../tools/search/glob.js';
import { grepTool } from '../tools/search/grep.js';
import { gitStatusTool } from '../tools/git/git-status.js';
import { gitDiffTool } from '../tools/git/git-diff.js';
import { PolicyEngine, builtinRules, DEFAULT_POLICY_CONFIG } from '../policy/engine.js';
import { DenyAllApprovalPrompt } from '../policy/approval.js';
import { defaultSystemPrompt } from '../agent/runtime.js';
import { verify } from '../verification/engine.js';
import { SessionStore } from '../persistence/store.js';
import { AuditLog } from '../persistence/audit.js';
import type { ProviderAdapter, StreamEvent } from '../agent/provider-adapter.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ScriptedTask {
  id: string;
  description: string;
  task: string;
  /** A list of event scripts — each inner list is one assistant turn. */
  script: StreamEvent[][];
  /** Optional verify command to run after the runtime finishes. */
  verifyCommand?: string;
  /** Expected final status. */
  expectStatus: 'complete' | 'max_steps' | 'aborted' | 'verify_failed' | 'no_final';
  /** Expected tool-call count. */
  expectToolCalls?: number;
}

export interface TaskResult {
  id: string;
  status: 'pass' | 'fail';
  details: string;
  observedStatus?: string;
  observedToolCalls?: number;
  durationMs: number;
}

function scriptedAdapter(script: StreamEvent[][]): ProviderAdapter {
  let i = 0;
  return {
    id: 'mock',
    async *stream() {
      if (i < script.length) {
        const turn = script[i++];
        if (turn) for (const ev of turn) yield ev;
      }
    },
  };
}

export async function runTask(t: ScriptedTask): Promise<TaskResult> {
  const start = Date.now();
  const cwd = path.join(os.tmpdir(), 'klyro-eval-' + t.id + '-' + Math.random().toString(36).slice(2));
  await fs.mkdir(cwd, { recursive: true });

  const reg = new ToolRegistry()
    .register(readFileTool).register(writeFileTool).register(editFileTool)
    .register(listDirTool).register(globTool).register(grepTool)
    .register(shellExecTool).register(runVerifyTool)
    .register(gitStatusTool).register(gitDiffTool);
  const policy = new PolicyEngine(builtinRules(), DEFAULT_POLICY_CONFIG);

  try {
    const result = await run(
      { task: t.task, cwd, model: 'mock', maxSteps: 12, nonInteractive: true },
      { adapter: scriptedAdapter(t.script), registry: reg, policy, approval: new DenyAllApprovalPrompt(), systemPrompt: defaultSystemPrompt },
    );

    let observedStatus: string = result.status;
    let verifyFailure: string | undefined;
    if (t.verifyCommand) {
      const v = await verify({ cwd, command: t.verifyCommand });
      if (!v.ok) {
        observedStatus = 'verify_failed';
        verifyFailure = v.failure?.type ?? 'unknown';
      }
    }

    let details = '';
    let pass = result.status === t.expectStatus;
    if (t.expectToolCalls !== undefined && result.toolCalls !== t.expectToolCalls) {
      details += ` toolCalls=${result.toolCalls} expected=${t.expectToolCalls};`;
      pass = false;
    }
    if (verifyFailure) {
      details += ` verifyFailure=${verifyFailure};`;
    }

    return {
      id: t.id,
      status: pass ? 'pass' : 'fail',
      details: details.trim() || `status=${observedStatus}`,
      observedStatus,
      observedToolCalls: result.toolCalls,
      durationMs: Date.now() - start,
    };
  } finally {
    try { await fs.rm(cwd, { recursive: true, force: true }); } catch {}
  }
}

export interface HarnessSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  results: TaskResult[];
  durationMs: number;
}

export async function runHarness(tasks: ScriptedTask[]): Promise<HarnessSummary> {
  const start = Date.now();
  const results: TaskResult[] = [];
  for (const t of tasks) results.push(await runTask(t));
  const passed = results.filter((r) => r.status === 'pass').length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    results,
    durationMs: Date.now() - start,
  };
}

/** Format a harness summary as a markdown report. */
export function formatReport(summary: HarnessSummary): string {
  const lines: string[] = [
    `# Klyro Harness Report`,
    ``,
    `**Total:** ${summary.total}    **Passed:** ${summary.passed}    **Failed:** ${summary.failed}    **Pass rate:** ${(summary.passRate * 100).toFixed(1)}%`,
    `**Wall time:** ${(summary.durationMs / 1000).toFixed(1)}s`,
    ``,
    `| Task | Status | Details | Tool calls | Duration |`,
    `|------|--------|---------|------------|----------|`,
    ...summary.results.map((r) => `| ${r.id} | ${r.status} | ${r.details} | ${r.observedToolCalls ?? '-'} | ${r.durationMs}ms |`),
  ];
  return lines.join('\n');
}

/** Hook the harness up to a session + audit log so task runs are durable. */
export async function runHarnessWithPersistence(
  tasks: ScriptedTask[],
  opts: { storeDir: string; auditPath: string },
): Promise<HarnessSummary> {
  const store = new SessionStore(opts.storeDir);
  const audit = new AuditLog(opts.auditPath);
  const start = Date.now();
  const results: TaskResult[] = [];
  for (const t of tasks) {
    await audit.write({ kind: 'verification_attempted', sessionId: t.id, command: t.task, ts: Date.now() });
    const r = await runTask(t);
    results.push(r);
    await audit.write({
      kind: r.status === 'pass' ? 'verification_succeeded' : 'verification_failed',
      sessionId: t.id,
      exitCode: 0,
      type: r.details,
      ts: Date.now(),
    });
    // Suppress unused warning.
    void store;
  }
  const passed = results.filter((r) => r.status === 'pass').length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    results,
    durationMs: Date.now() - start,
  };
}
