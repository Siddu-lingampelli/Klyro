/**
 * Strip a leading U+FEFF byte-order mark. Windows editors (e.g. Notepad)
 * save JSON with a BOM by default; `JSON.parse` rejects it, so user-authored
 * config files must be BOM-tolerant. Use this on every raw string read for
 * config/threat-surface parsing.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
