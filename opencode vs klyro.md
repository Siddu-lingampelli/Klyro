m zz# OpenCode vs Klyro — Complete End-to-End Comparison

> Scope: everything — API, MCP, skills, commands, UI, TUI + components,
> terminal UI + scroll, agents, models, code/search/fetch/automations, MVP,
> providers, context, compaction, storage, code + wiring. Klyro facts are
> verified against this repo at v1.0.14 (TypeScript/Node ≥20, Ink/React TUI).
> OpenCode facts are verified against opencode.ai/docs (v2 docs live; v1
> behavior noted where it differs). Check dates on fast-moving details.

## 0. One-line verdict

| | OpenCode | Klyro 1.0.14 |
|---|---|---|
| What it is | Open-source terminal coding agent by SST/Anomaly — TUI + desktop app + IDE extensions + web + CLI, plugin/SDK ecosystem | Single-purpose autonomous coding-harness CLI — Commander CLI + Ink TUI, no desktop/IDE/web |
| Philosophy | Breadth: 75+ providers, MCP + OAuth, skills, themes, keybinds, share, SDK/server/plugins | Depth + determinism: policy gates, verification/repair loops, eval harness, atomic persistence, exactly-once tools |
| Best at | Everyday multi-model coding with rich customization | Auditable, policy-gated autonomous runs with reproducible evals |
| Biggest gap | Permissive defaults; MCP context bloat (docs admit it); mouse capture on by default breaks copy | Provider breadth (6 built-ins vs 75+); no skills/custom-tools/plugins/SDK; CLI+TUI only |

## 1. MVP (minimum viable product surface)

| | OpenCode | Klyro |
|---|---|---|
| Install | `curl …/install \| bash`, npm/bun/pnpm/yarn, brew, pacman, choco, scoop, mise, Docker, binaries, WSL-first on Windows | `npm i -g klyro` (npm canonical + `package-lock.json`), Docker (`npm ci` inside), runs natively on win32 |
| First run | `opencode` → `/connect` (paste key or browser OAuth) → `/init` writes `AGENTS.md` | `klyro login` (masked, 0600) → `klyro doctor` → `klyro init` writes `KLYRO.md` draft + `.mcp.json` skeleton, never overwrites |
| Core loop | Prompt → plan (Tab) → build → `/undo` → share | `klyro run "<task>"` one-shot, `klyro` TUI REPL, checkpoints + `undo`/`rewind`, session resume/merge/fork |
| Config files | `opencode.json`/`opencode.jsonc` (+ `tui.json` for UI) | `~/.klyro/settings.json` + `.klyro/settings.json` + `.klyro/settings.local.json` + env + flags (6 layers) |

## 2. API (programmatic surface)

| | OpenCode | Klyro |
|---|---|---|
| Public API | SDK (`/docs/sdk`), server mode (`/docs/server`), plugins (`/docs/plugins`), ACP support, ecosystem page | No SDK/server/plugin API. Only programmability: MCP **serve** (`klyro mcp serve` exposes built-ins over stdio, policy-gated, 8 MiB line cap), JSON/headless output (`-p/--print`, `--output-format text\|json\|stream-json`), stable `kind:result` envelope + exit-code contract |
| Headless | `opencode run [--auto] "…"` | `klyro run`, `klyro -p`, `--json`, `--bare` (skips MCP/hooks/memory/context/persistence — visibly different trust) |
| Exit codes | Not documented as a contract | Documented classes: config/provider/no-final/stopped/verify-fail/abort |

**Flaw → fix (Klyro):** no SDK/server/plugins/ACP. If programmatic embedding matters, add an HTTP serve mode mirroring `mcp serve` + the JSON envelope. (OpenCode leads here.)

## 3. Providers + models + LAN/local

