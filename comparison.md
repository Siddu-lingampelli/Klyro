# Klyro vs Claude Code — Full End-to-End Comparison (Every Feature, Every Action)

*Generated: 2026-09-12 · HEAD `D935d93 (release: klyro 1.0.2)` · Test state: 832 passed / 3 timing flakes · `tsc` exit 0 · prior audit → `comparison.md.bak`*

## Marks
- **[V]** = Verified-Code-Klyro — grounded in `file:line` re-read for this audit.
- **[A]** = Verified-Absent — feature truly absent; search path given.
- **[G]** = Grounded-Behavior-CC — observable from CC docs / terminal / release notes.
- **[I]** = Inferred-Design-CC — defensible inference, not stated.

---

# PART 0 — Surface Inventory (what each thing actually is)

## A. CLI surface — every subcommand & flag

Program entry: `src/index.ts` (commander). Global opts: `--cwd`, `--config`, `--debug`, `--json`, `--yes`, `--tui`, `--chat`, `-p` [V, src/index.ts:24-126]. Usage errors → exit 2 (index.ts:79). Top-level `--tui`/`--chat` are a single option with auto-negation to avoid CommanderError (index.ts:118-126).

| Subcommand | Flags | File:line |
|---|---|---|
| `tui` | `-m/--model`, `--max-steps` | index.ts:130-136 |
| `completion <shell>` | — | index.ts:140-144 |
| `update` | — | index.ts:148-152 |
| `login` | — | index.ts:156-160 |
| `logout [provider]` | — | index.ts:164-168 |
| `config [cmd] [key] [val]` | get/set/list/delete; raw-argv value capture | index.ts:173-195 |
| `doctor` | `--json` | index.ts:198-203 |
| `run <prompt>` | `--model`, `--system`, `--timeout`, `--max-steps`, `--require-verify`, `--no-cve-...`, `--verify` | index.ts:280-350 |
| `chat [prompt]` | legacy REPL / one-shot | index.ts:358-391 |
| `eval [input]` | `--output human\|json\|silent`, `--suite`, `--filter`, `--runs`, `--parallel`, `--model` | index.ts:372-404 |
| `eval:compare <a> <b>` | — | index.ts:395-404 |
| `session list/show/resume` | `--status`, `--json`, `--resume X`, `--continue`, `--fork`, `--branch` | index.ts:408-538 |
| `scan` / `project` | `--json` | index.ts:541-542 |
| `sessions export/import/fork/delete` | — | index.ts:549-578 |
| `mcp list/add/probe/serve` | 15s probe timeout | index.ts:580-625 |
| `hooks [cmd]` | `hooks list` | index.ts:628-631 |
| `agents [name] [extra]` | `agents run <name> <task>` | index.ts:641-670 |
| `commit` | — | index.ts:688-703 |
| `audit [session]` | verify hash chain | index.ts:705-723 |
| `benchmark` | — | index.ts:727-729 |

Exit-code taxonomy: exit 2 usage, run-semantic codes via `KlyroError.EXIT_CODE` [V, shared/errors.ts:19-31] (config 3, auth/timeout/rate-limit 4, tool-denied 2, verify-fail 8); Ctrl+C twice forces `exit(130)` in run [V, cli/run.ts:290-296].

## B. REPL slash commands

**Handled** (switch in `repl.ts`): quit, clear, help, config, doctor, version, cost, thinking, memory, jobs, status, diff, undo, rewind, verify, project, context, compact, model, provider, effort, login, logout, init, plan, todos, new, models, fast, permissions, mode, sandbox, approve, deny, resume, sessions, rename, fork, branch, export, copy, auth, update, cancel, shell, mention, tools, settings, review, code-review, security-review, simplify, test, lint, build, run, fix, explain, format, ask, redo, checkpoint, accept, reject, details, verbose, raw, activity, tasks/ps, stop/kill, queue, retry, mcp, agents, agent, subagents, subtask, background, add-dir, cd, attach, drop, files, image, paste, ls, tree, search, web, read, map, tokens, commit, push, pull, pr, issue, editor, keymap/vim/theme/statusline/output-style, debug, whoami, reload, reset, bug, changelog, promptcmd, alias, commands, env, deps, install, prompt [V, repl.ts:945-2494].

**Autocomplete suggestions** (`COMMAND_DEFS`, suggests 6 prefix-matches): parser.ts:350-422. /model /provider /mode /sandbox /fast /permissions /approve /deny are policy/repl controls.

