/**
 * 4.4 — KLYRO.md loader: ~/.klyro/KLYRO.md → root → KLYRO.local.md → subdir files lazily
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const CACHE = new Map<string, string>();

export async function loadKlyroMd(cwd: string): Promise<string> {
  const parts: string[] = [];
  // Global
  const home = os.homedir();
  if (home) {
    for (const p of [path.join(home, '.klyro', 'KLYRO.md'), path.join(home, '.klyro', 'KLYRO.local.md')]) {
      try { const t = await fs.readFile(p, 'utf-8'); parts.push(`# ${p}\n${t}`); } catch { /* ignore */ }
    }
  }
  // Root
  for (const name of ['KLYRO.md', 'KLYRO.local.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
    const p = path.join(cwd, name);
    try { const t = await fs.readFile(p, 'utf-8'); parts.push(`# ${p}\n${await resolveImports(t, path.dirname(p))}`); } catch { /* ignore */ }
  }
  return parts.join('\n\n---\n\n');
}

async function resolveImports(text: string, base: string, depth = 0): Promise<string> {
  if (depth > 5) return text;
  const importRe = /^@import\s+(.+)$/gm;
  let out = text;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(text))) {
    const rel = m[1]!.trim().replace(/^["']|["']$/g, '');
    const p = path.resolve(base, rel);
    try {
      const t = await fs.readFile(p, 'utf-8');
      const resolved = await resolveImports(t, path.dirname(p), depth + 1);
      out = out.replace(m[0], resolved);
    } catch { /* ignore missing */ }
  }
  return out;
}

export async function handleInit(cwd: string): Promise<string> {
  const md = await loadKlyroMd(cwd);
  if (md) return `Existing KLYRO.md found. Review and update?`;
  const draft = `# KLYRO.md\n\nProject: ${path.basename(cwd)}\n\n## Conventions\n- Use edit_file > write_file for existing files\n- Run tests after changes\n`;
  return draft;
}