| | OpenCode | Klyro |
|---|---|---|
| Count | 75+ via AI SDK + Models.dev (OpenAI, Anthropic, Bedrock, Vertex, Azure, Groq, Together, OpenRouter, xAI, DeepSeek, Ollama, LM Studio, llama.cpp, …) + fully custom providers (`npm` + `baseURL` + `models` map) | 6 built-ins (`src/providers/endpoints.ts`): openai, anthropic, ollama, lmstudio, vllm, llamacpp + `registerEndpoint()` for custom |
| Wire | Per-provider SDK adapters | 2 adapters only: OpenAI-compatible `/v1/chat/completions`, Anthropic `/v1/messages` (`provider-adapter.ts`, `anthropic-adapter.ts`) |
| Auth | `/connect` (paste, browser OAuth, device codes, Entra/AWS profiles), keys in `~/.local/share/opencode/auth.json`, MCP OAuth (RFC 7591 DCR) | `KLYRO_BASE_URL/API_KEY/MODEL/PROVIDER` + config file + OS keychain w/ 0600 fallback; no OAuth; MCP OAuth supported client-side |
| Model UX | `/models` picker, `provider/model-id` refs, blacklist/whitelist, per-model `limit` (context/output), `small_model`, reasoning variants, Zen/Go curated offerings | `KLYRO_MODEL`, `/model`, `model-info.ts` registry (pricing + context windows + cost accounting), per-agent model override, judge model for evals |
| LAN/local | Local-first docs (Ollama auto-config, llama.cpp, LM Studio, Atomic Chat); HTTPS-only with loopback exemption philosophy | Same shape: HTTPS-only + loopback/private-LAN exemption, shared `assertSafeBaseURL`, local probe list (600 ms), explicit `allowInsecure` opt-in |
| Failover | Not a documented primitive | L15 `providers.failover` chain: ordered fallbacks, keyless entries skipped, CLI flags flow into primary + chain (single source of truth) |

**Flaw → fix (Klyro):** provider breadth is the single biggest functional gap. Add a generic OpenAI-compatible custom-provider entry (baseURL + key env + model list) so the "75 vs 6" gap becomes "75 vs N + catch-all". (OpenCode leads by far.)

## 4. MCP (client, trust, serving)

| | OpenCode | Klyro |
|---|---|---|
| Client | Local (`command`, `cwd`, `environment`, timeout) + remote (`url`, `headers`, `oauth`) + org `.well-known` defaults; `opencode mcp auth/logout/list/debug` | stdio/SSE/HTTP (`mcp add/list/remove/probe/trust/prompts`), remote URL guard, 15 s probe timeout |
| Tools | Auto-available alongside built-ins; global + per-agent enable/disable with globs (`my-mcp*`) | Same registry/approval path as built-ins; scoped registries per worker; server text treated as untrusted data |
| Trust | Enable/disable flags; no hash-pinning documented | Hash-pinned trust (`sha256(spec)` per server name; config change ⇒ re-approval), trust store atomic writes, `mcp trust` command |
| Serve | Not a documented primitive (SDK/server instead) | `klyro mcp serve`: built-ins over stdio, policy-gated, schema-validated, bounded 8 MiB lines |
| Caveats | Docs admit MCP servers bloat context (GitHub MCP can blow limits) | Same risk class; mitigated by scoped registries + explicit trust, no automatic context budgeting |

**Flaw → fix (Klyro):** no MCP OAuth DCR flow and no org-default distribution; add per-server context budgeting. (Rough parity otherwise; Klyro leads on trust mechanics.)

## 5. Skills (dedicated system)

| | OpenCode | Klyro |
|---|---|---|
| System | **First-class skills**: `SKILL.md` + frontmatter (`name`, `description`, …), discovery across `.opencode/.claude/.agents/skills` (project walks to git worktree + global), on-demand `skill` tool, permission-gated per skill (`allow/ask/deny`, wildcards, per-agent override), disable-able | **No skills system.** Adjacent pieces exist: custom agents (`.klyro/agents/*.md`, lintable), custom slash commands (`.klyro/commands/` + fuzzy completion), hooks (pre/postToolUse, sessionStart/End, stop), MCP prompts (`/mcp__server__prompt`) |

