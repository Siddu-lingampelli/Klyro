import { describe, it, expect } from 'vitest';
import { toolErrorToKlyroCode, failureClassToKlyroCode, exitCodeFor } from './error-map.js';

describe('error-map — single mapper for the three dialects', () => {
  it('maps tool codes to harness codes', () => {
    expect(toolErrorToKlyroCode('NOT_FOUND')).toBe('TOOL_NOT_FOUND');
    expect(toolErrorToKlyroCode('COMMAND_NOT_FOUND')).toBe('TOOL_NOT_FOUND');
    expect(toolErrorToKlyroCode('UNKNOWN_TOOL')).toBe('TOOL_NOT_FOUND');
    expect(toolErrorToKlyroCode('PERMISSION_DENIED')).toBe('TOOL_DENIED');
    expect(toolErrorToKlyroCode('POLICY_DENIED')).toBe('TOOL_DENIED');
    expect(toolErrorToKlyroCode('PATH_ESCAPE')).toBe('PATH_ESCAPE');
    expect(toolErrorToKlyroCode('TIMEOUT')).toBe('PROVIDER_TIMEOUT');
    expect(toolErrorToKlyroCode('INVALID_INPUT')).toBe('CONFIG_INVALID');
    expect(toolErrorToKlyroCode('HUNK_MISMATCH')).toBe('CONFIG_INVALID');
    expect(toolErrorToKlyroCode('SOMETHING_ELSE')).toBe('UNKNOWN');
  });

  it('maps verify failure classes', () => {
    expect(failureClassToKlyroCode('introduced')).toBe('VERIFY_FAILED');
    expect(failureClassToKlyroCode('pre_existing')).toBe('UNKNOWN');
    expect(failureClassToKlyroCode('flaky')).toBe('UNKNOWN');
    expect(failureClassToKlyroCode('env')).toBe('CONFIG_INVALID');
  });

  it('resolves exit codes through the single entry point', () => {
    expect(exitCodeFor('VERIFY_FAILED')).toBe(8);
    expect(exitCodeFor('TOOL_DENIED')).toBe(2);
    expect(exitCodeFor('UNKNOWN')).toBe(1);
  });
});
