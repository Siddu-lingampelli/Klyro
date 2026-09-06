/**
 * Design Tokens — TUI_DESIGN.md §4
 * Semantic colors, glyphs, spacing for Klyro TUI
 */

export const tokens = {
  colors: {
    accent: '#8B7CF6',
    fg: '#E6E6E6',
    muted: '#7A7A7A',
    success: '#4ADE80',
    error: '#F87171',
    warning: '#FBBF24',
    info: '#60A5FA',
    diffAddBg: '#12351F',
    diffDelBg: '#3B1519',
    border: '#3A3A3A',
    codeBg: '#1E1E1E',
    thinking: '#7A7A7A',
  },
  // For Ink, map to closest ANSI names
  ansi: {
    accent: 'magenta',
    fg: undefined,
    muted: 'gray',
    success: 'green',
    error: 'red',
    warning: 'yellow',
    info: 'blue',
    border: 'gray',
  },
} as const;

export const glyphs = {
  prompt: '›',
  promptAscii: '>',
  toolRunning: '●',
  toolDone: '●',
  connector: '⎿',
  connectorAscii: '\\',
  success: '✔',
  successAscii: '[ok]',
  failure: '✘',
  failureAscii: '[x]',
  warning: '⚠',
  warningAscii: '[!]',
  spinner: ['✻', '✽', '✶', '✳', '✢', '·'] as const,
  spinnerAscii: ['-', '\\', '|', '/'] as const,
  pending: '○',
  pendingAscii: 'o',
  checkboxDone: '☒',
  checkboxTodo: '☐',
  repair: '↻',
  repairAscii: '~',
  compaction: '⟲',
  compactionAscii: '~~',
  expand: '▸',
  selected: '❯',
  contextBar: '▰',
  contextBarEmpty: '▱',
  brand: '◆',
  brandAscii: '*',
} as const;

export function isAsciiMode(): boolean {
  return (
    process.env.TERM === 'dumb' ||
    process.env.KLYRO_ASCII === '1' ||
    (process.env.LANG !== undefined && !process.env.LANG.toLowerCase().includes('utf-8')) ||
    process.platform === 'win32' // legacy console fallback check could be more precise
  );
}

export function glyph(name: keyof typeof glyphs): string {
  if (isAsciiMode()) {
    const asciiKey = `${String(name)}Ascii` as keyof typeof glyphs;
    const val = glyphs[asciiKey];
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) return (val as readonly string[])[0] ?? '>';
    return '>';
  }
  const val = glyphs[name];
  if (Array.isArray(val)) return (val as readonly string[])[0] ?? '●';
  return val as string;
}

export const spacing = {
  maxWidth: 120,
  indent: 2,
  gap: 1,
} as const;