**Flaw → fix (Klyro):** biggest extensibility gap after providers. Add `SKILL.md` discovery + a `skill` tool behind the existing policy engine (permission class + per-agent globs), reusing the agent-definition lint. (OpenCode leads.)

## 6. Commands (built-in + custom)

| | OpenCode built-ins | Klyro slash (~100 cases in `slash/parser.ts`) |
|---|---|---|
| Session | `/new`, `/sessions` (`/resume`, `/continue`), `/share`, `/unshare`, `/export`, `/compact` (`/summarize`), `/undo`, `/redo` | `/new`, `/sessions`, `/resume`, `/continue`, `/export`, `/compact`, `/rewind`, `/fork`, `/branch`, `/rename`, `/clear`, `/copy`, `/resume` pickers; checkpoint snapshots + `undo(n)` |
| Model/config | `/models`, `/connect`, `/init`, `/themes`, `/thinking`, `/details`, `/editor` | `/model(s)`, `/provider`, `/effort`, `/fast`, `/login`, `/logout`, `/auth`, `/init`, `/config`, `/settings`, `/doctor`, `/version`, `/whoami`, `/env`, `/deps` |
| Agent control | Tab agent switch, `@` subagent invoke, `!` bash prefix, `/editor`, image drag-drop | `/agents`, `/agent`, `/subagents`, `/subtask`, `/background`, `/tasks`, `/ps`, `/stop`, `/kill`, `/queue`, `/retry`, `/mode`, `/sandbox`, `/permissions`, `/approve`, `/deny`, `/vim`, `/keymap`, `/theme`, `/attach`, `/image`, `@` file completion, `!` via `/shell` |
| Code workflows | Via agents/prompts | `/review`, `/code-review`, `/security-review`, `/simplify`, `/test`, `/lint`, `/build`, `/run`, `/fix`, `/explain`, `/format`, `/ask`, `/commit`, `/push`, `/pull`, `/pr`, `/issue`, `/diff`, `/map`, `/tokens`, `/verify`, `/plan`, `/todos`, `/cost`, `/status`, `/context`, `/memory`, `/checkpoint`, `/details`, `/verify`, `/debug`, `/reload`, `/prompt`, `/alias`, `/commands`, `/mcp`, `/update`, `/changelog`, `/bug` |
| Custom | `.opencode/commands/*.md` or JSON: `template` (required), `description`, `agent`, `subtask`, `model`, `$ARGUMENTS`/`$1..`, `` !cmd `` shell injection, `@file` refs; can override built-ins | `.klyro/commands/*.md` + fuzzy completion; args via parser `rest` (no `$1` positional or `!cmd` injection documented) |

**Flaw → fix (Klyro):** custom commands lack argument placeholders (`$ARGUMENTS`/`$1`), shell-output injection, per-command agent/model/subtask binding, and `/undo`+`/redo` message+file restore as one gesture (Klyro has the pieces: checkpoints + rewind + transcript truncate). (OpenCode leads on command power; Klyro leads on raw command count.)

## 7. UI, TUI + components, terminal UI + scroll

