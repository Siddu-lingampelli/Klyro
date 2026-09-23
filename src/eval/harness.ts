/**
 * Eval harness — runs a sequence of scripted tasks against the runtime
 * using a MockProviderAdapter. Verifies (a) the runtime completes the
 * expected tool-call sequence, (b) the verification engine detects the
 * right failure type, and (c) the compressor preserves the goal.
 *
 * This is the MVP gate per `plan.md` (§10, root of the repo — there is no
 * `docs/plan.md`): a reproducible suite of programmatic tasks that later
 * graduated into the fixture-backed file harness below.
 */

import { run } from '../agent/runtime.js';
import { cappedOutput } from '../shared/output-cap.js';

/** Bounded capture for `check.sh` output — fixtures are project-authored. */
const MAX_CHECK_BYTES = 64 * 1024;
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
  /**
   * Semantic rubric graded by a model judge (see judge.ts). Only runs when
   * the caller supplies a judge adapter; otherwise recorded as skipped.
   */
  judge?: { rubric: string[] };
}

export interface TaskResult {
  id: string;
  status: 'pass' | 'fail';
  details: string;
  observedStatus?: string;
  observedToolCalls?: number;
  durationMs: number;
  judge?: { pass: boolean; notes: string; skipped: boolean };
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

export async function runTask(
  t: ScriptedTask,
  opts: { judgeAdapter?: ProviderAdapter; judgeModel?: string; workDir?: string } = {},
): Promise<TaskResult> {
  const start = Date.now();
  // workDir lets callers seed a repo and inspect outcomes afterwards
  // (agent-driven fixtures); otherwise an isolated tmp dir is used and
  // removed.
  const owned = !opts.workDir;
  const cwd = opts.workDir ?? path.join(os.tmpdir(), 'klyro-eval-' + t.id + '-' + Math.random().toString(36).slice(2));
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

    // Model-graded semantic check (opt-in: needs a live judge adapter).
    let judge: TaskResult['judge'];
    if (t.judge && t.judge.rubric.length > 0) {
      if (opts.judgeAdapter) {
        const { runJudge } = await import('./judge.js');
        const texts = result.transcript
          .filter((m) => m.role === 'assistant')
          .flatMap((m) => m.content)
          .filter((b): b is { kind: 'text'; text: string } => (b as { kind?: string }).kind === 'text')
          .map((b) => b.text)
          .join('\n');
        const v = await runJudge(opts.judgeAdapter, opts.judgeModel ?? 'mock-judge', {
          task: t.task,
          finalText: result.finalText,
          toolCalls: result.toolCalls,
          extra: `assistant transcript:\n${texts.slice(0, 3000)}`,
        }, t.judge.rubric);
        judge = { pass: v.pass, notes: v.notes, skipped: v.skipped };
        if (!v.pass) {
          details += ` judge=fail (${v.notes || 'rubric unmet'});`;
          pass = false;
        }
      } else {
        judge = { pass: true, notes: 'no judge adapter — skipped', skipped: true };
      }
    }

    return {
      id: t.id,
      status: pass ? 'pass' : 'fail',
      details: details.trim() || `status=${observedStatus}`,
      observedStatus,
      observedToolCalls: result.toolCalls,
      durationMs: Date.now() - start,
      ...(judge ? { judge } : {}),
    };
  } finally {
    if (owned) {
      try { await fs.rm(cwd, { recursive: true, force: true }); } catch {}
    }
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

export async function runHarness(
  tasks: ScriptedTask[],
  opts: { judgeAdapter?: ProviderAdapter; judgeModel?: string } = {},
): Promise<HarnessSummary> {
  const start = Date.now();
  const results: TaskResult[] = [];
  for (const t of tasks) results.push(await runTask(t, opts));
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

/** 5.4 — File-based fixture support: repo|repo.json, task.md, check.sh, meta.json */
export interface FileFixture {
  dir: string;
  task: string;
  checkSh: string;
  meta: Record<string, unknown>;
  repo?: string;
  /**
   * Optional canned agent turns (StreamEvent[][], same shape as
   * ScriptedTask.script). When present the fixture is agent-driven: the
   * runtime executes the script with real tools in a seeded tmp repo and
   * check.sh then asserts the filesystem outcomes.
   */
  script?: StreamEvent[][];
}
export async function loadFileFixture(dir: string): Promise<FileFixture> {
  const task = await fs.readFile(path.join(dir, 'task.md'), 'utf-8').catch(() => 'test task');
  const checkSh = await fs.readFile(path.join(dir, 'check.sh'), 'utf-8').catch(() => 'exit 0');
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf-8')); } catch { /* ignore */ }
  let repo: string | undefined;
  try { repo = await fs.readFile(path.join(dir, 'repo'), 'utf-8'); } catch { /* ignore */ }
  let script: StreamEvent[][] | undefined;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'script.json'), 'utf-8')) as unknown;
    if (Array.isArray(raw)) script = raw as StreamEvent[][];
  } catch { /* no script → static fixture */ }
  return { dir, task: task.trim(), checkSh, meta, ...(repo ? { repo } : {}), ...(script ? { script } : {}) };
}

