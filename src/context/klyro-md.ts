/**
 * 4.4 — KLYRO.md loader: ~/.klyro/KLYRO.md → root → KLYRO.local.md → subdir files lazily
 *
 * Safety: @import targets are contained to the project cwd (escapes are
 * skipped, not read — a malicious KLYRO.md must not pull /etc/passwd or
 * secret files into context), each file is capped, and total output is
 * capped so a giant monorepo doc can't blow the context budget.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const MAX_FILE_CHARS = 4000;
const MAX_TOTAL_CHARS = 8000;

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n... [truncated ${s.length - n} chars]` : s;
}

export async function loadKlyroMd(cwd: string): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  const push = (s: string): void => {
    if (total >= MAX_TOTAL_CHARS) return;
    const room = MAX_TOTAL_CHARS - total;
    const chunk = s.length > room ? s.slice(0, room) + '\n... [truncated]' : s;
    parts.push(chunk);
    total += chunk.length;
  };
  // Global
  const home = os.homedir();
  if (home) {
    for (const p of [path.join(home, '.klyro', 'KLYRO.md'), path.join(home, '.klyro', 'KLYRO.local.md')]) {
      try {
        const t = await fs.readFile(p, 'utf-8');
        push(`# ${p}\n${cap(t, MAX_FILE_CHARS)}`);
      } catch { /* ignore */ }
    }
  }
  // Root (imports resolved relative to each file, contained to cwd)
  for (const name of ['KLYRO.md', 'KLYRO.local.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
    const p = path.join(cwd, name);
    try {
      const t = await fs.readFile(p, 'utf-8');
      push(`# ${p}\n${cap(await resolveImports(t, path.dirname(p), cwd), MAX_FILE_CHARS)}`);
    } catch { /* ignore */ }
  }
  return parts.join('\n\n---\n\n');
}

async function resolveImports(text: string, base: string, root: string, depth = 0): Promise<string> {
  if (depth > 5) return text;
  const importRe = /^@import\s+(.+)$/gm;
  let out = text;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(text))) {
    const rel = m[1]!.trim().replace(/^["']|["']$/g, '');
    const p = path.resolve(base, rel);
    // Containment: never follow imports outside the project root.
    const relToRoot = path.relative(root, p);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) continue;
    try {
      const t = await fs.readFile(p, 'utf-8');
      const resolved = await resolveImports(cap(t, MAX_FILE_CHARS), path.dirname(p), root, depth + 1);
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
