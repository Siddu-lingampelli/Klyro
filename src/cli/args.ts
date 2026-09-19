/**
 * Shared CLI argument coercions (extracted from src/index.ts).
 *
 * Single source of truth for Commander option parsing so command modules
 * registered from src/cli/* behave identically to the entrypoint.
 */
import { InvalidArgumentError } from 'commander';

export function parsePositiveInt(name: string, v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError(`invalid ${name}: ${v}`);
  }
  return n;
}
