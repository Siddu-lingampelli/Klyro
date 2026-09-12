/**
 * design.md §23/§24 — terminal Markdown rendering (pure, no React).
 *
 * Supports: headings, **bold**, *italic* (dim — Ink has no italic),
 * `inline code`, ``` fenced blocks (dimmed), [links](url), lists, tables
 * (best-effort passthrough). Everything renders as terminal text, no HTML.
 */

export interface MdPart {
  text: string;
  bold?: boolean;
  dim?: boolean;
  code?: boolean;
  /** color name for inline syntax highlighting within code blocks (R4). */
  color?: 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'gray';
  /** OSC-8 hyperlink target (R4): file:line, urls, etc. */
  href?: string;
}

export interface MdLine {
  parts: MdPart[];
  /** inside a ``` fence (render the whole line dimmed) */
  fence: boolean;
}

const INLINE_RE = /\*\*(.+?)\*\*|\*([^*\n]+?)\*|`([^`\n]+?)`|\[([^\]]+?)\]\(([^)]+?)\)/g;

/**
 * R4 — regex-based lightweight syntax highlighting for fenced code blocks.
 * No heavy tokenizer dependency; keyword/string/comment/number detection
 * keeps tool output scannable in the terminal. Pure, unit-testable.
 */

/** Comment prefixes per common language (used to dim comments). */
const COMMENT_MARKERS: Record<string, string[]> = {
  ts: ['//', '/*', '*'],
  js: ['//', '/*', '*'],
  jsx: ['//', '/*', '*'],
  tsx: ['//', '/*', '*'],
  py: ['#'],
  rb: ['#'],
  go: ['//', '/*'],
  rs: ['//', '/*'],
  java: ['//', '/*', '*'],
  c: ['//', '/*', '*'],
  cpp: ['//', '/*', '*'],
  sh: ['#'],
  bash: ['#'],
  yaml: ['#'],
  yml: ['#'],
  toml: ['#'],
  sql: ['--', '/*'],
};

const STRING_DELIMS = ["'", '"', '`'];

/** Keywords that get highlighted, grouped by language family. */
const KEYWORDS: Record<string, string[]> = {
  js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'of', 'in', 'while', 'class', 'import', 'export', 'default', 'from', 'await', 'async', 'new', 'this', 'null', 'undefined', 'true', 'false', 'typeof', 'instanceof', 'throw', 'try', 'catch', 'switch', 'case', 'break', 'continue'],
  ts: ['interface', 'type', 'enum', 'namespace', 'readonly', 'declare', 'extends', 'implements', 'public', 'private', 'protected', 'abstract', 'as', 'satisfies', 'const', 'let', 'function', 'return', 'if', 'else', 'for', 'of', 'in', 'while', 'class', 'import', 'export', 'default', 'from', 'await', 'async', 'new', 'this', 'null', 'undefined', 'true', 'false', 'typeof', 'instanceof', 'throw', 'try', 'catch', 'switch', 'case', 'break', 'continue'],
  py: ['import', 'from', 'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'in', 'while', 'with', 'as', 'lambda', 'pass', 'break', 'continue', 'True', 'False', 'None', 'and', 'or', 'not', 'is', 'raise', 'try', 'except', 'finally', 'yield', 'global', 'async', 'await', 'self'],
  go: ['func', 'func(', 'package', 'import', 'var', 'const', 'type', 'struct', 'interface', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'break', 'continue', 'defer', 'go', 'select', 'map', 'chan', 'nil', 'true', 'false', 'err', 'make'],
  rs: ['fn', 'let', 'mut', 'const', 'use', 'mod', 'struct', 'enum', 'impl', 'trait', 'pub', 'async', 'await', 'match', 'if', 'else', 'for', 'in', 'while', 'loop', 'return', 'move', 'ref', 'dyn', 'Self', 'self', 'true', 'false', 'None', 'Some', 'Ok', 'Err', 'Vec', 'String'],
  sh: ['export', 'local', 'if', 'then', 'fi', 'else', 'elif', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'echo', 'printf', 'read', 'cd', 'source', '.', 'return', 'exit', 'set', 'unset', 'command'],
  bash: ['export', 'local', 'if', 'then', 'fi', 'else', 'elif', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'echo', 'printf', 'read', 'cd', 'source', '.', 'return', 'exit', 'set', 'unset'],
  json: ['true', 'false', 'null'],
  yaml: ['true', 'false', 'null', 'yes', 'no'],
};

/**
 * Highlight a single code line. Returns an array of parts that may carry a
 * `color` for Ink/TerminalRenderer to render. Falls back to dim text when the
 * language is unknown or the line is a fence marker.
 */
