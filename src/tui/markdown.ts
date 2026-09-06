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
}

export interface MdLine {
  parts: MdPart[];
  /** inside a ``` fence (render the whole line dimmed) */
  fence: boolean;
}

const INLINE_RE = /\*\*(.+?)\*\*|\*([^*\n]+?)\*|`([^`\n]+?)`|\[([^\]]+?)\]\(([^)]+?)\)/g;

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
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      out.push({ parts: [{ text: raw, dim: true }], fence: true });
      continue;
    }
    if (inFence) {
      out.push({ parts: [{ text: raw, dim: true, code: true }], fence: true });
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
    out.push({ parts: parseInline(raw), fence: false });
  }
  return out;
}
