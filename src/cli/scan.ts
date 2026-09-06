/**
 * 7.1 — klyro scan / klyro project
 * Scans project and prints ProjectMap. Used by /project and for L6 verifier feeding.
 */
import { buildProjectMapCached, formatProjectMap } from '../context/project-map.js';

export async function runScan(opts: { cwd?: string; json?: boolean }): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const start = Date.now();
  const m = await buildProjectMapCached(cwd);
  const elapsed = Date.now() - start;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...m, elapsedMs: elapsed }, null, 2) + '\n');
  } else {
    process.stdout.write(formatProjectMap(m) + '\n');
    process.stdout.write(`\n(scan ${elapsed}ms)\n`);
  }
  return 0;
}

export async function runProject(opts: { cwd?: string; json?: boolean }): Promise<number> {
  return runScan(opts);
}
