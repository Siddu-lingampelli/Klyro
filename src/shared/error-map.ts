/**
 * Single mapper unifying the three error dialects:
 *   - ToolErrorCode  (tools/normalize.ts — per-tool failures)
 *   - FailureClass   (verification/classify.ts — verify repair classes)
 *   → KlyroErrorCode (shared/errors.ts — harness-wide + exit codes)
 *
 * Type-only imports keep this module cycle-free: it is safe to import
 * from tools/, verification/, and cli/ alike.
 */
import { EXIT_CODE, type KlyroErrorCode } from './errors.js';
import type { FailureClass } from '../verification/classify.js';

export { EXIT_CODE };
export type { KlyroErrorCode };

/** Map any tool-layer error code to its harness-wide KlyroErrorCode. */
export function toolErrorToKlyroCode(code: string): KlyroErrorCode {
  switch (code) {
    case 'NOT_FOUND':
    case 'COMMAND_NOT_FOUND':
    case 'MATCH_NOT_FOUND':
    case 'UNKNOWN_TOOL':
      return 'TOOL_NOT_FOUND';
    case 'PERMISSION_DENIED':
    case 'COMMAND_DENIED':
    case 'POLICY_DENIED':
      return 'TOOL_DENIED';
    case 'PATH_ESCAPE':
      return 'PATH_ESCAPE';
    case 'TIMEOUT':
      return 'PROVIDER_TIMEOUT';
    case 'INVALID_INPUT':
    case 'INVALID_PATCH':
    case 'HUNK_MISMATCH':
    case 'MATCH_AMBIGUOUS':
      return 'CONFIG_INVALID';
    case 'ABORTED':
    case 'STALE':
    case 'EXIT_NONZERO':
    case 'IO_ERROR':
    case 'INTERNAL':
    default:
      return 'UNKNOWN';
  }
}

/** Map a verification failure class to its harness-wide code. */
export function failureClassToKlyroCode(cls: FailureClass): KlyroErrorCode {
  switch (cls) {
    case 'introduced':
      return 'VERIFY_FAILED';
    case 'pre_existing':
    case 'flaky':
      // Not the agent's fault — surfaced as advisory, not a hard failure.
      return 'UNKNOWN';
    case 'env':
      return 'CONFIG_INVALID';
  }
}

/** Exit code for any mapped error: single entry point for CLI mapping. */
export function exitCodeFor(code: KlyroErrorCode): number {
  return EXIT_CODE[code] ?? 1;
}
