import { describe, it, expect } from 'vitest';
import { getCompletionScript } from './completion.js';

describe('completion scripts', () => {
  it('covers all shells and completes commands + flags', () => {
    for (const shell of ['bash', 'zsh', 'fish', 'powershell']) {
      const s = getCompletionScript(shell);
      expect(s).not.toBeNull();
      expect(s!).toContain('run');
      expect(s!).toContain('mcp');
      expect(s!).toContain('--max-steps');
      expect(s!).toContain('--verify-mode');
    }
    expect(getCompletionScript('tcsh')).toBeNull();
  });
});