**CC side** — CC's `/help` exposes: /model, /init, /compact, /clear, /config, /doctor, /status, /debug, /output-style, /add-dir, /memory, /hooks, /permissions, /mcp, /install-github-app, /price, /review, /simplify, /login, /logout, /resume, /completion, /keybindings, /terminal-setup, /vim, /agents, /rename-session, /rewind, /fork-session, /context, /bug, /pr-comments, /cost, /todos, /plan, /xcode, /vscode [G]. Klyro covers most of this 1:1 plus `run/eval/session/audit/mcp/commit/agents run`.

## C. Tool catalog — every tool, schema, risk

Registry: `builtinRegistry()` registers 26 tools (registry.ts:98-133). All tools use `defineTool` with zod `inputSchema`, `execute()`, and go through `safe()`/`toToolError()` (normalize.ts:32-119). Risk classes: read (auto-allow), write (path-gated), execute (command+approval), spawn (sub-agent), prompt (user).

| Tool | Input schema | Risk | Notes |
|---|---|---|---|
| `read_file` | path, startLine?, endLine?, maxBytes?(≤16MiB) [V, read-file.ts:24-32] | read | default 1MiB cap; unchanged-detect + result store |
| `write_file` | path, content | write | |
| `edit_file` | path, old?, new?, ... | write | |
| `multi_edit` | path, edits[] (atomic rollback) [V, multi-edit.ts:47-60] | write | |
| `apply_patch` | patch | write | |
| `list_directory` | path, showHidden? [V, list-dir.ts:16-36] | read | skips node_modules/.git/build |
| `glob` | pattern | read | |
| `grep` | pattern, path? | read | |
| `search_files` | query | read | |
| `recent_files` | (none) | read | |
| `dependencies` | (none) | read | |
| `shell_exec` | command, cwd?, timeoutMs?(≤600s), env? [V, shell-exec.ts:20-27] | **execute** | PROTECTED_BRANCHES `main/master/production` + push-regex guard [V, shell-exec.ts:62-63,81-82] |
| `git_status` / `git_diff` / `git_log` | (none) | read | |
| `run_verify` | command | **execute** | |
| `todo_write` | todos | write | |
| `ask_user` | question | **prompt** | |
| `repo_map` | (none) | read | |
| `imports_of` / `importers_of` | path | read | |
| `find_symbol` | query | read | |
| `lsp_diagnostics` / `lsp_goto_definition` | path | read | |
| `expand_result` | id | read | pulls stored large result |
| `memory_write` | key,value | write | |
| `spawn_agent` | prompt, model?, timeoutMs?, readonly?, canSpawn? | **spawn** | capabilities resolved via `resolveCapabilities` (capabilities.ts:4-15) |
| `task_list/get/wait/stop/apply` | taskId,... | control | |

**CC tools** — Read, Write, Edit, MultiEdit, Glob, Grep, BashOutput, RepoMap (beta), TodoWrite, Fetch/WebFetch, WebSearch, NotebookEdit, Task (spawn), plus MCP + model/file-defined [G]. **Gap:** Klyro has no Fetch/WebSearch/NotebookEdit [A]. Shared: MCP client, agent-spawn.

## D. Events — every typed event

Closed union `KlyroEvent` (40 members) [V, events/catalog.ts:15-48]: session.start/end, turn.start/end, stream.delta, stream.thinking, tool.call, tool.result, permission.ask, permission.decision, policy.decision, file.changed, phase.changed, verification.started/succeeded/failed, repair.started, checkpoint.saved, usage, error, abort, subtask.started/progress/completed/failed/cancelled/timed_out/tool_call/tool_result/merged, provider.retry, context.trust_prompt, context.compacted. Emitted on a sync in-memory bus with retained history (bus.ts:10-33). **CC** has no public typed union; writes session JSONL [G].

---

# PART 1 — Every Stage of the End-to-End Run

## Stage 1 — Boot & first run
**Klyro [V]:** `.env` auto-load, no-clobber (dotenv.ts:38-54); provider resolution `env → config → local-probe → error` (providers.ts:8-13, LOCAL_ENDPOINTS):24); Level-6 context built per-block fault-tolerant (level6.ts:130-147); KLYRO.md/AGENTS.md/.cursorrules hierarchy loaded + capped + **trust-gated** (klyro-md.ts:27-84, trust.ts:90-136); update check 24h-cached + SRI-sha512-verified but manual (update.ts:16-28,101-118).
**CC [G]:** CLAUDE.md hierarchy merged; auto-update; model auto-detected; `.env`/`.*rc` secrets scrubbed from context.

