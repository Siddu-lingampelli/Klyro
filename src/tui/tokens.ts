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
    dim: '#9A9A9A',
    guide: '#3A3A3A',
    accent: '#FF6B1A',
    accentSoft: '#FFF1E6',
    ok: '#FF6B1A',
    err: '#E06C6C',
    warn: '#FF6B1A',
    info: '#6FA8DC',
    diffAddBg: '#12250F',
    diffDelBg: '#2A1212',
  },
  ansi: {
    accent: 'yellowBright' as const,
    accentBold: 'yellowBright' as const,
    fg: 'white' as const,
    soft: 'whiteBright' as const,
    dim: 'gray' as const,
    guide: 'gray' as const,
    ok: 'yellowBright' as const,
    err: 'red' as const,
    warn: 'yellowBright' as const,
    info: 'blue' as const,
    border: 'gray' as const,
    muted: 'gray' as const,
    success: 'yellowBright' as const,
    error: 'red' as const,
    warning: 'yellowBright' as const,
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
export const spacing = { sidebar: 28, inspector: 36 } as const;
