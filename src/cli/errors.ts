/**
 * 1.5 — handleFatal: ✖ message / hint: / "run with --debug", mapped exit codes
 */

import { KlyroError } from '../shared/errors.js';

export function handleFatal(err: unknown): never {
  const isDebug = !!process.env.KLYRO_LOG_LEVEL || !!process.env.DEBUG || process.argv.includes('--debug');
  let code = 1;
  let message = err instanceof Error ? err.message : String(err);
  let hint: string | undefined;

  if (err instanceof KlyroError) {
    code = err.exitCode;
    hint = err.hint;
  } else if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
    code = 2;
    hint = 'Check the file path exists';
  }

  // Never print stack without --debug
  if (!isDebug) {
    // Strip stack, only print message
    process.stderr.write(`✖ ${message}\n`);
  } else {
    process.stderr.write(`✖ ${message}\n`);
    if (err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
  }
  if (hint) process.stderr.write(`  hint: ${hint}\n`);
  if (!isDebug) process.stderr.write('  run with --debug for stack trace\n');

  process.exit(code);
}

export function setupGlobalHandlers(): void {
  process.on('uncaughtException', (err) => handleFatal(err));
  process.on('unhandledRejection', (reason) => handleFatal(reason));
}