## Stage 2 — Prompt assembly
**Klyro [V]:** ordered assembly identity→tools→env→summary→messages→reminders (assembly.ts:16-31); Level-6 static repo snapshot (capped ~12KB, level6.ts:39) + Level-7 **live runtime telemetry suffix** capped ~1.2KB, cache-safe (level7.ts:17-23,56-57; provider-adapter.ts:42-47). Project-map caps (deps 25, languages 3, source-dirs 8, config 12) [V, project-map.ts:33-38].
**CC [G]:** CLAUDE.md + memory + skills; auto-compact banner. Klyro's structured Level-7 self-telemetry is more explicit.

## Stage 3 — Provider call & streaming
**Klyro [V]:** `httpChatAdapter` (OpenAI-compat) + `anthropicAdapter`; both yield a unified `StreamEvent` (provider-adapter.ts:18-31); retry wrapper honors `retryable`/`retryAfterMs` with exp backoff (retry.ts:4-19,180-226); **stream budget max 4 concurrent, collapsing to 1 after recent 429** (stream-budget.ts:15-22); timeout abort (provider-adapter.ts:261); **provider failover chain** bounded (runtime.ts:365-368,595-611).
**CC [G/I]:** single provider, raw Anthropic SSE; retries on 429/503; no multi-provider failover [I]. Klyro's typed `retryable` flag + failover chain is the divergence.