| | OpenCode | Klyro |
|---|---|---|
| Surfaces | TUI + desktop app + IDE extensions + web UI + CLI | CLI + Ink TUI only |
| TUI config | `tui.json`: theme, keybinds (leader `ctrl+x`, merged), `scroll_speed`, `scroll_acceleration`, `diff_style`, cursor, `mouse` (**default true**), attention (sounds/notifications, off by default), command palette (`ctrl+p`) | No themes/keybinds config; fixed compiled keymap (`/keymap` shows it); `KLYRO_NO_ALT=1` escapes alt-screen |
| Components | Message list, diff view, tool-detail toggles, thinking blocks, session/child-session navigation (`session_child_*`), username toggle | `app`, `approval` (keyboard-safe dialogs), `diff` (+ dedicated parser), `markdown`, `transcript` (grouped tool activity), `status` (cost/context/model), `tokens`, `thinking-block`, `header`, `banner`, `activity-line`, `plan`, `state`; approvals/diffs/tests for each |
| Input | `@` fuzzy files (+ configured references), `!` bash prefix, image drag-drop, external `$EDITOR`, Tab agent switch, Plan/Build Tab toggle | `@` fuzzy files (+ mid-line mentions), `/` + `Tab` completion, Shift+Enter newline, vim insert/normal modes (`/vim`), `Ctrl+P/N` history (escape-free), `↑/↓` history-only, `Ctrl+C` cancel-or-quit, queued inputs (≤3), paste burst handling |
| Scroll | Scroll commands + speed/acceleration config, sticky bottom, mouse wheel (mouse capture **on** by default — same copy/paste trap Klyro just fixed) | Custom anchor viewport (`scroll-model.ts`): pinned/follow-tail, unread badge, jump-to-bottom, `PgUp/Dn`, `Ctrl+U/D/B/F`, `Shift/Ctrl+↑/↓` line scroll, wheel ±3 lines (tap), `KLYRO_MOUSE=1` opt-in so native selection works by default |
| Copy/paste | Mouse capture default-true breaks native selection (Shift+drag bypass documented) | Fixed in 1.0.12/1.0.14: reporting off by default; bracketed-paste bulk insert + newline normalization; terminal output sanitized (OSC/CSI/C0 stripped) |
| Themes | Built-in theme list + `/themes` | None (single compiled look) |

**Flaws → fixes:** Klyro needs themes/keybinds config and an external-editor flow; OpenCode should flip mouse default (copy breakage) and adopt per-hop URL validation + output sanitization thinking. (Klyro leads on scroll engineering + input robustness; OpenCode leads on surfaces + customization.)

## 8. Agents (primary, subagents, workers)

| | OpenCode | Klyro |
|---|---|---|
| Built-ins | Primaries: `build` (all tools), `plan` (edits+bash ask); subagents: `general` (full), `explore` (read-only), `scout` (external docs); hidden: `compaction`, `title`, `summary` | Runtime roles, not named agents: child workers (scoped registries), `KLYRO_WORKER=0` escape, task manager (`task-get/list/apply/stop/wait`), worktree manager, orchestrator |
| Custom | JSON or `.md` (global + project): description, temperature, steps, model, permissions (glob), hidden, color, top_p, task-permissions; `opencode agent create` wizard | `.klyro/agents/*.md`: metadata + prompt, lintable (`agents lint`), schema/policy-validated before registration |
| Invocation | Tab-switch primaries; `@mention` or auto-invoke subagents; child-session navigation | Custom agents run via `agents run`; workers inherit only intended scope; abort propagates (model + tools + workers + subprocess tree) |
| Guardrails | Permission ask/deny per agent; `task` permission globs; `doom_loop` (3× identical) recovery prompts | Budgets (steps/cost/time), stuck detection (identical ×3, same-file >8×) with synthetic redirect then abort, verification + ≤3 repairs, retry never re-executes completed tools (exactly-once map) |

**Flaw → fix (Klyro):** no named primary agents with Tab-switching and no read-only explore/scout equivalents — add both (cheap: permission presets over existing engine). (Parity on paper; OpenCode leads on built-in UX.)

## 9. Code / search / fetch / automations (tools)

