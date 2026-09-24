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

/**
 * 5.3 — `--auto-answer <text>` wiring. `ask_user` honors
 * `KLYRO_AUTO_ANSWER` in headless runs; `klyro run` / `klyro eval` set it
 * from the flag via this helper before the run starts (explicit env wins
 * when the flag is omitted). Exported for tests.
 */
export function applyAutoAnswer(value: string | undefined): void {
  if (value !== undefined) process.env.KLYRO_AUTO_ANSWER = value;
}
