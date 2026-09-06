/**
 * §2.1 Color tokens + §2.2 Glyph set — TUI_DESIGN.md
 * Accent is Orange #E8843C (256:209, 16: yellow bold), one accent ≤5%
 * No backgrounds except diff viewer. fg.dim ≥4.5:1 on near-black.
 */
export const tokens = {
  colors: {
    accent: '#E8843C', // Orange — wordmark, prompt >, ●, thumb, selected
    fg: '#FFFFFF', // White — user input, headings, file names
    soft: '#F5F5F5', // Soft white — assistant prose
    dim: '#9A9A9A', // Dim white — hints, durations
    guide: '#3A3A3A', // Guide │
    ok: '#E8843C', // Orange for success check (white+orange theme)
    err: '#E06C6C',
    warn: '#E8843C', // Orange for running/spinner
    info: '#FFFFFF',
    diffAddBg: '#12250F',
    diffDelBg: '#2A1212',
  },
  ansi: {
    accent: 'yellowBright' as const, // #E8843C → vivid orange
    accentBold: 'yellowBright' as const,
    fg: 'whiteBright' as const, // #FFFFFF — pure white
    soft: 'white' as const,
    dim: 'gray' as const,
    guide: 'gray' as const,
    ok: 'yellowBright' as const, // ✓ orange vivid
    err: 'red' as const,
    warn: 'yellowBright' as const, // spinner orange vivid
    info: 'white' as const,
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
  modeAccept: '◐',
  modePlan: '○',
  modeAuto: '●',
  editsBadge: '✎',
  dot: '·',
  ellipsis: '…',
  meterFilled: '▰',
  meterEmpty: '▱',
  continuation: '↪',
  // compat
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
} as const;

export function isAsciiMode(): boolean {
  return (
    process.env.TERM === 'dumb' ||
    process.env.KLYRO_ASCII === '1' ||
    (process.env.LANG !== undefined && !process.env.LANG.toLowerCase().includes('utf-8')) ||
    false
  );
}
export function g(name: keyof typeof glyphs): string {
  if (isAsciiMode()) return (glyphAscii as Record<string, string>)[name] ?? glyphs[name];
  return glyphs[name];
}
export const spacing = { maxWidth: 120, indent: 2, gap: 1 } as const;
