/**
 * 1.5 — incremental markdown renderer (headers, code w/ highlight, lists, tables)
 * Minimal: handles headers, code blocks, lists, tables, width-aware wrap, plain-text for non-TTY.
 */

export function renderMarkdown(md: string, opts: { width?: number; isTTY?: boolean } = {}): string {
  const width = opts.width ?? (process.stdout.columns || 80);
  const isTTY = opts.isTTY ?? !!process.stdout.isTTY;
  if (!isTTY || process.env.KLYRO_JSON === '1' || process.env.NO_COLOR === '1') {
    // Plain text: strip markdown decorations
    return stripMarkdown(md);
  }
  let out = '';
  const lines = md.split('\n');
  let inCodeBlock = false;
  for (let line of lines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      out += (inCodeBlock ? '┌ code ──\n' : '└──────\n');
      continue;
    }
    if (inCodeBlock) {
      out += '│ ' + line + '\n';
      continue;
    }
    if (line.startsWith('# ')) {
      out += '\n' + line.replace(/^#\s+/, '').toUpperCase() + '\n' + '─'.repeat(Math.min(width, 40)) + '\n';
      continue;
    }
    if (line.startsWith('## ')) {
      out += '\n' + line.replace(/^##\s+/, '') + '\n';
      continue;
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      out += '• ' + line.slice(2) + '\n';
      continue;
    }
    if (line.startsWith('|') && line.endsWith('|')) {
      // Table row: replace | with │ and trim
      const cells = line.split('|').filter(Boolean).map((c) => c.trim());
      out += '│ ' + cells.join(' │ ') + ' │\n';
      continue;
    }
    // Wrap long lines
    if (line.length > width) {
      const words = line.split(' ');
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).length > width) {
          out += cur.trimEnd() + '\n';
          cur = w + ' ';
        } else {
          cur += w + ' ';
        }
      }
      if (cur.trim()) out += cur.trimEnd() + '\n';
    } else {
      out += line + '\n';
    }
  }
  return out;
}

function stripMarkdown(md: string): string {
  return md
    .replace(/^#+\s+/gm, '')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, '').trim())
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

export function renderIncremental(prev: string, nextChunk: string): string {
  // For streaming, just append and re-render last chunk
  return renderMarkdown(prev + nextChunk);
}
