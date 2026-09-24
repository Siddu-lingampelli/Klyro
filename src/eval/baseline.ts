/**
 * 5.5b — eval baseline writer. Records the environment alongside suite
 * results so regressions can be attributed (model/node/platform/commit).
 *
 * The tracked `evals/results/baseline.json` is refreshed by `klyro eval
 * --suite <name>` (best-effort; suite failures never fail the write path).
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface EvalBaselineMeta {
    /** Model id the suite ran under (KLYRO_MODEL fallback, then 'mock'). */
    model: string;
    /** Node version (process.version). */
    node: string;
    /** OS platform (process.platform). */
    platform: string;
    /** Git HEAD, best-effort ('unknown' outside a repo). */
    commit: string;
    /** ISO timestamp of the run. */
    timestamp: string;
}

export interface EvalBaseline extends EvalBaselineMeta {
    suite: string;
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    durationMs: number;
}

/** Best-effort `git rev-parse HEAD` (never throws). Exported for tests. */
export function gitCommit(cwd: string = process.cwd()): string {
    try {
        const out = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim();
        return out || 'unknown';
    } catch {
        return 'unknown';
    }
}

/** Collect the environment half of a baseline record. Exported for tests. */
export function collectBaselineMetadata(opts: { model?: string; cwd?: string } = {}): EvalBaselineMeta {
    return {
        model: opts.model ?? process.env.KLYRO_MODEL ?? 'mock',
        node: process.version,
        platform: process.platform,
        commit: gitCommit(opts.cwd),
        timestamp: new Date().toISOString(),
    };
}

/** Combine metadata + suite counts into a full baseline record. */
export function buildEvalBaseline(
    meta: EvalBaselineMeta,
    suite: { suite: string; total: number; passed: number; failed: number; durationMs: number },
): EvalBaseline {
    return {
        ...meta,
        suite: suite.suite,
        total: suite.total,
        passed: suite.passed,
        failed: suite.failed,
        passRate: suite.total === 0 ? 0 : suite.passed / suite.total,
        durationMs: suite.durationMs,
    };
}

/**
 * Write `baseline.json` into `dir` (created if needed). Returns the path.
 * Never throws for missing dirs — the caller wraps in try/catch anyway.
 */
export async function writeEvalBaseline(dir: string, baseline: EvalBaseline): Promise<string> {
    await fsp.mkdir(dir, { recursive: true });
    const out = path.join(dir, 'baseline.json');
    await fsp.writeFile(out, JSON.stringify(baseline, null, 2) + '\n');
    return out;
}
