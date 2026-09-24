import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Converts a .gitignore rule to a regex. Assumes no negative (!) rules for now. */
export function ignoreRuleToRegex(rule: string): RegExp | null {
  let p = rule.trim();
  if (!p || p.startsWith('#') || p.startsWith('!')) return null;
  // Strip trailing slashes
  if (p.endsWith('/')) p = p.slice(0, -1);
  // If it starts with /, anchor to root; else it can match anywhere
  const anchorStart = p.startsWith('/') ? '^' : '(?:^|/)';
  if (p.startsWith('/')) p = p.slice(1);
  
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DS::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/::DS::/g, '.*');
  
  return new RegExp(`${anchorStart}${escaped}(?:/|$)`);
}

export class IgnoreFilter {
  private rules: RegExp[] = [];
  
  static async load(cwd: string): Promise<IgnoreFilter> {
    const filter = new IgnoreFilter();
    for (const name of ['.gitignore', '.klyroignore']) {
      try {
        const content = await fs.readFile(path.join(cwd, name), 'utf-8');
        for (const line of content.split('\n')) {
          const re = ignoreRuleToRegex(line);
          if (re) filter.rules.push(re);
        }
      } catch { /* missing/unreadable */ }
    }
    return filter;
  }
  
  /** Accepts a relative path (posix or windows) and returns true if it should be ignored. */
  ignores(relPath: string): boolean {
    const normalized = relPath.replace(/\\/g, '/');
    for (const re of this.rules) {
      if (re.test(normalized)) return true;
    }
    return false;
  }
}
