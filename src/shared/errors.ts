/**
 * Shared KlyroError — base for all harness errors.
 * Carries code, hint, exitCode, retryable for CLI mapping.
 */

export type KlyroErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_NOT_FOUND'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_TIMEOUT'
  | 'TOOL_DENIED'
  | 'TOOL_NOT_FOUND'
  | 'PATH_ESCAPE'
  | 'VERIFY_FAILED'
  | 'PERSIST_ERROR'
  | 'UNKNOWN';

export const EXIT_CODE: Record<KlyroErrorCode, number> = {
  CONFIG_INVALID: 3,
  CONFIG_NOT_FOUND: 3,
  PROVIDER_AUTH: 4,
  PROVIDER_RATE_LIMIT: 4,
  PROVIDER_TIMEOUT: 4,
  TOOL_DENIED: 2,
  TOOL_NOT_FOUND: 2,
  PATH_ESCAPE: 2,
  VERIFY_FAILED: 8,
  PERSIST_ERROR: 2,
  UNKNOWN: 1,
};

export class KlyroError extends Error {
  readonly code: KlyroErrorCode;
  readonly hint?: string;
  readonly exitCode: number;
  readonly retryable: boolean;

  constructor(
    code: KlyroErrorCode,
    message: string,
    opts: { hint?: string; exitCode?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'KlyroError';
    this.code = code;
    this.hint = opts.hint;
    this.exitCode = opts.exitCode ?? EXIT_CODE[code] ?? 1;
    this.retryable = opts.retryable ?? false;
    if (opts.cause) (this as unknown as { cause: unknown }).cause = opts.cause;
  }
}