| | OpenCode built-ins | Klyro 34 built-ins (`src/tools/`) |
|---|---|---|
| Filesystem | read, edit/write/patch, glob, grep, list, lsp | `read_file`, `write_file`, `edit_file`, `multi_edit`, `apply_patch` (+ approval edit-retry), `list_dir`, `read-history` |
| Search/code intel | grep/glob + LSP servers config + references | `glob`, `grep`, `search-files`, `dependencies`, `imports`, `import-graph`, `repo-map`, `recent-files`, `find-symbol`, LSP diagnostics |
| Shell/git | bash, background; git via bash | `shell_exec` (argv, no `shell:true`, cwd-pinned, kill tree, bounded output, secret-scrubbed), `background`, `sandbox`, `git-{status,diff,log}`, `commit` (verified hooks, protected-branch escape), checkpoints |
| Planning | `task` (subagents), `todo` (read/write), plan agent | `task-{get,list,apply,stop,wait}`, `todo-write`, `ask-user` (headless `question` equivalent), plan permission mode |
| Web | `webfetch`, `websearch` | `web_fetch` (per-hop redirect revalidation, allow/deny lists, 2 MiB cap, `untrusted:true`), `web_search` (docs/explorer allowlists) |
| AI ops | `skill` (load SKILL.md), `question` (user prompt) | `spawn-agent`, `run_verify`, verification registry/parsers/baseline/scoped/auto + repair loop |
| Custom tools | Documented custom-tools page | None — gap |

**Flaw → fix (Klyro):** no custom-tool definitions; add config-defined tools behind registry+policy. (Klyro leads on verification/repair + git safety; OpenCode leads on skills/custom tools.)

## 10. Providers / models / context / compaction / storage (runtime resources)

| | OpenCode | Klyro |
|---|---|---|
| Context assembly | `@` refs, `AGENTS.md`, rules/, references/, MCP tools (bloat admitted) | L6 project map + L7 telemetry + accounting; `KLYRO.md` (+`.local`, `CLAUDE.md`, `AGENTS.md`, `.cursorrules` compat); import graphs; repo maps; trust-classified assembly |
| Compaction | Hidden `compaction` agent, auto when needed | `compaction.ts` + selector; bounded history (40 turns/80k chars); pair-preserving trim; TUI cross-turn session memory (1.0.9) |
| Compaction UX | `/compact` (`/summarize`) manual trigger | `/compact [focus]`, `/clear`, `/new`, `/branch` |
| Sessions/storage | Sessions list/switch/share; `~/.local/share/opencode/auth.json`, `mcp-auth.json`; share links (cloud) | JSON sessions (`KLYRO_SESSIONS_DIR` relocatable) + per-project index + locks, hash-chained audit, traces/events, checkpoint snapshots (0600/0700, fsync, atomic rename), `session list/resume/merge/import/export/fork/delete`; no cloud |
| Undo model | `/undo`+`/redo` via Git (repo required) | Checkpoint `undo(n)` + `rewind` + transcript truncate — works without git |
| Cost control | `steps` cap per agent; Zen/Go pricing | Per-run budgets (maxSteps/cost/time), model-aware rates, cost line in status bar |
| Injection stance | Rules/trust not prominent in docs | Context trust module; project instructions = data (never override policy); injection fixtures in tests |

**Flaws → fixes:** Klyro needs MCP context budgeting + a manual `/summarize`-style compact trigger UX polish (has `/compact`; discoverability); OpenCode needs least-privilege MCP scoping + offline story. (Klyro leads on persistence integrity + undo-without-git; OpenCode leads on share/collaboration.)

## 11. Policies / permissions / network / enterprise

| | OpenCode | Klyro |
|---|---|---|
| Model | `allow/ask/deny` × tool keys + granular `{pattern: action}` objects, wildcards, `~` expansion, `external_directory`, `doom_loop`, `.env` deny-by-default, per-agent merge, `--auto` mode, ask outcomes (once/always/reject) | Modes `default/accept-edits/plan/auto` + glob rules (deny→allow→ask) + builtin shell-deny (exfil, pipe-to-shell, `.env` writes, protected pushes) + privileged-class default ask/deny + approval bound to exact op |
| Secrets | Auth files; no documented output redaction | `secret-redactor.ts` (AWS/GH/Slack/Bearer/JWT/SK/short-keys) on every persist/render boundary + streaming redactor |
| Config trust | Org `.well-known` remote defaults (opt-in) | 6-layer merge with project-layer key stripping + public-baseUrl warnings (added post-audit) |
| Enterprise/network | Enterprise + network docs sections | None (no SSO/proxy story beyond env passthrough in Docker) |

