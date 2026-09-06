/**
 * Smart file selector — given the current transcript, return a list of
 * file paths the model is most likely to need next. Used to populate the
 * repo-map slot of the system prompt.
 *
 * Scoring (very simple):
 *   - exact path match in the transcript  → +100
 *   - basename match (e.g. "user.ts")     → +20
 *   - symbol name match (functions/types) → +10
 *   - file in repo map                    →  +1
 *
 * Top N by score.
 */

import type { RepoFile } from './repo-map.js';

export interface SelectOptions {
  /** Cap on returned files. */
  maxFiles?: number;
}

export function selectFiles(
  transcript: { role: string; content: string }[],
  repo: RepoFile[],
  opts: SelectOptions = {},
): RepoFile[] {
  const maxFiles = opts.maxFiles ?? 20;
  const corpus = transcript.map((m) => m.content).join('\n').toLowerCase();
  const scored = repo
    .map((f) => {
      let score = 1;
      const pathLower = f.path.toLowerCase();
      const base = pathLower.split('/').pop() ?? pathLower;
      if (corpus.includes(pathLower)) score += 100;
      if (corpus.includes(base)) score += 20;
      for (const s of f.symbols) {
        if (s.name.length > 3 && corpus.includes(s.name.toLowerCase())) score += 10;
      }
      return { file: f, score };
    })
    .filter((x) => x.score > 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles)
    .map((x) => x.file);
  return scored;
}
