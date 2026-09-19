/**
 * Terminal output sanitization (review section 11).
 *
 * Model and tool output is untrusted: it must never emit raw terminal
 * control sequences (OSC hyperlinks, CSI cursor/reporting, C0/C1 controls)
 * that could rewrite the display or smuggle approval-like text. The
 * human-mode TerminalRenderer writes directly to stdout/stderr, so all
 * human output is passed through `sanitizeTerminalText` first.
 *
 * Strips OSC + CSI sequences and C0/C1 controls (except newline/tab);
 * preserves printable Unicode, wide chars, and emoji.
 */
export function sanitizeTerminalText(input: string): string {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const out = input;
  let cleaned = '';
  let i = 0;
  while (i < out.length) {
    const ch = out[i] as string;
    const code = out.charCodeAt(i);
    if (ch === ESC) {
      const next = out[i + 1];
      if (next === '[') {
        let j = i + 2;
        while (j < out.length && !/[@-~]/.test(out[j] as string)) j++;
        i = j + 1;
        continue;
      }
      if (next === ']') {
        let j = i + 2;
        while (j < out.length && out[j] !== BEL && !(out[j] === ESC && out[j + 1] === '\\')) j++;
        i = out[j] === BEL ? j + 1 : j + 2;
        continue;
      }
      i += 1;
      continue;
    }
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f)) {
      i += 1;
      continue;
    }
    cleaned += ch;
    i += 1;
  }
  return cleaned;
}
