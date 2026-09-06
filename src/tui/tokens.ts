/**
 * design.md §2 — White & Orange (light default) + Dark mirror
 * Light: bg #FFFFFF orange #FF6B1A — Dark: bg #1A1A1A orange #FF8A3D
 * Only orange is saturated in chrome; content uses dim borders.
 */
export const tokens = {
  colors: {
    bg: '#FFFFFF',
    bgElevated: '#FAF7F2',
    bgSubtle: '#F5F0E8',
    fg: '#1A1A1A',
    fgMuted: '#6B6B6B',
    fgDim: '#9A9A9A',
    orange: '#FF6B1A',
    orangeHot: '#FF8A3D',
    orangeDeep: '#CC4F0A',
    orangeSoft: '#FFF1E6',
    border: '#E8E0D2',
    borderStrong: '#1A1A1A',
    success: '#2E7D32',
    warning: '#C77700',
    danger: '#C62828',
    codeBg: '#FAF7F2',
    codeBorder: '#E8E0D2',
    guide: '#E8E0D2',
    // dark mirror
    darkBg: '#1A1A1A',
    darkOrange: '#FF8A3D',
    darkBorder: '#333333',
  },
  ansi: {
    bg: 'white' as const,
    fg: 'black' as const,
    fgMuted: 'gray' as const,
    dim: 'gray' as const,
    orange: 'yellow' as const, // #FF6B1A → 202
    orangeBright: 'red' as const, // fallback vivid
    border: 'gray' as const,
    guide: 'gray' as const,
    success: 'green' as const,
    warning: 'yellow' as const,
    danger: 'red' as const,
    accent: 'yellow' as const,
    accentBold: 'yellowBright' as const,
    soft: 'white' as const,
    muted: 'gray' as const,
    error: 'red' as const,
    ok: 'green' as const,
    warn: 'yellow' as const,
    info: 'blue' as const,
    successAlt: 'green' as const,
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
  dotHalf: '◐',
  sidebar: '⊞',
  inspector: '▢',
  copy: '⧉',
  brand: '◆',
  compaction: '⟲',
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
  dotHalf: 'o',
} as const;

export function isAsciiMode(): boolean {
  return process.env.TERM === 'dumb' || process.env.KLYRO_ASCII === '1' || false;
}
export function g(name: keyof typeof glyphs): string {
  if (isAsciiMode()) return (glyphAscii as Record<string, string>)[name] ?? glyphs[name];
  return glyphs[name];
}
export const spacing = { maxWidth: 120, indent: 2, gap: 1, sidebar: 28, inspector: 36 } as const;
