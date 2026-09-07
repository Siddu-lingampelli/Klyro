/**
 * Approval patterns — the unit of "always allow this pattern".
 *
 * A pattern uses the same `tool(glob)` grammar the policy engine matches
 * (`matchesGlobRule` in engine.ts), e.g. `shell_exec(npm *)`,
 * `write_file(src/index.ts)`. Derivation is deterministic: the same call
 * shape always yields the same pattern, so session caching can key on exact
 * pattern equality and persisted patterns re-match across sessions.
 *
 * Scoping (Claude-Code-like):
 *   - shell_exec / run_verify → first command word + ` *`
 *     (`npm test` and `npm run build` share `shell_exec(npm *)`)
 *   - file tools with a path → the exact path (safest: no wildcards)
 *   - everything else → the bare tool name (whole-tool session allow)
 */
export function patternForCall(name: string, input: Record<string, unknown>): string {
  if ((name === 'shell_exec' || name === 'run_verify') && typeof input.command === 'string') {
    const first = input.command.trim().split(/\s+/, 1)[0] ?? '';
    if (first) return `${name}(${first} *)`;
  }
  if (typeof input.path === 'string' && input.path.length > 0) {
    return `${name}(${input.path})`;
  }
  return name;
}
