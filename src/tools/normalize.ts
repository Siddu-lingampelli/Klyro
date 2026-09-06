/**
 * Normalize any thrown value or system error into a ToolResult error.
 * Centralizing this means tools can `throw` and the harness sees structured
 * errors without each tool hand-coding the shape.
 */

import type { ToolResult } from './types.js';

/** Standard tool error codes. Tools may add their own. */
export const TOOL_ERROR_CODES = {
  NOT_FOUND: 'NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INVALID_INPUT: 'INVALID_INPUT',
  IO_ERROR: 'IO_ERROR',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  PATH_ESCAPE: 'PATH_ESCAPE',
  COMMAND_DENIED: 'COMMAND_DENIED',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  EXIT_NONZERO: 'EXIT_NONZERO',
  INTERNAL: 'INTERNAL',
} as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES] | string;

interface NodeError extends Error {
  code?: string;
  path?: string;
  syscall?: string;
}

export function toToolError(err: unknown, fallbackCode: ToolErrorCode = TOOL_ERROR_CODES.INTERNAL): {
  code: ToolErrorCode;
  message: string;
  details?: unknown;
} {
  if (err === null || err === undefined) {
    return { code: fallbackCode, message: 'Unknown error' };
  }
  if (err instanceof Error) {
    // If the error already declares a tool-level `code` (e.g. PathGuardError),
    // honor it instead of mapping through Node errno.
    const maybeCode = (err as { code?: unknown }).code;
    if (typeof maybeCode === 'string' && isToolErrorCode(maybeCode)) {
      return { code: maybeCode, message: err.message };
    }
    if (typeof maybeCode === 'string') {
      // Looks like a Node errno (e.g. 'ENOENT'); map it.
      return {
        code: mapNodeErrorCode(maybeCode),
        message: err.message,
        details: { syscall: (err as NodeError).syscall, path: (err as NodeError).path },
      };
    }
    return { code: fallbackCode, message: err.message, details: err.stack };
  }
  return { code: fallbackCode, message: String(err) };
}

const CUSTOM_TOOL_CODES = new Set([
  'MATCH_NOT_FOUND',
  'MATCH_AMBIGUOUS',
  'UNKNOWN_TOOL',
  'INVALID_INPUT',
  'INVALID_PATCH',
  'HUNK_MISMATCH',
  'POLICY_DENIED',
  'STALE',
]);

function isToolErrorCode(code: string): boolean {
  return (Object.values(TOOL_ERROR_CODES) as string[]).includes(code) || CUSTOM_TOOL_CODES.has(code);
}

function mapNodeErrorCode(code: string | undefined): ToolErrorCode {
  switch (code) {
    case 'ENOENT':
      return TOOL_ERROR_CODES.NOT_FOUND;
    case 'EACCES':
    case 'EPERM':
      return TOOL_ERROR_CODES.PERMISSION_DENIED;
    case 'EISDIR':
    case 'ENOTDIR':
      return TOOL_ERROR_CODES.IO_ERROR;
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return TOOL_ERROR_CODES.TIMEOUT;
    case 'ECANCELED':
    case 'ABORT_ERR':
      return TOOL_ERROR_CODES.ABORTED;
    default:
      return TOOL_ERROR_CODES.IO_ERROR;
  }
}

/** Convenience: wrap a function in try/catch and return a ToolResult.
 *  If the function returns a ToolResult (already-shaped), it is passed through
 *  unwrapped. Otherwise the function's return value becomes `value` on success.
 */
export async function safe<T>(fn: () => Promise<T | ToolResult<T>>): Promise<ToolResult<T>> {
  try {
    const result = await fn();
    // Only pass through true tool-level errors: ok:false WITH an error
    // object. Tools that return a value with an `ok` field of their own
    // (e.g. VerifyOutput.ok = "did the verify command succeed") get
    // wrapped so the harness sees ToolResult<T>, not a bare T.
    if (
      result &&
      typeof result === 'object' &&
      (result as { ok?: unknown }).ok === false &&
      (result as { error?: unknown }).error
    ) {
      return result as unknown as ToolResult<T>;
    }
    return { ok: true, value: result as T };
  } catch (err) {
    return { ok: false, error: toToolError(err) };
  }
}
