/**
 * Model-graded judge for evals: scores a finished run against a rubric.
 *
 * Structural asserts (status, tool counts) catch regressions; the judge
 * catches semantic failures (wrong file, wrong content, ignored task).
 * Runs on any ProviderAdapter — in CI, pass a live adapter + judge model;
 * offline runs skip judging (recorded as `skipped`).
 */
import type { ProviderAdapter } from '../agent/provider-adapter.js';

export interface JudgeSpec {
  /** Each item is one binary criterion, e.g. "note.txt contains exactly 'hi'". */
  rubric: string[];
  /** Model for grading (defaults to the caller's judge model). */
  model?: string;
}

export interface JudgeVerdict {
  pass: boolean;
  scores: Record<string, number>;
  notes: string;
  skipped: boolean;
}

function extractJson(text: string): unknown | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Grade a finished run. Returns `{pass:false}` (never throws) when the
 * model output is unparsable or the call fails — an inconclusive judge
 * must not silently pass.
 */
export async function runJudge(
  adapter: ProviderAdapter,
  model: string,
  input: { task: string; finalText: string; toolCalls: number; extra?: string },
  rubric: string[],
): Promise<JudgeVerdict> {
  if (rubric.length === 0) return { pass: true, scores: {}, notes: 'empty rubric', skipped: false };
  const criteria = rubric.map((r, i) => `  c${i + 1}. ${r}`).join('\n');
  const prompt = [
    'You are an evaluator grading an AI coding agent run. Score ONLY the criteria below.',
    `Task: ${input.task}`,
    `Final answer: ${input.finalText.slice(0, 2000)}`,
    `Tool calls made: ${input.toolCalls}`,
    input.extra ? `Run facts:\n${input.extra.slice(0, 2000)}` : '',
    'Criteria (score each 1 = met, 0 = not met):',
    criteria,
    'Respond with ONLY a JSON object: {"scores": {"c1": 1, ...}, "notes": "<one line>"}.',
  ].filter(Boolean).join('\n\n');
  let text = '';
  try {
    for await (const ev of adapter.stream({
      model,
      system: 'You are a strict evaluator. Reply with only the requested JSON.',
      messages: [{ role: 'user', content: [{ kind: 'text', text: prompt }] }],
      tools: [],
    })) {
      if (ev.kind === 'text_delta') text += ev.text;
      else if (ev.kind === 'error') return { pass: false, scores: {}, notes: `judge call failed: ${ev.message}`, skipped: false };
    }
  } catch (err) {
    return { pass: false, scores: {}, notes: `judge call threw: ${err instanceof Error ? err.message : String(err)}`, skipped: false };
  }
  const parsed = extractJson(text) as { scores?: Record<string, unknown>; notes?: unknown } | null;
  if (!parsed || typeof parsed.scores !== 'object' || parsed.scores === null) {
    return { pass: false, scores: {}, notes: 'judge output unparsable', skipped: false };
  }
  const scores: Record<string, number> = {};
  let pass = true;
  rubric.forEach((_r, i) => {
    const v = (parsed.scores as Record<string, unknown>)[`c${i + 1}`];
    const n = v === 1 || v === '1' || v === true ? 1 : 0;
    scores[`c${i + 1}`] = n;
    if (n !== 1) pass = false;
  });
  return { pass, scores, notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 500) : '', skipped: false };
}