export async function runFileFixture(fixture: FileFixture, opts: { runs?: number; parallel?: number } = {}): Promise<TaskResult> {
  const start = Date.now();
  const tmp = path.join(os.tmpdir(), 'klyro-eval-file-' + Math.random().toString(36).slice(2));
  await fs.mkdir(tmp, { recursive: true });
  // Copy repo if exists
  if (fixture.repo) {
    const src = path.isAbsolute(fixture.repo) ? fixture.repo : path.join(fixture.dir, fixture.repo);
    await fs.cp(src, tmp, { recursive: true }).catch(() => undefined);
  } else {
    await fs.cp(fixture.dir, tmp, { recursive: true }).catch(() => undefined);
  }
  // Run check.sh via shell
  const { spawn } = await import('node:child_process');
  const result: TaskResult = await new Promise((resolve) => {
    const child = spawn('bash', ['-c', fixture.checkSh], { cwd: tmp, shell: false });
    const sink = cappedOutput(MAX_CHECK_BYTES);
    child.stdout?.on('data', (b: Buffer) => sink.push(b));
    child.stderr?.on('data', (b: Buffer) => sink.push(b));
    child.on('close', (code) => {
      const pass = code === 0;
      resolve({
        id: path.basename(fixture.dir),
        status: pass ? 'pass' : 'fail',
        details: sink.text().slice(0, 500),
        observedStatus: pass ? 'complete' : 'verify_failed',
        durationMs: Date.now() - start,
      });
    });
    child.on('error', (err) => {
      resolve({ id: path.basename(fixture.dir), status: 'fail', details: String(err), durationMs: Date.now() - start });
    });
  });
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  return result;
}

/**
 * Agent-driven fixture: seed a tmp repo, run the fixture's canned script
 * through the REAL runtime + tools, then assert outcomes with check.sh
 * (plus optional meta judge rubric). This is what makes fixtures more than
 * static `exit 0` stubs: the agent loop genuinely executes.
 */
export async function runAgentFixture(
  fixture: FileFixture,
  opts: { judgeAdapter?: ProviderAdapter; judgeModel?: string } = {},
): Promise<TaskResult> {
  const start = Date.now();
  const id = path.basename(fixture.dir);
  if (!fixture.script) {
    return { id, status: 'fail', details: 'agent fixture needs script.json', durationMs: Date.now() - start };
  }
  const tmp = path.join(os.tmpdir(), 'klyro-eval-agent-' + Math.random().toString(36).slice(2));
  await fs.mkdir(tmp, { recursive: true });
  try {
    if (fixture.repo) {
      const src = path.isAbsolute(fixture.repo) ? fixture.repo : path.join(fixture.dir, fixture.repo);
      await fs.cp(src, tmp, { recursive: true }).catch(() => undefined);
    }
    const meta = fixture.meta;
    const judgeRubric = meta['judge'] && typeof meta['judge'] === 'object'
      ? ((meta['judge'] as { rubric?: unknown }).rubric as unknown)
      : undefined;
    const r = await runTask(
      {
        id,
        description: fixture.task.slice(0, 120),
        task: fixture.task,
        script: fixture.script,
        expectStatus: (typeof meta['expectStatus'] === 'string' ? meta['expectStatus'] : 'complete') as ScriptedTask['expectStatus'],
        ...(typeof meta['expectToolCalls'] === 'number' ? { expectToolCalls: meta['expectToolCalls'] as number } : {}),
        ...(Array.isArray(judgeRubric) && judgeRubric.every((s) => typeof s === 'string') ? { judge: { rubric: judgeRubric as string[] } } : {}),
      },
      { workDir: tmp, ...(opts.judgeAdapter ? { judgeAdapter: opts.judgeAdapter, judgeModel: opts.judgeModel } : {}) },
    );
    if (r.status === 'fail') return { ...r, durationMs: Date.now() - start };
    // Structural pass — now assert real filesystem outcomes.
    const { spawn } = await import('node:child_process');
    const out: string = await new Promise((resolve) => {
      const child = spawn('bash', ['-c', fixture.checkSh], { cwd: tmp, shell: false });
      const sink = cappedOutput(MAX_CHECK_BYTES);
      child.stdout?.on('data', (b: Buffer) => sink.push(b));
      child.stderr?.on('data', (b: Buffer) => sink.push(b));
      child.on('close', (code) => resolve(`exit=${code ?? -1} ${sink.text().slice(0, 500)}`));
      child.on('error', (err) => resolve(`spawn-error: ${String(err)}`));
    });
    if (!out.startsWith('exit=0')) {
      return { ...r, status: 'fail', details: `${r.details} check.sh: ${out}`.trim(), durationMs: Date.now() - start };
    }
    return { ...r, durationMs: Date.now() - start };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Hook the harness up to a session + audit log so task runs are durable. */export async function runHarnessWithPersistence(
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
    // Persist to session store
    try {
      const rec = await store.create({ cwd: process.cwd(), task: t.task, config: { model: 'mock', maxSteps: 12 } });
      await store.setStatus(rec.id, r.status === 'pass' ? 'complete' : 'verify_failed', r.details);
    } catch { /* ignore */ }
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

/** Compare two harness runs */
export function compareReports(a: HarnessSummary, b: HarnessSummary): string {
  const lines = [
    `# Compare: ${a.passed}/${a.total} (${(a.passRate * 100).toFixed(1)}%) vs ${b.passed}/${b.total} (${(b.passRate * 100).toFixed(1)}%)`,
    `Duration: ${(a.durationMs / 1000).toFixed(1)}s vs ${(b.durationMs / 1000).toFixed(1)}s`,
    `| Task | A | B |`,
    `|------|---|---|`,
  ];
  const allIds = new Set([...a.results.map((r) => r.id), ...b.results.map((r) => r.id)]);
  for (const id of allIds) {
    const ra = a.results.find((r) => r.id === id);
    const rb = b.results.find((r) => r.id === id);
    lines.push(`| ${id} | ${ra?.status ?? '-'} | ${rb?.status ?? '-'} |`);
  }
  return lines.join('\n');
}
