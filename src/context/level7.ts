/**
 * Level-7 context: runtime telemetry injected into every model call.
 *
 * Level-6 gives the model a precomputed, file-system-shaped picture of the
 * project (file map, deps, recent files). Level-7 gives it a live picture
 * of *itself mid-run* — the run so far is a feedback channel, not a blind
 * loop.
 *
 * What gets surfaced (per step, before the next model call):
 *   - current step number, max steps
 *   - cumulative tool call count
 *   - approximate token usage
 *   - the last N tool calls (name, brief arg, latency, error?)
 *   - the last error, if any
 *   - how many times we've hit "max_steps" / abort / etc.
 *
 * Budget: hard-capped at `maxChars` (default 1.2 KB) so the telemetry
 * block can never bloat the system prompt. Each sub-block is independently
 * optional and bounded.
 *
 * This is in-memory only. No cache, no .klyro/ write — telemetry dies
 * with the process. (We never want to leak one run's state into another.)
 */

import type { ToolUseBlock } from '../agent/message.js';

export interface TelemetryToolCall {
  name: string;
  /** One-line summary (path for fs tools, command for shell). */
  brief: string;
  latencyMs: number;
  isError: boolean;
  step: number;
}

export interface TelemetrySnapshot {
  step: number;
  maxSteps: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  lastError: string | null;
  lastToolCalls: TelemetryToolCall[];
  /** How many tool calls failed in the entire run so far. */
  errorCount: number;
  /** When the run started (ISO string). */
  startedAt: string;
}

export interface Level7Options {
  maxRecentCalls?: number;
  /** Cap on the formatted string (characters). */
  maxChars?: number;
}

const DEFAULT_MAX_RECENT = 6;
const DEFAULT_MAX_CHARS = 1200;

/** Mutable accumulator the runtime mutates each step. */
export class RuntimeTelemetry {
  private readonly opts: Required<Level7Options>;
  private startMs: number = Date.now();
  private step: number = 0;
  private maxSteps: number = 30;
  private toolCallCount: number = 0;
  private inputTokens: number = 0;
  private outputTokens: number = 0;
  private lastError: string | null = null;
  private errorCount: number = 0;
  private recent: TelemetryToolCall[] = [];

  constructor(opts: Level7Options = {}) {
    this.opts = {
      maxRecentCalls: opts.maxRecentCalls ?? DEFAULT_MAX_RECENT,
      maxChars: opts.maxChars ?? DEFAULT_MAX_CHARS,
    };
  }

  setMaxSteps(n: number): void { this.maxSteps = n; }

  recordStepStart(step: number): void { this.step = step; }

  recordUsage(input: number, output: number): void {
    this.inputTokens += input;
    this.outputTokens += output;
  }

  recordToolCall(call: ToolUseBlock, latencyMs: number, isError: boolean): void {
    this.toolCallCount++;
    if (isError) this.errorCount++;
    this.recent.push({
      name: call.name,
      brief: summarize(call),
      latencyMs,
      isError,
      step: this.step,
    });
    if (this.recent.length > this.opts.maxRecentCalls) {
      this.recent.splice(0, this.recent.length - this.opts.maxRecentCalls);
    }
  }

  recordError(msg: string): void {
    this.lastError = msg;
  }

  /**
   * One-shot helper for "this call didn't run / failed before executing".
   * Records the call as an error (counted in `errorCount`, surfaced in
   * `recentToolCalls`) AND sets the `lastError` message — both in one
   * call so a future contributor can't update one without the other.
   */
  recordToolError(call: ToolUseBlock, kind: string): void {
    this.recordToolCall(call, 0, true);
    this.recordError(`${kind}: ${call.name}`);
  }

  snapshot(): TelemetrySnapshot {
    return {
      step: this.step,
      maxSteps: this.maxSteps,
      toolCallCount: this.toolCallCount,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      lastError: this.lastError,
      lastToolCalls: [...this.recent],
      errorCount: this.errorCount,
      startedAt: new Date(this.startMs).toISOString(),
    };
  }

  format(): string {
    const s = this.snapshot();
    const lines: string[] = [];
    lines.push('# Runtime telemetry');
    const elapsedMs = Date.now() - this.startMs;
    const elapsed = formatElapsed(elapsedMs);
    lines.push(
      `Step ${s.step}/${s.maxSteps}  |  tool calls: ${s.toolCallCount}  |  errors: ${s.errorCount}  |  tokens: ${s.inputTokens} in / ${s.outputTokens} out  |  elapsed: ${elapsed}`,
    );
    if (s.lastError) {
      lines.push(`Last error: ${truncate(s.lastError, 200)}`);
    }
    if (s.lastToolCalls.length) {
      lines.push('Recent calls (newest last):');
      for (const c of s.lastToolCalls) {
        const tag = c.isError ? 'ERR' : 'ok ';
        const lat = c.latencyMs < 1000 ? `${c.latencyMs}ms` : `${(c.latencyMs / 1000).toFixed(1)}s`;
        lines.push(`  [${tag}] step=${c.step} ${c.name} ${truncate(c.brief, 80)} (${lat})`);
      }
    }
    let out = lines.join('\n');
    if (out.length > this.opts.maxChars) {
      const cut = out.lastIndexOf('\n', this.opts.maxChars);
      out = out.slice(0, cut > 0 ? cut : this.opts.maxChars) + '\n[truncated]';
    }
    return out;
  }
}

function summarize(call: ToolUseBlock): string {
  const i = call.input as Record<string, unknown>;
  if (call.name === 'shell_exec' || call.name === 'run_verify') {
    return String(i.command ?? '');
  }
  if (call.name === 'read_file' || call.name === 'write_file' || call.name === 'edit_file') {
    return String(i.path ?? '');
  }
  if (call.name === 'grep' || call.name === 'search_files' || call.name === 'glob') {
    return String(i.pattern ?? i.query ?? i.path ?? '');
  }
  if (call.name === 'list_directory') {
    return String(i.path ?? '.');
  }
  return '';
}

/** Exported so the runtime can reuse this exact one-liner for the user-facing
 *  approval prompt — keeps the L7 telemetry line and the approval summary
 *  in sync. */
export function summarizeToolCall(call: ToolUseBlock): string {
  return summarize(call);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

/** Convenience: the empty "no telemetry yet" block. Used at step 0. */
export function emptyTelemetryBlock(): string {
  return '# Runtime telemetry\n(no telemetry yet — this is step 0)';
}