**Flaw → fix (Klyro):** enterprise SSO/proxy story missing; consider org-default distribution like `.well-known`. (Klyro leads on redaction + config-trust mechanics; OpenCode leads on enterprise surface.)

## 12. Quality gates: tests / evals / release

| | OpenCode | Klyro 1.0.14 |
|---|---|---|
| Tests | Repo has tests (unverified here) | 104 files / 1059 tests, incl. adversarial policy matrix, injection fixtures, atomicity/crash, migration, contract tests |
| Evals | None documented | Fixture eval harness + judge models + smoke suite gating CI + `release-check` (version/help/smoke/JSON-envelope/CLI-verbs) |
| Release | Standard | Gating CI (npm canonical), provenance publish, `docs/STATUS.md` single source of truth |
| Known process debt | — | Flaky `import-graph` freshness test vs publish gate; `evals/results/*.json` artifacts un-ignored |

## 13. Prioritized fix list (both directions)

**Klyro should borrow (highest value first):**
1. Generic custom-provider entry (kill the 75-vs-6 gap for OpenAI-compatible endpoints).
2. `SKILL.md` system + `skill` tool behind policy.
3. Named primary agents (`build`/`plan` Tab-switch) + read-only `explore` preset.
4. Custom commands v2: `$ARGUMENTS`/`$1`, `` !cmd `` injection, per-command agent/model/subtask, `/undo`+`/redo` as one gesture.
5. Custom tools + themes/keybinds config + external `$EDITOR` flow.
6. SDK/serve-HTTP + share links + org defaults + SSO/proxy story.
7. `gitignore` for `evals/results/`; deflake the freshness test.

**OpenCode should borrow:**
1. Verification/repair loop primitive + eval harness with judge.
2. Secret redaction on all output boundaries.
3. Hash-pinned MCP trust + per-hop URL revalidation + atomic persistence.
4. Exactly-once tool execution across retries/resumes.
5. Undo-without-git (snapshot model).
6. Mouse-capture default-off (copy/paste) + terminal sanitization.
7. Native Windows support instead of WSL-first.

## 14. File/config map (wiring cheat-sheet)

| Concern | OpenCode | Klyro |
|---|---|---|
| User config | `~/.config/opencode/opencode.json(c)` | `~/.klyro/settings.json` |
| Project config | `.opencode/` + `opencode.json`, `AGENTS.md` | `.klyro/` + `KLYRO.md`, `.mcp.json`, hooks, agents, commands |
| Auth storage | `~/.local/share/opencode/auth.json`, `mcp-auth.json` | OS keychain + 0600 file, `~/.klyro/` |
| UI config | `tui.json` | (none — compiled keymap) |
| Sessions | internal + share cloud | `KLYRO_SESSIONS_DIR/*.json` + per-project index + locks + `.jsonl` audit |
| Checkpoints | Git-based undo | `.klyro/checkpoints/<id>/` + `.meta.json` + diffs |
| Custom agents | `agent:{}` / `agents/*.md` | `.klyro/agents/*.md` |
| Custom commands | `command:{}` / `commands/*.md` | `.klyro/commands/*.md` |
| Skills | `skills/*/SKILL.md` | — (gap) |
| Hooks | plugins | `.klyro/hooks.json` (trusted via `hooks trust`) |
| MCP | `mcp:{}` | `.mcp.json` + `~/.klyro/mcp-trust.json` |

*End of comparison. Klyro side verified at `2b183f9` (v1.0.14); OpenCode side per opencode.ai/docs fetched 2026-09-23 — recheck fast-moving pages before acting.*
