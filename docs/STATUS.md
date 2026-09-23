# Klyro — Current Status (authoritative)

> This file is the single current source of truth for implementation status.
> `README.md` is user-facing setup/usage. `review.md` is the point-in-time
> 1.0.9 audit (2026-09-19). `comparison.md`, `plan.md`, `PRD.md`,
> `HarnessFlow` notes, and `READ.md` are history/requirements — when they
> disagree with this file, this file wins.

- Version: 1.0.15 (`release: klyro 1.0.15 - external audit fixes P0-P3`, built
  on the Sept-20 tree hardening). Closes all 10 audit findings with
  regression tests: symlink-test arg order, update downgrade/injection via
  non-semver tags, web-fetch SSRF (metadata range + unspecified hosts),
  project-layer apiKey stripping + public-baseUrl warnings, failover flags
  + unified key sources, MCP stdio 8 MiB line cap, prototype-pollution
  guards (persist + audit), short-key redaction.
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
  web content stays `untrusted:true` data, never policy. `web_fetch` denies
  non-http(s) schemes, public plaintext HTTP, `KLYRO_WEB_DENYLIST`/
  `KLYRO_WEB_ALLOWLIST` misses, unspecified addresses (`0.0.0.0`, `::`, their
  IPv4-mapped forms) and cloud-metadata (`169.254.0.0/16`, including the
  `::ffff:` spelling) regardless of scheme.
- Known maintenance hotspots (not yet decomposed): large `src/index.ts`
  command registration; legacy `src/chat.ts`/`src/repl.ts` kept compat-only
  (`chat` marked deprecated in help — prefer `klyro tui`).
- Hooks: commands in project `.klyro/hooks.json` run only after explicit
  review — `klyro hooks trust` pins the file's sha256 in
  `~/.klyro/trusted-hooks.json` (any edit re-locks it), or set
  `KLYRO_TRUST_PROJECT_HOOKS=1`. A cloned repo can no longer execute commands
  just because someone ran `klyro` in it. Project hooks are repo-authored, so
  they are gated the strictest: user (`~/.klyro`) hook files run without trust.

---

## Plan level progress (code-audited)

> Audited against `plan.md`'s 100 sub-levels by reading the code, not by
> trusting narrative docs. `READ.md` §4 ("L10 NOT STARTED", v0.1.15 numbers)
> and `comparison.md` predate 1.0.0 and are **history**; this section wins.

**Highest fully-achieved level: 10 — PROFESSIONAL CODING HARNESS / KLYRO 1.0.**
Levels 1–9 are complete; Level 10 is complete except the SDK/IDE/installer
half of 10.4. Levels 11–15 exist only as partial scaffolding; 16–20 are
untouched.

| Level | Sub-levels | Status | Gaps (unimplemented sub-levels / bullets) |
|---|---:|---|---|
| 1 CLI Foundation | 5/5 | **complete** | — |
| 2 AI Chat Core | 5/5 | **complete** | — |
| 3 Tool Runtime | 5/5 | **complete** | — |
| 4 Repository Coding | 5/5 | **complete** | — |
| 5 Autonomous Loop + Eval | 5/5 | **complete** | — |
| 6 Verification + Repair | 5/5 | **complete** | — |
| 7 Codebase Intelligence | 4/5 | **complete** | 7.4 symbol index is regex `find_symbol` — no tree-sitter/SQLite index |
| 8 Context Engine | 5/5 | **complete** | — |
| 9 Sessions / Resume | 5/5 | **complete** | — |
| **10 Professional Harness** | 2/5 | **mostly complete (ceiling)** | 10.2 hooks cover 5 of 10 events (`cli/hooks.ts` = preToolUse/postToolUse/sessionStart/sessionEnd/stop; no UserPromptSubmit/PermissionRequest/Notification/SubagentStop/PreCompact), no skills; 10.4 no `@klyro/sdk`, no Python wrapper, no VS Code integration, installers = npm + Docker only, no managed/enterprise config layer; 10.5 no 30+ fixture parity matrix or statistical benchmark report |
| 11 Specialized Multi-Agent | 2/5 | **partial** | no `.klyro/runs/<id>/handoffs/`, no cross-report conflict detection, no agent-tree UI; child reports are typed but not Zod-validated-with-retry |
| 12 Parallel Engineering | 3/5 | **partial** | no DAG decomposition / `--plan-only`; no versioned shared artifacts, interface contracts, or resource locks |
| 13 Production Runtime | 2/5 | **partial** | no OpenTelemetry, no policy-as-code store, no Docker/Podman workspace isolation, no DNS/outbound logging or registry allowlists, no signed releases; sandbox tiers detect bwrap/llkr-landlock but enforce no CPU/memory/disk limits |
| 14 Long-Running Engineer | 0/5 | **mostly absent** | no daemon, no job queue (only in-session background shell jobs + `/jobs`), no hierarchical compression, no detach/reattach, no Notification hook. Checkpoints/undo, exactly-once tool replay and atomic persistence already exist |
| 15 Multi-Model | 1/5 | **partial** | provider failover chain only (`providers.failover`, L15 wiring in `run.ts`/`runtime.ts`); no model roles (`/model <role>`), no task classifier, no escalation/de-escalation, no router evaluation |
| 16 Dynamic Workflows | 0/5 | **not started** | no workflow templates/graph runtime/planner |
| 17 Self-Optimizing | 0/5 | **not started** | only JSONL traces + `klyro trace`; no trace warehouse, efficiency metrics, analyzers, or `optimize` command |
| 18 Experience / Learning | 0/5 | **not started** | no lesson extraction or experience store (§8.4 session memory is not this) |
| 19 Eval-Driven Improvement | 0/5 | **partial** | fixtures, per-commit `.klyro/baselines/*`, judge, `eval:compare` and gating CI smoke exist; no pass@k/confidence intervals, no flake protocol, no shadow runs |
| 20 Platform | 0/5 | **not started** | no server/team mode, integrations, or governance/restraint engine |

**Totals: ~54/100 sub-levels complete, ~17 partial, ~29 not started** (grading
is a judgement call on bullets; `plan.md` remains the spec of record).

### Reproducing this audit

```bash
npm ci && npx tsc --noEmit && npm test          # typecheck + 104 test files
node dist/index.js --help                        # 27 top-level commands
```

**Last verified:** 2026-09-20 at HEAD `4074719` (v1.0.14, working tree incl.
the uncommitted hardening pass) — `tsc --noEmit` clean; `vitest run`
**1082/1082 tests in 106/106 files** (~90s, `fileParallelism:false`); 27
top-level CLI commands, 112 slash commands, 34 built-in tools, 153 non-test
source files.

