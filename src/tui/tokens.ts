/**
 * Klyro tokens — White & Orange #FF6B1A light + Dark #E8843C — per design.md + TUI_DESIGN.md
 * True 24-bit hex, Ink will render via 256-color fallback. No backgrounds except diff.
 */
export const tokens = {
  colors: {
    bg: '#FFFFFF',
    bgElevated: '#FAF7F2',
    fg: '#1A1A1A',
    soft: '#F5F5F5',
    // dim/guide raised for WCAG AA on white: #6B6B6B ≈ 4.86:1 (was #9A9A9A ≈
    // 2.9:1). guide stays the muted row glyph and is kept readable.
    dim: '#6B6B6B',
    guide: '#3A3A3A',
    accent: '#FF6B1A',
    accentSoft: '#FFF1E6',
    // Status hues deliberately distinct from the orange brand. These are
    // darkened for AA 4.5:1 on white (they were ~2.4-3:1).
    ok: '#1B7A4D',
    err: '#B3261E',
    warn: '#8A5A00',
    info: '#1F6FB2',
    // Diff rollover backgrounds are LIGHT-mode hexes (the TUI bg is white);
    // the dark hexes here were legacy dark-theme leftovers.
    diffAddBg: '#DFF5DF',
    diffDelBg: '#F9DEDC',
  },
  ansi: {
    accent: 'yellowBright' as const,
    accentBold: 'yellowBright' as const,
    fg: 'white' as const,
    soft: 'whiteBright' as const,
    dim: 'gray' as const,
    guide: 'gray' as const,
    ok: 'green' as const,
    err: 'red' as const,
    warn: 'yellow' as const,
    info: 'blue' as const,
    border: 'gray' as const,
    muted: 'gray' as const,
    success: 'green' as const,
    error: 'red' as const,
    warning: 'yellow' as const,
  },
} as const;

export const glyphs = {
  prompt: '>',
  agentBullet: '●',
  collapsed: '▸',
  expanded: '▾',
  guide: '│',
  branch: '├',
  end: '└',
  rule: '─',
  treeBranch: '├──',
  treeEnd: '└──',
  success: '✓',
  failure: '✗',
  warning: '!',
  repair: '↻',
  todoPending: '○',
  todoActive: '●',
  todoDone: '✓',
  todoPlan: '◇',
  logoBar: '▌',
  dotFilled: '●',
  dotEmpty: '○',
  brand: '◆',
  compaction: '⟲',
  editsBadge: '✎',
  dot: '·',
} as const;

export const glyphAscii = {
  prompt: '>',
  agentBullet: '*',
  collapsed: '>',
  expanded: 'v',
  guide: '|',
  branch: '|',
  end: '\\',
  rule: '-',
  treeBranch: '|--',
  treeEnd: '`--',
  success: 'ok',
  failure: 'x',
  warning: '!',
  repair: '~',
  todoPending: '[ ]',
  todoActive: '[>]',
  todoDone: '[x]',
  todoPlan: '#',
  logoBar: '|',
  dotFilled: '*',
  dotEmpty: 'o',
} as const;

export function isAsciiMode(): boolean {
  return process.env.TERM === 'dumb' || process.env.KLYRO_ASCII === '1' || false;
}
export function g(name: keyof typeof glyphs): string {
  if (isAsciiMode()) return (glyphAscii as Record<string, string>)[name] ?? glyphs[name];
  return glyphs[name];
}
// Sidebar/inspector pixel widths live in the TUI_DESIGN doc, not here —
// the old `spacing = {sidebar: 28, inspector: 36}` held dead numbers (the
// sidebar layout is unused in the render). Keep a placeholder so old imports
// don't break, but route new code to the doc.
export const spacing = {} as const;
