/**
 * refresh-map — precompute the Level-6 context for a working directory
 * and write it to .klyro/context.json.
 *
 * Usage:
 *   npx tsx scripts/refresh-map.ts [--cwd <path>] [--print]
 *
 * --print  print the formatted context to stdout instead of writing the cache.
 *
 * The cron entry just calls this script every 5 minutes on the user's project
 * directories. The runtime falls back to building it lazily on first run if
 * the cache is stale or missing.
 */

import * as path from 'node:path';
import { buildLevel6Context, writeLevel6Cache } from '../src/context/level6.js';

interface CliOptions {
  cwd: string;
  print: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { cwd: process.cwd(), print: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') {
      const v = argv[++i];
      if (v) opts.cwd = path.resolve(v);
    } else if (a === '--print') {
      opts.print = true;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: tsx scripts/refresh-map.ts [--cwd <path>] [--print]');
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv);
  const ctx = await buildLevel6Context({ cwd: opts.cwd });
  if (opts.print) {
    process.stdout.write(ctx.formatted);
    if (ctx.formatted && !ctx.formatted.endsWith('\n')) process.stdout.write('\n');
    return 0;
  }
  const file = await writeLevel6Cache(opts.cwd, ctx);
  const summary = {
    cwd: opts.cwd,
    cacheFile: file,
    hasProjectMap: ctx.hasProjectMap,
    hasRepoMap: ctx.hasRepoMap,
    hasRecentFiles: ctx.hasRecentFiles,
    hasDeps: ctx.hasDeps,
    formattedBytes: ctx.formatted.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  return file ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