## Stage 4 — Tool validation & policy gate
**Klyro [V]:** schema validation pre-pass answers malformed calls with `INVALID_TOOL_INPUT` without executing (runtime.ts:562-584); `evaluatePolicy` returns allow/ask/deny (engine.ts:12-15); precedence **deny→allow→ask** (engine.ts:185-186); layered path→command→secret checks; non-TTY default **deny** (approval.ts:2-7); approval choices allow/deny/always/**always-persist** (approval.ts:13-20,118-133); buggy-rule isolation via `safe()` (engine.ts:489-497); MCP deny-by-default allowlist (mcp/policy.ts:19-28).
**CC [G]:** permission tree; read auto-allowed, write path-aware, Bash dangerous-pattern flags; yes/no/always persisted. Same shape; Klyro's headless-deny + `always-persist` split + buggy-rule isolation are sharper.

## Stage 5 — Execute & record
**Klyro [V]:** order-preserving parallel for concurrency-safe tools, `MAX_PARALLEL_TOOLS=8` (runtime.ts:261-262,966-972,1180-1192); `EXEC_CRASH` on throw (runtime.ts:924-935); **secret redaction of outputs** (runtime.ts:1097; secret-redactor.ts:14-68); pre/postToolUse hooks best-effort (runtime.ts:1049-1162); checkpoints + `expand_result` staging (lifecycle.ts:11-18); bus events.
**CC [G]:** parallel; redaction; hooks on events. Same.

## Stage 6 — Verification & self-repair (deepest difference)
**Klyro [V]:** auto-detect verify cmd (auto.ts:10-34); sanity pre-checks fail-fast (runtime.ts:679-690); failure classify env-vs-code, introduced-vs-preexisting (verification/classify.ts:28-60); **bounded repair loop `maxRepairs`** (runtime.ts:781-819); **`guardRepair` refuses assert/skip edits** (classify.ts:129-142); baseline blame; `repairTokens` separate accounting (runtime.ts:288-296).
**CC [G/I]:** runs configured test/verify at end; **hands the loop back to the user**; no bounded self-repair/baseline-classify/anti-test-faking.

## Stage 7 — Sub-agents
**Klyro [V]:** `spawn_agent` → `resolveCapabilities` → scoped registry (scoped-registry.ts:15-33); worktree isolation for write-capable children (worktree-manager.ts:1-200; orchestrator); child-worker **separate OS process** for headless (child-worker.ts), in-process for TUI; depth guard, concurrency budgets, cwd containment `resolveAndFollowSymlinks` (orchestrator.ts:350-399,405-463); task abort-tree (task-manager.ts:88-286); crash contained → `CHILD_CRASH`.
**CC [G]:** Task tool; subagents; process isolation. Klyro's worktree-per-child + crash containment is more rigorous.

## Stage 8 — Context budget & compaction
**Klyro [V]:** accounting cap 120k, reserve 16k, `compactAt` 0.8, toolResultMax 2000 (accounting.ts:18-22); compaction elide → summarize-oldest-60% → keep-N (compaction.ts:14-47); **summary must mention every checkpointed file** else retry/fallback (compaction.ts:18-44); **reactive overflow compact-and-retry once** on `REQUEST_TOO_LARGE` (runtime.ts:497-520).
**CC [G]:** auto-compact at threshold; proactive only. Klyro's checkpoint-aware summaries + reactive overflow-rescue are the edge.

## Stage 9 — Persistence, checkpoint, resume
**Klyro [V]:** JSON-per-session + `sessions.json` index (store.ts:1-11); cross-process pid lock (store.ts:392-419); statuses open/complete/verify_failed/aborted/max_steps/stuck (store.ts:19); full-tree **checkpoint** + undo/rewind (checkpoints/store.ts:160-187); prefix-id resolution like git (session.ts:36-55); `/resume`.
**CC [G]:** JSONL transcripts per project; `--resume`/`--continue`. Klyro adds full-tree rewind + lock.

## Stage 10 — Audit & observability
**Klyro [V]:** hash-chained JSONL audit log (audit.ts:7-9); `verifyAuditChain` recomputes chain (audit.ts:110-139); `klyro trace --stats/--json` (trace.ts:41-62); sync bus history replay (bus.ts:26-32).
**CC [G]:** JSONL transcripts; no tamper-evident hash chain.

## Stage 11 — Human output
**Klyro [V]:** `TerminalRenderer` sole stdout for human + `renderMarkdown` plain text (renderers/terminal.ts:11-44); JSON renderer; Ink TUI; **no syntax highlighting, no clickable `file:line`** [A]; no rebindable keymap [A].
**CC [G]:** editor-grade ANSI markdown, highlighting, clickable links, themes, rebindable keymap, web tools. **This is CC's strongest lead.**

---

# PART 2 — Risk Register (end-to-end, with file:line)

| # | Risk | Sev | Evidence | Fix |
|---|---|---|---|---|
| R1/G1 | No OS sandbox — path-guard process-space only | HIGH | path-guard.ts:44-164 | landlock/bwrap strict mode |
| R2/G2 | TUI sub-agents in-process | HIGH | child-worker.ts + orchestrator | task-handle IPC |
| R3 | `chars/4` token heuristic | Med | tokenizer.ts:35-60 | provider usage |
| R4 | Plain rendering, no links/highlight | Med | renderers/terminal.ts | unified renderer |
| R5 | Sync bus unbounded history | Med | bus.ts:12-28 | bound/drain |
| F1-F3 | 3 TUI timing-flake tests | Low | app.test.tsx, approval.test.tsx | settle/fake-timers |

**Known flakes:** `app.test.tsx` ×2 (scroll timing), `approval.test.tsx` ×1 (keypress) — timing, not logic.

---

# PART 3 — Capstone

**Load-bearing dims (in order):** self-repair verification → core turn+validation prepass → provider failover+typed streaming → layered policy → session/checkpoint durability → context budget+reactive compaction → typed events/audit → tool catalog w/ risk → secret redaction → path-guard.

**4 deepest asymmetries:** (1) self-repair loop vs user-in-the-loop; (2) reaching-for-the-OS vs not; (3) typed-inspectable internals vs proprietary client; (4) plain rendering vs editor-grade.

**Highest-leverage moves for Klyro:** `--sandbox` strict mode; thread task-handle to children; wire provider usage into accounting; unified highlighted renderer; bound event-bus history; `/doctor` export; provider-key signature on update.

**For CC (inverted):** schema validation pre-pass; reactive overflow-retry; closed typed event union + audit chain; headless deny-by-default policy; baseline-aware self-repair; cross-provider failover; prompt-injection trust gate over changed files.

**Closing line:** Klyro is a verification-centric, provider-plural, typed-and-inspectable re-imagining of CC — unambiguous wins on self-repair, error structure, failover, active compaction, and tamper-evident audit; unambiguous losses at the two boundaries CC owns: reaching the OS (sandbox, process isolation) and presenting to the human (highlighting, links, web tools, rebindable keymap).