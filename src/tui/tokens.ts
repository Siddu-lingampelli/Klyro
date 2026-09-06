/**
 * §2.1 Color tokens + §2.2 Glyph set — TUI_DESIGN.md
 * Accent is Orange #E8843C (256:209, 16: yellow bold), one accent ≤5%
 * No backgrounds except diff viewer. fg.dim ≥4.5:1 on near-black.
 */
export const tokens = {
  colors: {
    accent: '#E8843C',
    fg: '#E6E6E6',
    soft: '#B3B3B3',
    dim: '#6F6F6F',
    guide: '#3A3A3A',
    ok: '#6BBF6B',
    err: '#E06C6C',
    warn: '#D9A441',
    info: '#6FA8DC',
    diffAddBg: '#12250F',
    diffDelBg: '#2A1212',
  },
  ansi: {
    accent: 'yellow' as const,
    accentBold: 'yellowBright' as const,
    fg: undefined as unknown as string | undefined,
    soft: 'white' as const,
    dim: 'gray' as const,
    guide: 'gray' as const,
    ok: 'green' as const,
    err: 'red' as const,
    warn: 'yellow' as const,
    info: 'blue' as const,
    border: 'gray' as const,
    // compat aliases for older components (TUI_DESIGN §24 Don'ts still happy — no boxes)
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
