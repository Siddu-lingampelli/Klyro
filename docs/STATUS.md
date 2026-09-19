# Klyro — Current Status (authoritative)

> This file is the single current source of truth for implementation status.
> `README.md` is user-facing setup/usage. `review.md` is the point-in-time
> 1.0.9 audit (2026-09-19). `comparison.md`, `plan.md`, `PRD.md`,
> `HarnessFlow` notes, and `READ.md` are history/requirements — when they
> disagree with this file, this file wins.

- Version: 1.0.14 (`release: klyro 1.0.14 - escape-free history keys`). 1.0.13
  split ↑ between scrolling (while reading) and recall (at live tail); 1.0.14
  adds Ctrl+P / Ctrl+N aliases for history prev/next that need no escape
  sequences, so recall works even where terminals mangle arrow keys.
- Canonical package manager: **npm + `package-lock.json`** (matches CI,
  Dockerfile, publish). `pnpm-workspace.yaml` is legacy for the unused
  private `packages/shared` workspace and is ignored by npm.
- CI gate: `npm ci` → `typecheck` → `test` → `build` → `--version`/`--help`
  → **gating** `eval --suite smoke` → `node scripts/release-check.mjs` →
  `npm pack --dry-run`. No `|| echo` fallback — smoke failure fails CI.
- Release check: `npm run release:check` verifies semver `--version`,
  `--help`, fixture-backed smoke (no provider), and the `kind:eval_summary`
  JSON envelope.
- Persistence: session index + per-session JSON use tmp+fsync+rename;
  MCP trust uses atomic save; checkpoint `.meta.json`/diffs use atomic
  writes. Session import validates shape (role whitelist, 5000/2000 caps,
  bounded config).
- Terminal output: human-mode renderer sanitizes OSC/CSI/C0-C1 controls;
  web content stays `untrusted:true` data, never policy.
- Known maintenance hotspots (not yet decomposed): large `src/index.ts`
  command registration; legacy `src/chat.ts`/`src/repl.ts` kept compat-only
  (`chat` marked deprecated in help — prefer `klyro tui`).