export function highlightCodeLine(line: string, lang: string): MdPart[] {
  const trimmed = line.trimStart();
  const comments = COMMENT_MARKERS[lang] ?? [];
  const keywords = KEYWORDS[lang] ?? [];
  const kwSet = new Set(keywords);

  // Whole-line comment → dim.
  for (const c of comments) {
    if (trimmed.startsWith(c)) return [{ text: line, dim: true, code: true }];
  }

  const parts: MdPart[] = [];
  let i = 0;
  let inString = false;
  let strDelim = '';
  let buf = '';

  const flush = (): void => {
    if (!buf) return;
    parts.push({ text: buf, code: true });
    buf = '';
  };
  const flushKw = (tok: string): void => {
    if (kwSet.has(tok)) parts.push({ text: tok, color: 'cyan', code: true });
    else if (/^\d+(\.\d+)?$/.test(tok)) parts.push({ text: tok, color: 'yellow', code: true });
    else parts.push({ text: tok, code: true });
  };

  while (i < line.length) {
    const ch = line[i]!;
    if (inString) {
      buf += ch;
      if (ch === strDelim) { inString = false; flush(); }
      else if (ch === '\\' && i + 1 < line.length) { buf += line[i + 1]!; i += 2; continue; }
      i++;
      continue;
    }
    // Inline comment inside a code line.
    for (const c of comments) {
      if (c && line.slice(i, i + c.length) === c) {
        flush();
        parts.push({ text: line.slice(i), dim: true, code: true });
        return parts;
      }
    }
    if (STRING_DELIMS.includes(ch)) {
      flush();
      inString = true; strDelim = ch; buf = ch; i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j]!)) j++;
      const tok = line.slice(i, j);
      flushKw(tok);
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < line.length && /[0-9._]/.test(line[j]!)) j++;
      flush();
      parts.push({ text: line.slice(i, j), color: 'yellow', code: true });
      i = j;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  if (parts.length === 0) parts.push({ text: line, code: true });
  return parts;
}

/** Detect `file:line` / `file:line:col` references and attach OSC-8 hrefs. */
export const FILE_LINE_RE = /((?:\.{0,2}\/)?[\w./-]+\.[a-zA-Z]+\w*):(\d+)(?::(\d+))?/g;

export function annotateFileLinks(parts: MdPart[]): MdPart[] {
  const out: MdPart[] = [];
  for (const p of parts) {
    if (p.code || !p.text) { out.push(p); continue; }
    // Preserve the original part's styling on the unattributed plain-text runs.
    const style: MdPart = { text: '', ...(p.bold ? { bold: true } : {}), ...(p.dim ? { dim: true } : {}) };
    FILE_LINE_RE.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    let matched = false;
    while ((m = FILE_LINE_RE.exec(p.text))) {
      matched = true;
      if (m.index > last) out.push({ ...style, text: p.text.slice(last, m.index) });
      const path = m[1]!;
      const line = m[2]!;
      const col = m[3] ? `:${m[3]}` : '';
      out.push({ text: `${path}:${line}${col}`, href: `file://${path}#L${line}` });
      last = m.index + m[0].length;
    }
    if (!matched) out.push(p);
    else if (last < p.text.length) out.push({ ...style, text: p.text.slice(last) });
  }
  return out;
}

function parseInline(s: string): MdPart[] {
  const parts: MdPart[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(s))) {
    if (m.index > last) parts.push({ text: s.slice(last, m.index) });
    if (m[1] !== undefined) parts.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) parts.push({ text: m[2], dim: true });
    else if (m[3] !== undefined) parts.push({ text: m[3], code: true });
    else if (m[4] !== undefined) {
      parts.push({ text: m[4] });
      if (m[5]) parts.push({ text: ` (${m[5]})`, dim: true });
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ text: s.slice(last) });
  if (parts.length === 0) parts.push({ text: s });
  return parts;
}

/** Split assistant text into styled lines. Pure — unit-tested. */
export function renderMarkdownLines(text: string): MdLine[] {
  const out: MdLine[] = [];
  let inFence = false;
  let fenceLang = '';
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('```')) {
      if (!inFence) fenceLang = trimmed.replace(/^```/, '').trim().toLowerCase();
      inFence = !inFence;
      out.push({ parts: [{ text: raw, dim: true }], fence: true });
      continue;
    }
    if (inFence) {
      // R4: syntax-highlight the code line, annotated with file:line links.
      out.push({ parts: annotateFileLinks(highlightCodeLine(raw, fenceLang)), fence: true });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      // Headings are bold, but inline markup inside still parses.
      out.push({
        parts: parseInline(heading[2] ?? '').map((p) => ({ ...p, bold: true })),
        fence: false,
      });
      continue;
    }
    // R4: clickable file:line references in ordinary prose too.
    out.push({ parts: annotateFileLinks(parseInline(raw)), fence: false });
  }
  return out;
}
