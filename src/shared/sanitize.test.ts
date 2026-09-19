import { describe, it, expect } from 'vitest';
import { sanitizeTerminalText } from './sanitize.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('sanitizeTerminalText', () => {
  it('preserves normal text, newlines, tabs, unicode', () => {
    expect(sanitizeTerminalText('hello\nworld\ttab')).toBe('hello\nworld\ttab');
    expect(sanitizeTerminalText('héllo 世界 🎉')).toBe('héllo 世界 🎉');
  });
  it('strips CSI sequences', () => {
    expect(sanitizeTerminalText(`a${ESC}[2Jb`)).toBe('ab');
    expect(sanitizeTerminalText(`a${ESC}[6n/reportb`)).toBe('a/reportb');
  });
  it('strips OSC hyperlinks', () => {
    expect(sanitizeTerminalText(`a${ESC}]8;;http://evil${BEL}click${ESC}]8;;${BEL}b`)).toBe('aclickb');
  });
  it('strips C0 controls and DEL', () => {
    expect(sanitizeTerminalText('a\x01\x08\x0bb\x7fc')).toBe('abc');
  });
  it('terminal matrix: wide chars, emoji, paste bursts, long lines', () => {
    // Wide CJK + emoji preserved.
    expect(sanitizeTerminalText('日本語 🎉 café')).toBe('日本語 🎉 café');
    // Pasted block with embedded escape + control junk is cleaned.
    const burst = `line1\n${ESC}[31mred${ESC}[0m\nline3\x00\x07end`;
    expect(sanitizeTerminalText(burst)).toBe('line1\nred\nline3end');
    // Very long single line passes through bounded only by caller limits.
    const long = 'x'.repeat(50_000);
    expect(sanitizeTerminalText(long)).toHaveLength(50_000);
    // Lone ESC and CSI sequences never leak (ESC[31b is a complete CSI).
    expect(sanitizeTerminalText(`a${ESC}b`)).toBe('ab');
    expect(sanitizeTerminalText(`a${ESC}[31b`)).toBe('a');
  });
});
