# Klyro vs Claude Code — Full Architectural Audit (36 rounds)

*Project: Klyro (`A:\claude code\Agent`) · HEAD `b28b98f` (release 1.0.5) · `tsc` exit 0 · tests 85 files / 889 passed · `doctor` all green · npm `latest = 1.0.5`. Rounds 1–18 delivered in a prior audit turn and reproduced here; rounds 19–36 are new. No files were modified to produce this audit.*

## Evidence marks

- **[Verified-Code-Klyro]** — a claim about the local codebase backed by an exact `file:line` reference read during the audit. Never fabricated; if a file was not found the claim is marked `[Verified-Absent]` with the searched paths instead.
- **[Grounded-Behavior-CC]** — a claim about Claude Code grounded in CC's documented behavior (code.claude.com / docs.anthropic.com), observable terminal output, or release notes.
- **[Inferred-Design-CC]** — a design inference about Claude Code that is defensible but not directly stated in public docs.

---

# PHASE 0 — RECONNAISSANCE

**Project:** `klyro` 1.0.5 (`package.json:2-11`), bins `klyro`/`ky` → `dist/index.js`, entry `src/index.ts:1` (commander program). HEAD `b28b98f`, tree clean.

**Build/test:** `tsc --noEmit` exit 0 · `npm run build` exit 0 · `npm test` 85 files / 889 passed · `doctor` all green (32 tools) · `--version` 1.0.5.

**Tree depth 2:** `src/{agent(25),checkpoints(2),cli(28),context(24),eval(3),events(2),mcp(12),persistence(5),policy(8),providers(1),renderers(2),shared(3+tests),tools(58),trace(2),tui(22),verification(10)}` + root (`chat.ts`, `repl.ts`, `providers.ts`, `util.ts`, `version.ts`); `packages/shared/` (private); `evals/` (23 fixtures), `scripts/`, `prompts/`; root design docs (`design.md`, `scroll.md`, `TUI_DESIGN.md`); `plan.md`/`PRD.md` gitignored.

**Tools (32, `src/tools/registry.ts:98-132`):** `read_file write_file edit_file multi_edit apply_patch list_directory glob grep search_files recent_files dependencies imports_of importers_of find_symbol lsp_diagnostics lsp_goto_definition shell_exec git_status git_diff git_log run_verify todo_write ask_user repo_map expand_result memory_write spawn_agent task_list task_get task_wait task_stop task_apply` (+ dynamic `mcp__srv__tool`).

**Slash (~100, `src/cli/slash/parser.ts:139-149,425-458`):** help/clear/new/exit/compact/resume/sessions/fork/export/copy/model/provider/init/status/context/diff/plan/todos/memory/permissions/mode/sandbox/approve/deny/login/logout/cost/thinking/jobs/verify/commit/mcp/agents/background/add-dir/attach/files/search/web/read/map/tokens/review/test/lint/build/run/fix/explain + `!cmd`/`@path`; fuzzy top-6 + Tab.

**Loop:** `run()` (`src/agent/runtime.ts:449`, `outer: while steps<maxSteps`, default 30 at `:226`); dual adapters (OpenAI `/chat/completions` + Anthropic `/v1/messages`) normalized to one `StreamEvent`; retry 5× exp-backoff.

**Policy:** verdicts `allow|ask|deny` (`policy/engine.ts:12-15`); deny→allow→ask precedence; `execute`/`admin` fall through to ask/deny without explicit allow (1.0.5); modes `auto/plan/accept-edits`; centralized `.env` gate; ask-once session+persisted via `TuiApprovalBridge`.

**Terminal state machine:** `status: idle|running` + approval-modal capture + `queuedInputs≤3` (`tui/app.tsx`); double-Esc cancel; Ctrl+C armed-cancel; vim insert/normal modes; bracketed-paste bulk insert.

**Prior artifacts:** `comparison.md.bak` (111KB, pre-1.0.3 full comparison — preserved, not overwritten); `plan.md`/`PRD.md` gitignored internal docs.

---

# PHASE 1 — DIMENSION ROUNDS

## Round 1 — The core turn

**Contract:** who owns model→tool_use→tool_result→repeat, parsing/validation, step budget, parallelism, stop states.

**Verified local:** `run()` owns the loop, `outer: while (steps < maxSteps)` (`runtime.ts:449`), default 30 (`:226`). Deltas assemble into `pendingToolCalls` (`:517,536-542`); post-stream JSON+Zod validation, malformed→structured `MALFORMED_TOOL_CALL` without execution (`:659-698,1299-1364`). Results commit as `tool` messages (`:1101-1106`) + checkpoint (`:414-435`). Parallelism: `MAX_PARALLEL_TOOLS=8` (`:261`), all-`concurrencySafe` gate then `Promise.allSettled` chunks, ordered commit (`:972,1184-1212`). Terminal states `complete|max_steps|aborted|no_final|verify_failed|limit|blocked|stuck` (`:210`). Messages are `role+ContentBlock` (`message.ts:10-41`). (`ObservationStore` deleted in 1.0.5 as dead code.) All [Verified-Code-Klyro].

**CC side:** harness-owned loop over native Anthropic `tool_use`→`tool_result` with system-reminder injection; parallel calls with per-tool permission gating [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Loop owner | `run()`, provider-agnostic events | Harness over Anthropic API |
| Invalid calls | Structured error result, continues | Error result + retry prompt |
| Parallel | Declarative safe-flag, chunk 8, ordered | Parallel + per-tool permissions |
| Stop | 8-state taxonomy | Turn limit + interrupt + denial |

**Divergences:** (1) validation-before-policy gate; (2) explicit `isConcurrencySafe` contract; (3) richer terminal taxonomy; (4) denials persisted as paired `tool` messages. **Takeaway:** defensive, auditable turn; wash on shape, Klyro emphasizes validation over fluidity. Next: Round 2.

## Round 2 — Provider streaming

**Contract:** SSE framing, normalized events, usage, timeouts, retry/failover classes.

**Verified local:** one `StreamEvent` union incl. `error(code,retryable,retryAfterMs)` (`provider-adapter.ts:18-31`). OpenAI `stream:true` + `[DONE]` terminal (`:241-250,349-358`); fragments keyed by `index`, incomplete surfaced not dropped (`:312,390-409`). Anthropic `/v1/messages`, top-level `system` + cache breakpoint (`anthropic-adapter.ts:128-177`), usage folds `input/output/cache_*` (`:336-351`). Retryable: `NETWORK/STREAM/5xx/429`; never `REQUEST_TOO_LARGE` (`:279,292-301,424`). Retry 5×, 500ms→8s cap, ±25% jitter, honors `Retry-After` (`retry.ts:43-48,106-111,222`). Global slots 4, collapse to 1 for 60s after 429 (`stream-budget.ts:15,38-80`). Resolution env→config→local-probe (Ollama/LM Studio/vLLM/llama.cpp) (`providers.ts:50-174`). All [Verified-Code-Klyro].

**CC side:** Anthropic-native SSE + prompt-cache breakpoints; 429/5xx retry with backoff; overflow triggers compaction [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Wire | Dual OpenAI+Anthropic → one event type | Anthropic-native |
| Usage | Both counter dialects normalized | Anthropic + cache counters |
| Retry | 5× backoff, 429 collapses concurrency | Backoff + model fallback |
| Overflow | `REQUEST_TOO_LARGE` → compact-once | Compact + retry |

**Divergences:** (1) dual-protocol normalization; (2) orphan-fragment safety; (3) harness-level FIFO semaphore; (4) Anthropic-only cache-aware system split; (5) adapter failover without spending step budget. **Takeaway:** Klyro leads on transport breadth + integrity; CC on Anthropic depth. Next: Round 3.

## Round 3 — Tool catalog

**Contract:** every tool's input/output shape, risk class, registration discipline.

**Verified local:** 32 builtins via `builtinRegistry()` (`registry.ts:98-132`). Zod `safeParse` per call → `INVALID_INPUT` without executing (`:83-93`); `Tool` interface never-throws (`types.ts:61-81`, error carries optional `klyroCode` since 1.0.5). Zod→JSON-schema for models (`registry.ts:58-76`, `schema.ts:63-65`); reverse for MCP (`mcp/registry.ts:33,252`). Risk classes `read|edit|execute|admin` consumed by runtime→policy (`types.ts:68-70` doc, `runtime.ts:988`, `engine.ts:184-188`). `isConcurrencySafe` gates fan-out (`runtime.ts:972`). MCP `mcp__srv__tool` ≤64 chars, collisions error, builtins win, forced `admin` + deny-by-default + redact + 12k truncation (`mcp/registry.ts:52-78,121-161,222-257`). `find_symbol` ungated in 1.0.5; LSP tools real (tsc diagnostics + index goto). All [Verified-Code-Klyro].

**CC side:** ~20+ core + dynamic MCP with same `mcp__` convention; JSON-schema validation; more native integrations [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Registration | Single class, Zod-first | Central + MCP attach, schema-first |
| Risk | 4-tier, policy-enforced | allow/ask/deny + labels |
| Concurrency | Explicit per-tool flag | Planner-inferred |
| MCP safety | Namespaced, collision-hard, redacted | Same convention |

**Divergences:** (1) Zod-first refactor-safety; (2) permission now consumed end-to-end (1.0.5 fix); (3) auditable concurrency flags; (4) strict collision errors; (5) 6 first-class agent task tools + worktree merge; (6) open stub reporting (LSP/find_symbol destubbed in 1.0.5). **Takeaway:** smaller but unusually disciplined catalog; CC leads breadth, Klyro leads auditability. Next: Round 4.

## Round 4 — Permission policy tree

**Contract:** gates, precedence, default verdict, escapes.

**Verified local:** verdicts `allow|ask|deny` (`engine.ts:12-15`); `ToolCallLike.permission` optional (`:17-31`); glob precedence deny→allow→ask (`:134-136,185-186`); modes `auto`(allow-all)/`plan`(deny 5 write tools)/`accept-edits` (`:114-132`); **`execute`/`admin` with no allow rule → ask (TTY) / deny (headless)** (`:184-188`, runtime passes class at `runtime.ts:988`); centralized `.env` gate (path+patch+redirection+tee) (`:138-164,362-368`); builtins `shellDeny→shellAllow→writeFileCwd→readFileSize` (`:217-224`); shell denies destructive/pipe-to-shell/exfiltration/`iex`/dotfile-redirect/protected-push (`:326-409`); non-allowlisted shell asks or denies-headless (`:412-423`); path/size gates (`:59-93,425-471`); ask-once session set + `A`=persist (`approval.ts:110-135`, `repl.ts:236-255`); deterministic patterns (`patterns.ts:16-24`); TUI bridge vs headless `DenyAll` (`repl.ts:230-240`); per-risk escapes (`KLYRO_ALLOW_MAIN_PUSH`, scoped `--yes`); **no global bypass** ([Verified-Absent]); redact-after-execute 18 patterns + streaming Transform (`secret-redactor.ts:14-68`); child narrowing `resolveAgentTools` + `childCanIsolate` (`capabilities.ts:66-167`, `orchestrator.ts:331-352`). All [Verified-Code-Klyro].

**CC side (grounded):** order hooks → `deny` → mode → `allow` → `canUseTool`; modes `default(manual)/acceptEdits/plan/auto/dontAsk/bypassPermissions`; `bypassPermissions` still blocked on critical `rm` paths; Shift+Tab cycles; `disableBypassPermissionsMode` managed off-switch [Grounded-Behavior-CC] (code.claude.com permissions docs).

| Aspect | Klyro | CC |
|---|---|---|
| Verdicts | allow/ask/deny + reason | Same trio + hooks layer |
| Precedence | deny→allow→ask + modes | hooks→deny→mode→allow→callback |
| Default | ask/deny for execute+admin; allow else | ask on risky |
| Bypass | per-risk env only | global `bypassPermissions` |
| Persist | session vs settings.json | session/project/user hierarchy |

**Divergences:** (1) privileged default-ask (1.0.5) vs default-ask posture — converged; (2) dedicated `.env` pre-gate; (3) no master bypass; (4) minimal `tool(glob)` grammar; (5) structural child least-privilege; (6) redact-after-execute vs deny-before-read. **Takeaway:** legible tree, rigorous children; **CC leads** on settings hierarchy + automation ergonomics. Next: Round 5.

## Round 5 — Context/budget scheduling

**Contract:** assembly order, drop-vs-summarize, tripwires, observability.

**Verified local:** order identity→tools→envMap→summary→messages (`assembly.ts:16-30`). L6 static once/run, 12k cap, cached `.klyro/context.json` (`level6.ts:131-180,184-202`). KLYRO.md 4k/file, 8k total, `@import` depth-5 (`klyro-md.ts:14-19,67-85`). Memory 8k-reject/4k-steady + 20-turn reminder helpers defined-but-unwired (`memory.ts:16-71`). **Window-aware caps** via `capForModel` (window−reserve, 120k ceiling, 4k floor) wired into runtime/`accounting()`/`compact()` (1.0.5). Over-budget: drop telemetry → `compressTranscript` → `context.compacted` (`runtime.ts:493-499`); 3-phase elide→truncate→splice (`tokenizer.ts:126-178`). `chars/4` calibrated per `message_end`, bounded [2,6] (`:48-71`). Overflow compacts once to 30k else halves (`runtime.ts:579-597`). `compact()` elide→summarize-60%→fallback (`compaction.ts:11-47`). Observable via `/context` meter (`cli/context.ts:8-24`). All [Verified-Code-Klyro].

**CC side:** auto-compact + manual `/compact`, context-% + `/cost` views, hierarchical `CLAUDE.md` memory [Inferred-Design-CC]; `/context` grid + `/cost` totals [Grounded-Behavior-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Ceiling | Window-aware per model (1.0.5) | Model-window-aware |
| Strategy | Drop-first (elide→truncate→splice) | Summarize-first |
| Estimation | Calibrated heuristic | Native tokenizer |
| Observability | `/context` meter + bus event | Status-line % + views |

**Divergences:** (1) explicit numeric ceilings; (2) drop-first vs summarize-first; (3) feedback-loop heuristic vs real counts; (4) bespoke L6 repo-map scoring; (5) token vs stream-concurrency naming; (6) richer tripwire states. **Takeaway:** explicit and inspectable vs polished; same shape, Klyro more engineering-explicit. Next: Round 6.

## Round 6 — Interrupt & abort

**Contract:** keyboard cancel → signal propagation → child handling → audit.

**Verified local:** Ctrl+C armed-cancel then quits (`app.tsx`); **double-Esc** (1st arms + hint, 2nd ≤1500ms cancels) (1.0.5); `/cancel` → `ac.abort()` + immediate `killAllJobs()` with count (`repl.ts`); SIGINT/SIGTERM → abort + `aborted` (`repl.ts:719-725`); headless double-SIGINT/1500ms → abort then `exit(130)` (`run.ts:98-104,289-305`); runtime polls `signal.aborted` at loop/stream/completion + **abort cascade kills background jobs** + emits `abort` bus event with kill count (1.0.5); `shell_exec` forwards signal, group `SIGKILL`/`taskkill` on timeout (`shell-exec.ts:322-334,393-412`); `WorkerSpawner.cancel(All)` + `TaskManager.cancel/cancelTree/shutdown`; queued input cap 3; abort persists `status:aborted` + closes tracer; `aborted→130`. In-process agent children inherit parent signal (`parentAbortSignalRef`, `orchestrator.ts:868`). All [Verified-Code-Klyro].

**CC side:** Esc interrupts leaving partial output [Grounded-Behavior-CC]; Ctrl+C stops then exits, background Bash survives via `/tasks`, follow-up buffered [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| First Ctrl+C / Esc | abort (armed/double) | interrupt, stay |
| Queue | FIFO cap 3, rendered | prompt buffer |
| Background on abort | **Killed + counted (1.0.5)** | Survives (managed) |
| Audit | `aborted` status + bus event + trace close | Transcript + checkpoint |
| Exit | Explicit 130 | Force exit |

**Divergences:** (1) two-layer abort (armed-state vs headless predicate); (2) cooperative polling; (3) cascade-kill vs retain; (4) first-class rendered queue; (5) explicit 130; (6) split UI+persisted audit. **Takeaway:** foreground + background now fully threaded; Klyro stricter than CC's retain-by-default. Next: Round 7.

## Round 7 — Event bus & observability

**Contract:** typed events, durable trace, headless machine output, replay.

**Verified local:** ~24 `KlyroEvent` variants (`events/catalog.ts:16-48`); sync unbuffered bus, swallowed listener errors, 10k history with halving (`bus.ts:14-30`). `TraceWriter` `{...ev,seq}` JSONL promise-queue, redact-before-disk, fsync on `tool.result`, skips corrupt lines, restart-safe seq (`writer.ts:42-77,89-105`); default `<cwd>/.klyro/traces/<session>.jsonl` (`:10-16,30-33`, PRD divergence documented in header). Dual-emit UI `RuntimeEvent` + bus `KlyroEvent` (`runtime.ts:377-380,944-945`). L7 in-memory 1.2KB (`level7.ts:50-77,132-158`). Headless `human/json/silent` (`run.ts:380-418`); `JsonRenderer/StreamJsonRenderer` JSONL (`renderers/json.ts:7-20`); `stream-json` normalized in `index.ts:238-239`. In-repo eval harness (mock + real runtime + audit). All [Verified-Code-Klyro].

**CC side:** `stream-json` NDJSON + session files [Grounded-Behavior-CC] (headless docs: `type:result`, `total_cost_usd`, `session_id`); internal bus not public [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Taxonomy | `KlyroEvent` + `RuntimeEvent` (two dialects) | One streaming schema |
| Dispatch | Sync, deterministic | Async/batched |
| Trace | Project-local redacted JSONL | Global session transcript |
| Headless | human/json/silent | text/json/stream-json |
| Eval | In-tree mock+runtime+audit | External scripts |

**Divergences:** (1) two dialects + manual bridging; (2) sync coupling; (3) selective fsync + project-local; (4) redact-at-write with tests; (5) volatile L7; (6) in-tree eval consumer. **Takeaway:** over-instrumented for audit; unify dialects or codegen the map. Next: Round 8.

## Round 8 — Error taxonomy & recovery

**Contract:** typed errors, retry-only-transient, structured payloads, scrubbed errors.

**Verified local:** `KlyroError(code,hint,exitCode,retryable)`, 11 codes + `EXIT_CODE` (`shared/errors.ts:6-52`); **central `shared/error-map.ts`** maps tool codes + verify classes → harness codes + exits (1.0.5); `toToolError` attaches `klyroCode`, `ToolResult` error carries optional `klyroCode` (1.0.5). Retry wraps stream only on `retryable:true`, 5×, 500ms→8s, ±25% jitter, honors `Retry-After`, abort-aware (`retry.ts:43-226`); 429 collapses budget. Verify classes + `rerunOnce` + `guardRepair` (`classify.ts:29-143`). `TOOL_ERROR_CODES` 11 + custom, errno mapping, `safe()` (`normalize.ts:10-125`). Redactor 18 patterns + streaming Transform, applied at 9 boundaries incl. render + debug sink (1.0.5). Exits `0/1/2/3/4/5/7/8/130` (README table added 1.0.5). All [Verified-Code-Klyro].

**CC side:** 429/5xx auto-retry, typed tool errors [Inferred-Design-CC]; usage-vs-runtime exits [Grounded-Behavior-CC]; policy-based secrets [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Taxonomies | Unified behind one mapper (1.0.5) | Fewer surfaces |
| Retry | Adapter-layer, abort-aware | 429/5xx + fallback |
| Tool payload | Central `safe()` normalization | Structured tool_result |
| Secrets | Pervasive regex scrub | Env/permission gating |
| Exits | 9-code map, documented | 0/1/2 + custom |

**Divergences:** (1) single mapper entry; (2) retry blind to model (buffered, principled); (3) central errno mapping; (4) env/flaky/pre_existing branches; (5) regex over/under-match residual (b64 tightened 1.0.5); (6) richer exits. **Takeaway:** Klyro leads on explicitness. Next: Round 9.

## Round 9 — Session lifecycle

**Contract:** ids, durability, resume/branch, tamper-evidence, isolation.

**Verified local:** UUID + 8-char display + prefix resolution (`store.ts:134-140`, `session.ts:36-55`). `~/.klyro/sessions`: JSON + JSONL + lock + indexes, tmp+fsync+rename (`session.ts:11-16`, `store.ts:54-126,254-281`). Record + separate redacted messages/observations (`store.ts:27-52,283-302`). Resume via `--resume-session`, `session resume`, `-c/--continue`, `-r/--resume` (`run.ts:242-280`, `index.ts:212-224,460-500`). Fork deep-copies (`store.ts:184-199`); **export includes observations, import restores messages+observations with shape validation** (1.0.5 fix, `index.ts`). Audit sha256 chain + `verifyAuditChain` (`audit.ts:40-138`). Checkpoints raw bytes + `undo(n)/rewind` (`checkpoints/store.ts:52-88,157-187`). Locks + `kill(pid,0)` takeover-warning + worktrees (`run.ts:119-123,255-263`, `store.ts:64-76,394-419`). All [Verified-Code-Klyro].

**CC side:** `--resume/--continue`, timeline checkpoints + `/rewind`, project-scoped history [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Persist | JSON + messages + observations + JSONL | Transcript + checkpoints |
| Branch | Deep-copy fork; byte-undo | Timeline branch |
| Export/import | Full round-trip (1.0.5) | Export transcript |
| Integrity | sha256 chain + `audit` cmd | Transcript trust |
| Isolation | Locks + worktrees | Worktrees + cwd scope |

**Divergences:** (1) hash chain unique; (2) dual global+per-project index; (3) deep-copy fork; (4) import loss fixed; (5) warn-and-takeover locks; (6) raw-byte checkpoints vs redacted JSON split. **Takeaway:** Klyro leads durability engineering; CC on resume-picker UX. Next: Round 10.

## Round 10 — Verification sub-loop

**Contract:** trigger, modes, classification, bounded repair, exits.

**Verified local:** fires only on natural completion with `hasEdits` (`runtime.ts:776-780`). `off`/`advisory`/`strict` (`:725-775`). Resolution flag → auto-detect → priority registry (`auto.ts:10-34`, `registry.ts:46-110`). Spawn with destructive-denylist, 256KB cap, 5min timeout, filtered env, typed `detect()` (10 runners) + redacted diagnostic (`engine.ts:52-155`, `detect.ts:14-53,230-245`). Scoped tests → syntax/import sanity → full suite (`runtime.ts:783-827`, `scoped.ts:11-213`). Classes via HEAD-baseline overlap + `rerunOnce` + env-regex (`classify.ts:29-71`, `baseline.ts:39-84`). Repair injects diagnostic+hunks+blame, guards assertion/skip edits (`runtime.ts:892-922`, `classify.ts:79-142`). `maxRepairAttempts` default 3; exhaustion→`verify_failed`; flaky/non-overlapping→`complete` (`run.ts:310-319`, `runtime.ts:839-931`). Exits incl. 8 (`run.ts:454-492`). All [Verified-Code-Klyro].

**CC side:** lint/test via hooks + slash, fix-or-explain to model, no bounded counter/modal gate/exit-8 [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Trigger | Completion + edits | Post-edit hooks / manual |
| Modes | strict/advisory/off | None |
| Classification | 6 types + 4 classes + baseline | Model-judged |
| Repair | Bounded + guarded context | Open-ended retry |
| Exit | Deterministic 8 | Generic nonzero |

**Divergences:** (1) modal gate as promise; (2) HEAD-baseline `pre_existing`; (3) explicit flaky/env branches; (4) scoped-then-full cost saving; (5) repair guard as policy-as-code; (6) CI-deterministic exit 8. **Takeaway:** wash is wrong — **Klyro's clearest structural lead.** Next: Round 11.

## Round 11 — Token/cost accounting

**Contract:** estimate vs reported usage, pricing, accumulation, surfacing.

**Verified local:** rates single-sourced, family fallbacks, local-$0, unknown→$0 (`model-info.ts:18-64`); `chars/4` + per-run calibration bounded [2,6] (`tokenizer.ts:48-71`); caps via `capForModel` (1.0.5); prefer provider usage else `estimated:true` (`runtime.ts:547-574`); Anthropic-only cache billing (`:243-253`); `maxCost`→`limit` + 40/70/90% warnings; surfaces TUI `$cost·ctx%` (`app.tsx`), `/cost` (`repl.ts:991-1002`), **headless final cost line + additive JSON `cost_usd`** (1.0.5, `run.ts`); no cost in `doctor` ([Verified-Absent]). All [Verified-Code-Klyro]. CC headless JSON carries `total_cost_usd` + `usage{input,output,cache_*}` [Grounded-Behavior-CC].

**Divergences:** (1) `$0` unknowns; (2) self-calibrating heuristic; (3) Anthropic-only cache billing; (4) repair-token ledger; (5) headless gap closed in 1.0.5. **Takeaway:** honest about uncertainty; calibrated heuristics beat false precision. Next: Round 12.

## Round 12 — Secret hygiene

**Contract:** `.env` entry, redaction, at-rest/in-transit scrub, credential storage, commit gate.

**Verified local:** `<cwd>/.env` only, no-clobber, tolerant parser (`dotenv.ts:13-51`, `repl.ts:49-54`). 18 regexes + 1KiB-holdback streaming Transform; b64 pattern requires +/= AND digit (1.0.5 tightening) (`secret-redactor.ts:14-68`). Scrubbed at 10 boundaries incl. **render + debug.log sink** (1.0.5: `app.tsx` paint points, `repl.ts` console sink). Credentials 0600 + chmod-repair, **refuse-on-lax** unless insecure-override (1.0.5, `auth.ts:21-31,131-149`). Commit gate: staged-diff redact-compare → refuse exit 2 unless `--force-secret` (`commit.ts:124-135`); shell-free, hooks-unsplittable; `.gitignore` blocks env/keys/creds/`.klyro/`. All [Verified-Code-Klyro].

**CC side:** ambient shell env; keychain/`~/.claude.json`; no commit gate; model-side redaction [Inferred-Design-CC].

| Capability | Klyro | CC |
|---|---|---|
| `.env` | cwd-only loader | Inherited env |
| Redactor | 18-pattern checked-in | None checked-in |
| Scrub points | 10 incl. screen/log | Trust-boundary |
| Key storage | 0600 + refuse | Keychain |
| Commit gate | Diff-scan + named override | None in-CLI |

**Divergences:** (1) auditable redactor; (2) minimal loader; (3) file-perms vs keychain — Klyro still loses on hardened desktops; (4) novel commit gate; (5) screen/log gap closed 1.0.5; (6) b64 FP class narrowed. **Takeaway:** strictest on disk and now on screen. Next: Round 13.

## Round 13 — Output rendering

**Contract:** headless vs TUI paths, markdown subset, highlighting, diffs, streaming safety, themes.

**Verified local:** headless `renderMarkdown` → plain on non-TTY/JSON/NO_COLOR (`cli/markdown.ts:32-38`); TTY boxes/pipes/uppercase-H1 (`:44-90`, code fences share `highlightCodeLine`). TUI `renderMarkdownLines` (bold, `*`→dim, code, links, fences) (`tui/markdown.ts:177-229`); hand-scanner with escape handling + **`'`-contraction guard** (1.0.5) + **separator-flush ordering fix** (1.0.5 latent bugfix); OSC-8 `file://path#L` links (`:150-175`); diff types-only + `parseUnifiedDiff` subset + inline hunks (`diff.tsx`, `diff-parser.ts:20-63`, `app.tsx`); **single-`<Text>` invariant** (`app.tsx` + `InputWithCursor` same rule); id-keyed delta merge + 64ms throttle (1.0.5); stdout/stderr split + JSONL renderers; theme single orange accent with **distinct ok-green/warn-amber/err-red** (1.0.5 fix) + ASCII fallback (`tokens.ts`). All [Verified-Code-Klyro].

**CC side:** full terminal markdown, grammar highlighting, edit-preview accept/reject diffs, adaptive theme [Inferred-Design-CC].

| Capability | Klyro | CC |
|---|---|---|
| Markdown | Subset, boxed fences | Fuller nested |
| Highlighting | Hand scanner, contraction-safe | Grammar-based |
| Diff | Inline transcript | Interactive preview |
| Streaming | Single-`<Text>` + throttle | Native renderer |
| Theme | Orange + distinct status hues + ASCII | Adaptive multi-token |

**Divergences:** (1) two implementations sharing `highlightCodeLine`; (2) regex-light, multiline-string limit documented; (3) Ink-specific invariant; (4) transcript-inline diff; (5) status hues fixed; (6) cleaner machine contract. **Takeaway:** purity/testability/stream-safety over fidelity. Next: Round 14.

## Round 14 — Keyboard/keymap

**Contract:** bindings × modes, history-vs-scroll, mouse, autocomplete, queue, paste.

**Verified local:** one `useInput` + modal `useInput` (`app.tsx`, `approval.tsx:89-111,132`); scroll cmds + Home/End/Space-unread/Ctrl+G/Ctrl+B/F/Shift-arrows (`transcript-commands.ts:42-50`, `app.tsx`); wheel ±3 (`mouse.ts:19`); buffer-aware `↑/↓` (`app.tsx`); running queue cap 3; Ctrl+C armed; **double-Esc + hint** (1.0.5); cursor-aware insert/delete via ref mirrors; **vim insert/normal** (h/l/0/$/x/i/a/j/k, block cursor, legacy 75ms window) (1.0.5); **bracketed-paste atomic bulk** via `PasteFilter` + `2004h` (1.0.5); slash prefix→**fuzzy** top-6 + Tab (1.0.5); **`/keymap` prints the real table** (1.0.5); `/paste` + `/copy` clipboard cmds; no remapping ([Verified-Absent] by design, admitted in `/keymap`). All [Verified-Code-Klyro].

**CC side:** vim/emacs modes, bracketed paste, fuzzy `@`+`/` complete, queued prompts, double-Esc; `/vim`, `/terminal-setup`, `/memory` grounded in slash references [Grounded-Behavior-CC for command existence].

| Capability | Klyro | CC |
|---|---|---|
| Scroll | 4 cmds + extras via stdin tap | Native scroll |
| History/scroll | Explicit tested rule | Same shape |
| Running queue | FIFO cap 3 | Permissive queue |
| Complete | Fuzzy top-6 Tab | Fuzzy + preview |
| Paste | Atomic bulk | Atomic + large-paste flow |
| Vim | 9 verbs, no remap | Fuller grammar |

**Divergences:** (1) bespoke Ink scroll stack; (2) explicit disambiguation; (3) stricter bounded queue; (4) double-Esc converged with CC's rewind-Esc×2 shape; (5) no preview/`@`-completion; (6) compiled-only keymap, honestly labeled. **Takeaway:** enumerated, mode-safe; **CC leads** input richness. Next: Round 15.

## Round 15 — CWD/sandbox

**Contract:** containment, symlinks, multi-dir, kernel boundary, parallel isolation.

**Verified local:** `resolveWithinCwd` lexical + Windows case/drive (`path-guard.ts:48-66`); 3-layer symlink defense (realpath target+parent, lstat, `O_NOFOLLOW`) (`:72-164`); enforced in read/write/edit/patch/list/shell + search cwd (`write-file.ts:74,102`, `read-file.ts:52`, `edit-file.ts:84`, `shell-exec.ts:222-228`, `grep.ts:53`, `glob.ts:34`); `PATH_ESCAPE/COMMAND_DENIED` (`normalize.ts:10-22`); persistent-cwd + cd-tracking + `DANGEROUS_PATTERNS` (`shell-exec.ts:212-280`); bwrap→landlock→none with honest `active:false` (`sandbox.ts:24-181`); **Windows explicitly unsandboxed** (`:69-76`); `--cwd` chdirs (`index.ts:60,94`); `additionalDirs` + live `/sandbox`/`/add-dir` (`engine.ts:433-440`, `repl.ts`); worktree-per-writer + typed escape errors (`worktree-manager.ts:88-115`, `orchestrator.ts:427-464`); **Sandbox row in doctor** surfaces backend or honest none (1.0.5). All [Verified-Code-Klyro].

**CC side:** cwd + `--add-dir`, realpath checks, `sandbox.enabled` in settings [Grounded-Behavior-CC]; process-scoped subagents [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Symlinks | 3 layers | Realpath check |
| Shell boundary | bwrap/landlock or honest none | OS sandbox if present |
| Windows | Documented gap, now surfaced | Weaker too |
| Multi-dir | Live-mutated `additionalDirs` | `--add-dir` flags |
| Agent isolation | Worktree per writer | Process-scoped |

**Divergences:** (1) explicit 3-layer defense; (2) honest degradation; (3) net-off-by-default + shell-deny depth; (4) worktree merge protocol; (5) live multi-dir mutation; (6) typed escape errors. **Takeaway:** thorough path layer + standout parallel-write safety. Next: Round 16.

## Round 16 — Update/self-upgrade

**Contract:** discovery, TTL, opt-out, install mode, integrity, completion.

**Verified local:** notify-only, npm `/latest` + packument, 24h file cache (`update.ts:16-99`); opt-out + relocatable cache (`:21-28,70`); never installs (`:101-123`), REPL nudge (`repl.ts:665-672`); **SRI + sha1 dual digest, semver downgrade protection + negative-cache** (1.0.5); mocked-fetch tests; `klyro update` + 23-command/flags completion ×4 shells (1.0.5); version single-sourced (`version.ts:13`); no auto-install/signatures ([Verified-Absent]). All [Verified-Code-Klyro].

**CC side:** managed auto-update + in-place upgrade; signed installer channel [Inferred-Design-CC].

| Dimension | Klyro | CC |
|---|---|---|
| Mode | Notify-only | Self-applying |
| Cache | Explicit 24h test-isolated | Managed scheduler |
| Integrity | Dual-digest + downgrade gate, trusts TLS | Signature chain |
| Completion | 23 cmds + flags × 4 shells | Deeper hooks |

**Divergences:** (1) never-mutates-self; (2) explicit testable cache; (3) digests-not-signatures (residual); (4) stderr nudge only; (5) static 2-level completion. **Takeaway:** conservative + auditable at friction cost; CC leads convenience. Next: Round 17.

## Round 17 — Telemetry semantics

**Contract:** in-process self-context vs vendor analytics; what leaves the machine.

**Verified local:** "telemetry" = L7 model-facing state, 1.2KB, memory-only (`level7.ts:1-158`); volatile cache-split suffix (`runtime.ts:344-345,480-496,1413-1424`); redacted local JSONL, project-local default (`writer.ts:30-76`); egress enumerated: provider, registry+tarball, explicit `/web` (caps), user MCP; **no PostHog/Segment/OTLP/phone-home** ([Verified-Absent]); `KLYRO_TELEMETRY` dead Dockerfile comment; evals mock + deleted tmpdir. All [Verified-Code-Klyro].

**CC side:** usage-stats vs opt-out product telemetry; `CLAUDE_CODE_ENABLE_TELEMETRY`/`OTEL_*` keys exist [Grounded-Behavior-CC for key existence]; vendor egress by default with disables [Inferred-Design-CC].

| Dimension | Klyro | CC |
|---|---|---|
| In-process | L7 ephemeral suffix | Turn usage tracking |
| Egress | Provider + registry + explicit | + vendor telemetry |
| Opt-out | Per-check env; nothing to disable | Documented disables |
| Eval data | Local mock, deleted | Cloud-retained unless out |

**Divergences:** (1) naming collision; (2) zero analytics endpoint; (3) no telemetry env surface; (4) structural redact-before-write; (5) eval isolation by construction. **Takeaway:** privacy-by-absence is the lead. Next: Round 18.

## Round 18 — Bootstrap/first-run

**Contract:** memory precedence, repo maps/caching, first-call context, init equivalent.

**Verified local:** global→local→project incl. `CLAUDE.md`/`AGENTS.md`/`.cursorrules` fallbacks (`klyro-md.ts:27-85`); fresh L6 (map + top-40 + recent 15 + deps, 12k) (`level6.ts:39-182`); trust-gated memory into prefix (`run.ts:546-593`, `repl.ts:212-224`); 60s mem + 24h disk + L6 snapshot caches (`repo-map.ts:41-74`, `project-map.ts:372-386`, `level6.ts:184-217`); fixed assembly order (`assembly.ts:16-31`); `scan`/`project` print map (`scan.ts:7-23`); no wizard ([Verified-Absent]); `/init` REPL-only scan-seeded (`repl.ts:1243-1264`). All [Verified-Code-Klyro].

**CC side:** `CLAUDE.md` hierarchy + interactive `/init` (+ `CLAUDE_CODE_NEW_INIT` multi-phase flow) [Grounded-Behavior-CC]; lazy codebase awareness [Inferred-Design-CC].

| Dimension | Klyro | CC |
|---|---|---|
| Memory file | KLYRO.md-first + compat | CLAUDE.md canonical |
| Map | Eager precomputed L6 | On-demand search |
| Cache | 3 layers | Persistent index |
| Init | Slash-only, scan-seeded | Guided onboarding |

**Divergences:** (1) native filename + compat; (2) eager vs lazy; (3) trust-gated inclusion + bus event; (4) scan-as-seed vs interview; (5) no standalone init. **Takeaway:** rich start-of-turn context at prompt-weight cost; CC leads guidance. End of prior rounds.

## Round 19 — Agent orchestration & subagents

**Contract:** named subagent definitions, child capability narrowing, depth/concurrency budgets, per-child models.

**Verified local:** 6 builtins (explorer/implementer/tester/reviewer/debugger/docs) (`orchestrator.ts:73-116`); explorer read-only, implementer writes/maxSteps 60, tester shell+verify/120s; all `canSpawn:false` default. Narrowing is pure intersection parent→policy→allow-list→readonly→no-spawn→denied with surfaced `dropped[]` reasons (`capabilities.ts:77-167,221-252`); readonly strips writes + `run_verify`; `RECURSION_LIMIT` on depth breach (`orchestrator.ts:392-402`); budgets 4 concurrent / 8 per-parent / 32 per-session (`:44-46,405-425`); model `input ?? resolved ?? parent`, `'inherit'` in-process sentinel (`:445,524,588`); `spawn_agent` async + `task_wait/get/apply/stop`; `abortOnParent: undefined` stubbed (`:476`) vs `parentAbortSignalRef` (`:868`) — real abort lives in TaskManager (`task-manager.ts:82`). All [Verified-Code-Klyro].

**CC side (grounded):** markdown agents (`.claude/agents/`, name/description/tools/model/prompt), inherit parent permissions with restrictions, background-by-default, `isolation: worktree` option, per-subagent `memory` + `permissionMode`, subagents cannot spawn [Grounded-Behavior-CC] (sub-agents docs).

| Aspect | Klyro | CC |
|---|---|---|
| Registry | 6 closed code constants | User markdown files + builtins |
| Narrowing | Set intersection + reasons | Permission inheritance + restrictions |
| Spawn | Async task + explicit wait/apply | Blocking or background |
| Depth | Explicit maxDepth + error | Cannot nest (structural) |
| Isolation opt | Worktree per writer | `isolation: worktree` flag |
| Memory per agent | None | `memory:` field + MEMORY.md |

**Divergences:** (1) closed vs extensible registry; (2) observable narrowing vs opaque; (3) async-by-default vs blocking; (4) explicit budgets vs adaptive; (5) `allowedPaths` first-class; (6) abort declared-but-unwired at orchestrator level. **Takeaway:** Klyro more auditable, CC more flexible; **CC leads** on extensibility. Next: Round 20.

## Round 20 — Process isolation & worktrees

**Contract:** in-process vs subprocess boundary, payload, rebuild policy, parallel-write merge.

**Verified local:** writers get `klyro/<taskId>` worktrees from HEAD (`.klyro/worktrees`), readonly shares cwd, non-repo writes → `WRITES_REQUIRE_GIT` (`worktree-manager.ts:80-94`, `orchestrator.ts:450-464`). Merge `--no-ff --no-edit`, conflict parsed (UU/AA/DD/…) then abort + `MERGE_CONFLICT` (`:102-136`); remove/prune/`branch -D`/orphan sweep (`:139-203`); all git via argv `execFile`, filtered env (`:33,45-62`). `forkChild`: node spawn, stdin JSON (not argv), typed payload, 10-min timeout, `ChildCrashError` (`child-worker.ts:39-55,65-74,108-145`); child rebuilds adapter/registry/policy from env, `DenyAll`, no MCP/grandchild bridge (`:183-229`); gate `childCanIsolate` + `KLYRO_WORKER` (`orchestrator.ts:331-352,564`). All [Verified-Code-Klyro].

**CC side (grounded):** sessions and subagents can each run in own worktree; desktop auto-worktrees; exit cleanup prompts; stale-lock sweep [Grounded-Behavior-CC] (worktrees docs).

| Aspect | Klyro | CC |
|---|---|---|
| Unit | Process + worktree per writer | Session/subagent worktrees |
| Merge | Explicit `task_apply` --no-ff | Conversational application |
| Child fidelity | Minimal rebuilt (DenyAll, no MCP) | Full context + permissions |
| Crash | Typed CHILD_CRASH | Opaque failure |
| Cleanup | Orphan sweep namespaced | Exit prompts + lock sweep |

**Divergences:** (1) git-ops vs conversation-ops; (2) two-phase commit vs immediate; (3) minimal vs full-fidelity child; (4) three worker primitives vs unified runtime; (5) conservative TUI prompting rule; (6) namespaced orphan hygiene. **Takeaway:** Klyro leads crash isolation + conflict safety; CC leads fidelity. Next: Round 21.

## Round 21 — Hooks

**Contract:** lifecycle events, matchers, stdin contract, exit/timeout semantics, config.

**Verified local:** exactly 2 events (`preToolUse/postToolUse` zod enum, `hooks.ts:23-28`); no matcher — every hook runs for every tool (`runtime.ts:1053-1075,1163-1178`); config global→project, project-wins, invalid→`[]`+warn (`hooks.ts:58-105`); no checked-in example ([Verified-Absent]); spawn `shell:true`, filtered env + `KLYRO_TOOL_NAME`/`KLYRO_TOOL_INPUT_JSON` (16k sliced, secrets stripped) (`:112-165`); ok only on exit 0, 4k slice, never rejects (`:170-190`); default 30s (`:43`); pre non-zero → POLICY_DENIED pre-execute (`runtime.ts:1051-1075`); post failure → warn + bus event only (`:1161-1178`); once-per-run load, zero-cost skip when empty (`:356-365`). All [Verified-Code-Klyro].

**CC side (grounded):** SessionStart/End, per-turn UserPromptSubmit/Stop(+Failure), per-tool Pre/PostToolUse(+Failure), PostToolBatch, PermissionRequest/Denied, SubagentStart/Stop, Pre/PostCompact; matchers per tool; stdin JSON; exit 0 allow / 2 block-with-feedback; command+HTTP+MCP+prompt hook types [Grounded-Behavior-CC] (hooks reference).

| Aspect | Klyro | CC |
|---|---|---|
| Events | 2 | 15+ lifecycle |
| Matching | None | Regex matcher |
| Input | Env vars (16k cap) | Stdin JSON |
| Deny | Non-zero → POLICY_DENIED | Exit 2 + model feedback |
| Post | Warn-only | Context mutation allowed |
| Management | `hooks list` only | `/hooks` + settings scopes |

**Divergences:** (1) no scoping; (2) env-only vs stdin JSON; (3) no output injection; (4) no session/stop/subagent/compact events; (5) undocumented kill semantics; (6) positional rather than unified permission-hook pipeline. **Takeaway:** **CC leads decisively** — Klyro's is a v1 gate/warn pair with good secret hygiene. Next: Round 22.

## Round 22 — MCP client stack

**Contract:** config shapes/precedence, transports, tool filtering, trust.

**Verified local:** `mcpServers` preferred, `servers` tolerated (`config.ts:58`); global→project merge, project wins per-server, invalid skipped (`:72-99`); `${env:VAR}` (unset→`''`) (`:51-53`); timeoutMs clamped 600s (`:42,89-91`); names 1–20 (`:114`); **stdio-only** spawn `shell:false`, NDJSON JSON-RPC init/list/call/resources/ping, proto `2024-11-05`, 30s/call + 15s connect (`client.ts:1-9,58-62,86-91`); **deny-by-default** filtering pre-I/O (`policy.ts:19-28`, `registry.ts:124-131`); `mcp__srv__tool` ≤64, sanitized, collision-as-error (`registry.ts:54-78`); redact+12k truncation (`:59,154-160`); `requireApproval` adds ask-rule (`:263-264`); project servers need `approveProjectServer` callback or never connect (`:298-324`); trust = sha256 spec-hash file, re-approval on any byte change (`trust.ts:38-44,75-82`); CLI `list/add/remove/probe` (`index.ts:612-677`). All [Verified-Code-Klyro].

**CC side:** local/project/user scopes; stdio + SSE/HTTP + OAuth [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Scopes | global + project | local + project + user |
| Transport | stdio only | + SSE/HTTP remote |
| Default posture | deny unless allowlisted | allow with prompt |
| Trust | hash-pinned, re-prompt on change | approval-once |
| Diagnostics | list/probe + sources map | list/get + auth status |

**Divergences:** (1) no remote transport/auth/OAuth/url field; (2) deny-by-default vs prompt-by-default; (3) hash-pinned vs approval-once; (4) hard 64/20 namespace; (5) redact-before-transcript baked in; (6) no remote auth surface. **Takeaway:** smaller, stricter subset — Klyro leads posture, CC leads reach. Next: Round 23.

## Round 23 — MCP serve + registry operations

**Contract:** reverse direction (serve local tools), method subset, in-serve policy, validated add/remove.

**Verified local:** pure `handleMcpRequest`, notifications→null (`serve.ts:39-48`); exactly init/ping/list/call, else -32601 (`:49-99`); init returns `2024-11-05` + version (`:49-57`); every call headless-gated, deny/ask→`isError` (never prompts) (`:79-91`); defaults builtinRegistry + default engine + nonInteractive ctx (`:30-36`); stdio NDJSON, -32700 parse / -32603 per-request (`:103-126`); `addProjectServer` regex+Zod, dup-reject (`config.ts:138-144`); `removeProjectServer` false-when-absent (`:149-154`); key-preserving atomic tmp+rename (`:127-135`); builtin-name collision quiet-skip, sanitize collision actionable error (`registry.ts:226-244`). All [Verified-Code-Klyro].

**CC side:** primarily MCP consumer; serving equivalents would expose prompts/resources with user permission layers [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Methods | 4 only | Broader expected |
| In-serve policy | ask can never allow (by construction) | User permission stack |
| Resources/prompts | Not served | Supported |
| Add/remove | Project-only, validated atomic | Scoped + remote URLs |

**Divergences:** (1) no resources/prompts/sampling/roots; (2) prompt-bypass closed by construction; (3) pure handler = unit-testable; (4) project-only management; (5) never-throw registry; (6) clients can't enumerate policy or escalate. **Takeaway:** deliberately narrow, testable, policy-caged gateway. Next: Round 24.

## Round 24 — Slash command system

**Contract:** command inventory, typed parsing, args, custom/MCP extensibility.

**Verified local:** ~100 KNOWN + aliases (`parser.ts:139`); curated `COMMAND_DEFS` drives help/commands/complete (`:310-422`); `"/name rest"` → typed union, `!`→shell, `@`→mention, bare→prompt (`:141-156`); fuzzy scorer top-6 (`:429-458`); TUI suggests pre-space only, Tab fills top (`app.tsx:695-708`); dispatch: `/model` persists (`repl.ts:1212-1225`), `/mcp` manages servers (`:1910-1943`), `/add-dir` mutates policy (`:1991-2011`), `/prompt save|get` + `/alias` JSON-backed, `/commands` merges (`:2478-2523,562-563`); file-based `.klyro/commands/` loader absent ([Verified-Absent] glob + parser); MCP prompt-commands absent ([Verified-Absent] `mcp/*.ts`, serve subset). All [Verified-Code-Klyro].

**CC side (grounded):** builtin defaults + custom skills in `.claude/skills/<name>/SKILL.md` (legacy `.claude/commands/` works), MCP-provided commands via `/` typeahead [Grounded-Behavior-CC] (cheatsheet).

| Aspect | Klyro | CC |
|---|---|---|
| Builtins | ~100, 8+ families | Leaner core |
| Custom | KV aliases + saved prompts | Markdown skill/command files |
| MCP prompts | Absent | Present as commands |
| Args | Untyped `rest` strings | Frontmatter-declared params |
| Help | Static + maps | Merged builtin+custom |

**Divergences:** (1) breadth-first hardcode vs extensible core; (2) no versioned command files; (3) tools-only MCP; (4) untyped args; (5) alias-expansion fallback; (6) third-party packs can't plug in. **Takeaway:** **CC leads extensibility** — Klyro needs a command-file loader, not more builtins. Next: Round 25.

## Round 25 — Memory system

**Contract:** write/read/injection paths, limits, compaction survival, non-goals.

**Verified local:** 8k single-write reject (never truncate) (`memory.ts:16,21-25`); 4k tail steady-state (`:18,32`); atomic tmp+rename+fsync-attempt (`:33-44`); redact-at-rest (`:30-32`); thin `memory_write` tool (`memory-write.ts:5-14`); sync+async reads, miss→`''` (`memory.ts:47-56`); `<memory>` injection in REPL (`repl.ts:219-224`) and headless (`run.ts:566-568`); `/memory` read-only slice (`repl.ts:1035-1045`); `shouldRemind`/`reminderForTodos` **defined but unwired** ([Verified-Absent] only definitions at `memory.ts:63-71`); no embeddings/search/global store ([Verified-Absent]). Compaction rewrites only `messages[]`, notes file and system block survive (`compaction.ts:12-15`). All [Verified-Code-Klyro].

**CC side (grounded):** CLAUDE.md (you-write, per scope) vs auto memory (Claude-writes learnings, per repo, first 200 lines/25KB); subagent `memory:` scopes; `/init` interactive scaffolding [Grounded-Behavior-CC] (memory docs).

| Aspect | Klyro | CC |
|---|---|---|
| Store | Single notes file/cwd | Hierarchy + auto memory |
| Writers | Agent tool only | Agent + human-editable |
| Limits | 8k reject / 4k tail-loss | Budgeted + summarized |
| Injection | `<memory>` system block | Preamble, protected across compact |
| Read UX | Print slice | Manage/edit files |

**Divergences:** (1) single file vs hierarchy; (2) throw vs chunk/summarize; (3) silent 4k tail loss; (4) dead reminder helpers; (5) no vector/global; (6) humans can't append directly. **Takeaway:** durable-but-dumb scratchpad; CC leads ergonomics. Next: Round 26.

## Round 26 — TUI scroll architecture

**Contract:** why custom, anchor design, measurement, virtualization, resize, follow-vs-pinned.

**Verified local:** custom because Ink has no scrollbox (`transcript-commands.ts:12-15`); anchor `{bottom}|{pinned itemId+line}` never raw rows (`scroll-model.ts:11-13,69-80`); directional re-stick `FOLLOW_EPSILON=1` (`:22,66-72`); `CONTENT_GREW` follow-reset vs `newSinceUnstick` accumulate (`:98-108`); `↓ N unread`, 999+ cap, hidden at bottom (`:139-144`); CJK=2/combining=0 measurement, per-kind heights, 12-item expanded cap (`measure.ts:47-120`); `(key,width,sig)` cache 2000-entry, width-invalidate (`:151-176`); cumulative offsets + incremental rebuild + binary search (`:184-216`); 4 commands + bindings (`transcript-commands.ts:18-50`); stdin `read()` tap SGR/X10, wheel ±3 (`mouse.ts:19,40-100,206-236`); total-delta→CONTENT_GREW, width→REFLOW, viewport `height-10`, <10-row degraded (`app.tsx:225-238,428-436`); line-slice virtualization, `●/│` rail, centered pill (`:521-552,960-974,190-198,968-974`); submit triple re-pin (`:297-310`). All [Verified-Code-Klyro].

**CC side:** custom viewport, sticky-follow + unread pill, message-anchored scrollback, re-wrap-on-resize [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Position | Item+line anchor, pruned→re-stick | Message-anchored |
| Granularity | Block→line index, block slice | Message-window |
| Resize | REFLOW + full invalidate | Re-wrap, keep visible |
| Clicks | Swallowed (Shift+drag native) | Fuller mouse support |

**Divergences:** (1) anchor purity + re-stick; (2) hand-rolled CJK/ANSI widths; (3) 4-command vocabulary; (4) click-hostile by design; (5) pill-above-input workaround documented; (6) submit-settle ritual. **Takeaway:** most engineered subsystem here; CC likely leads polish/selection only. Next: Round 27.

## Round 27 — Vim, keymap, paste

**Contract:** modal verbs, cursor correctness, paste atomicity, keymap honesty.

**Verified local:** `insert|normal` + `cursor|null=end` (`app.tsx:326-331`); ref mirrors + clamping (`:333-357`); verbs exactly h/l/0/$/x/i/a/j/k, rest swallowed (`:322-325,754-766`); idle-Esc→normal + legacy 75ms Esc-Return→newline (`:358-360,730-750,835-836`); inverse-video block cursor (`:122-146`); `--NORMAL--` badge (`:984-989`); `/vim` live-toggle + persist + verb announcement (`repl.ts:2354-2369`); `2004h` + `PasteFilter` reassembly/1MB force-flush (`mouse.ts:110-195`); bulk `pasteText→insertAtCursor` via read-tap + emit fallback (`app.tsx:686-690`, `repl.ts:428-456`); `/keymap` prints real table, admits stored note display-only (`repl.ts:2321-2352`). All [Verified-Code-Klyro].

**CC side:** larger vim grammar + readline parity; bulk paste + large-paste UX; documented remappable keymap [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Verbs | 9, no operators/counts/visual | Fuller grammar |
| Cursor | Explicit index, clamped | Native editor cursor |
| Paste | Atomic + normalized | Atomic + large-paste flow |
| Remap | Compiled-only, admitted | Configurable |

**Divergences:** (1) motion-only + x; (2) clamp-everywhere correctness; (3) filter-side paste plumbing; (4) honest keymap; (5) j/k scroll transcript, not intra-input; (6) persistence without remapping. **Takeaway:** careful miniature, not a vim — **CC leads**; keymap honesty is the virtue. Next: Round 28.

## Round 28 — Headless & exit-code contract

**Contract:** pipe-safe machine output, JSONL shapes, stable exits, determinism story.

**Verified local:** `human|json|silent`, human default, strict validation (`run.ts:60`, `index.ts:314-317`); human splits text→stdout, tools/policy/verify/cost→stderr (`run.ts:389-417`, `terminal.ts:12-34`); json = one RuntimeEvent/line (`run.ts:381-382`, `json.ts:14-16`); stdin appended non-TTY (`index.ts:228-237`); `run`/`-p`/positional→`runOnce`, stream-json collapses to json (`index.ts:68-69,226,238-247`); 3 resume variants (`run.ts:242-283`, `index.ts:213-223,292-293`); `statusMap` finalize + stderr summary + additive `{kind:cost}` JSONL (`run.ts:430-464`); exits 0/2/7/130/5/8 (+3/4 in README table) (`run.ts:130-505`, `index.ts:76-84`, `README.md:29-41`); no `--bare`/`--seed` ([Verified-Absent] `index.ts`, `run.ts`). All [Verified-Code-Klyro].

**CC side (grounded):** `-p` + `--output-format text|json|stream-json`, single-JSON (`type:result`, `total_cost_usd`, `usage`, `session_id`) vs NDJSON events, `--max-budget-usd`, `--mcp-config`, `--resume/--continue`, exit 0/non-zero, `--bare` deterministic mode skipping discovery [Grounded-Behavior-CC] (headless references).

| Aspect | Klyro | CC |
|---|---|---|
| Split | stdout text / stderr status | Same shape |
| JSON | Internal RuntimeEvent lines + cost + final | Stable `result` envelope |
| Entries | run/-p/positional (different defaults) | `-p` canonical |
| Determinism | temp/steps only | `--bare` mode |
| Exits | 0/2/5/7/8/130 explicit | 0/non-zero minimal |
| Cost | Always-on final line | In JSON/verbose |

**Divergences:** (1) internal-shaped JSONL, no committed envelope; (2) 3 overlapping entries; (3) stream-json is an alias; (4) cost-before-final two-line parse; (5) no `--bare`; (6) file-transcript vs session-store resume mix. **Takeaway:** CI-suitable exits, richer than CC's minimal contract — but commit a stable JSON envelope and add `--bare`. Next: Round 29.

## Round 29 — CLI surface inventory

**Contract:** countable commands/flags/aliases, legacy honesty, help gaps.

**Verified local:** `klyro`/`ky`, v1.0.5 (`package.json:2-11`); globals incl. `-p`, `--tui/--chat`, `-c/-r` (`index.ts:60-71,125-126,545-546`); ~21 commands incl. `eval:compare`, `session`+`resume` alias, `scan`+`project` alias, `sessions`, `mcp`, `hooks`, `agents`, `commit`, `audit`, `benchmark` (`:130-784`); `run` 16 options (`:282-301`); `chat` labeled legacy (`:357-369`); bare TTY→TUI, non-TTY→legacy pipe REPL (`:265-276`); aliases resume/project/sessions; mcp 5 subs; sessions split (export/import/fork/delete, no list/show/rename/prune at that level); `--yes` commit-only in help + README (`index.ts:66`, `README.md:49`); some globals ignored on `-p` path (`:238-247`); `benchmark`/`hooks`/`audit` thin (no options, bare-or-list, positional-only). All [Verified-Code-Klyro].

**CC side:** small core + per-area help; one interactive + one headless path; explicit deprecation notes [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Commands | ~21 + nested | Small core |
| Legacy | chat + REPL retained, labeled | Single path |
| Aliases | Partial coverage | Few, explicit |
| Validation | Strict parsers, exit 2 | Strict usage errors |
| Help depth | Uneven | Uniform + examples |

**Divergences:** (1) 3 interactive entries; (2) dual session namespaces; (3) scan/project duplication; (4) ignored globals; (5) thin benchmark/audit/hooks; (6) no per-command short aliases. **Takeaway:** broader binary, narrower polish — canonicalize `tui`, merge session namespaces, honor-or-drop ignored globals. Next: Round 30.

## Round 30 — Auth & commit workflow

**Contract:** credential lifecycle + commit safety least-privilege.

**Verified local:** login prompts provider/key/URL/model, insecure-URL gate, 0600 store (`auth.ts:44-97`); `KLYRO_CREDENTIALS_FILE` override, relocatable envs (`auth.ts:13-18`, `README.md:56`); refuse-on-lax unless insecure-override (`auth.ts:131-149`); logout per-provider/all (`:110-129`); commit parses porcelain index-col incl. renames/quotes (`commit.ts:33-49`), empty-stage exit 2 un-bypassable by `--yes` (`:102-116`), staged-diff redact gate + `--force-secret` (`:124-135`), heuristic conventional type(scope) (`:69-100`), `execFileSync` no-shell + hooks-unsplittable (`:29-31,141-143`), `--dry-run` exit 0 (`:137-140`); `--yes` commit-only (`index.ts:66,750-760`, `README.md:49`). All [Verified-Code-Klyro].

**CC side:** OAuth/keychain login + revocation; message assistance with user-owned staging; scoped auto-approve [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Store | 0600 JSON + refuse | Keychain |
| Secret safety | Diff-content gate + named escape | External scan |
| Execution | No-shell, hooks always run | Shell-out + visible diff |
| `--yes` | Commit-only, never bypasses stage | Scoped approve |
| Message | Deterministic heuristic | LLM-drafted |

**Divergences:** (1) file vs keychain (compensated); (2) `local`→openai key slot; (3) content-based gate; (4) no `--no-verify` by design; (5) narrowest `--yes` seen; (6) heuristic over model-drafted. **Takeaway:** Klyro leads commit safety; trails store ergonomics. Next: Round 31.

## Round 31 — Eval harness

**Contract:** reproducible gate — scripted scenarios, determinism, assertions, suites, comparison.

**Verified local:** dual entries `ScriptedTask` (`harness.ts:34-46`) + JSONL `EvalScenario` (`eval.ts:52-68`); mock-adapter replay, tmp-cwd isolation (`harness.ts:57-73`, `eval.ts:212-254`); structural asserts (status, exact tool-call lists, substring, `check.sh` exit 0) (`harness.ts:90-103`, `eval.ts:289-301`); fixtures `task.md+check.sh+meta.json`, 23 dirs, `smoke` vs `l6-*` filter (`harness.ts:169-213`, `eval.ts:104-117,149-155`); `compareReports` markdown A/B + `eval:compare` (`harness.ts:253-267`, `index.ts:394-405`); persistence variant (`:216-250`); **no model-graded judge** ([Verified-Absent]). Sample fixture is `exit 0` trivial. All [Verified-Code-Klyro].

**CC side:** live runs + human/CI judgment; no checked-in mock harness or compare workflow [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Format | JSONL tuples + TS tasks | Ad-hoc prompts |
| Determinism | Mock + tmp isolation | Live model |
| Assertions | Counts/substring/exit-0 | Human/CI judgment |
| Suites | meta-type filter | No equivalent |
| Compare | Built-in markdown table | Manual |
| Judge | None | Implicit review |

**Divergences:** (1) replay vs live cost; (2) exact-count asserts; (3) trivial sample fixtures; (4) filename-filter suites; (5) `runs`/`parallel` accepted but loop sequential; (6) built-in compare. **Takeaway:** Klyro leads machinery, CC leads signal — add a judge + real fixtures. Next: Round 32.

## Round 32 — Doctor, config, completion

**Contract:** broken-install first-aid — diagnostics, settings layering, discoverability.

**Verified local:** 10 checks fixed order + `--json` (`doctor.ts:174-217`); Node ≥20 (`:21-30`); sessions writability probe (`:59-71`); 3s git spawn (`:73-99`); Sandbox always-ok informational (`:117-126`); MCP global/project counts (`:128-142`); config `list/get/set/unset|delete|rm/path/edit` (`config.ts:510-608`), JSONC-tolerant + Zod + atomic save (`:163-211,15-46,574-592`), `~/.klyro/settings.json` + overrides + legacy fallback (`:128-146`), **6-layer precedence** + `path` introspection (`:340-399,1-5,532-541`); completion 23 cmds + 19 globals + 13 per-command tables × 4 shells (`completion.ts:6-113`). All [Verified-Code-Klyro].

**CC side:** auth-centric doctor; interactive config over layered files [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Doctor | 10 rows, JSON | Fewer, auth-centric |
| Sandbox row | Informational never-fail | Assumed, unsurfaced |
| Config | JSONC+Zod, 6 layers, introspectable | JSON settings, UI-driven |
| Completion | Static 2-level × 4 shells | Thinner |
| First-aid | Prints actionable paths | Points at login |

**Divergences:** (1) preflight vs triage philosophy; (2) absence-documenting Sandbox row; (3) exposed layering; (4) Zod-refusing `set` + prototype-pollution guard; (5) static-only completion (no dynamic values); (6) paths-over-hints failures. **Takeaway:** Klyro wins coverage; CC wins guided repair. Next: Round 33.

## Round 33 — Chat vs REPL vs TUI

**Contract:** right runtime per invocation, honest deprecation, pipe behavior, exit/scrollback.

**Verified local:** `chat()` one-shot SSE (`chat.ts:73-89`); legacy readline REPL in-memory history (`repl.ts:26-50`); Ink TUI `startRepl()` (`cli/repl.ts:48-56`); dispatch `--tui`/`--chat`/TTY/pipe matrix (`index.ts:251-277`); `-p`/positional→`runOnce` (`:226-249`); deprecation labeled in help + stderr (`index.ts:357-359`, `repl.ts:38-39`); pipe mode hand-writes `> ` (`repl.ts:42-72`); TUI needs TTY/force (`cli/repl.ts:232`); 40-turn/80k-char pair-preserving truncation (`repl.ts:21-24,98-125`); alt-screen + 300-line mirror + 100-line exit replay (`cli/repl.ts:385-393,331-342,2599-2618`); guarded `/reload` (`:2412-2449`). All [Verified-Code-Klyro].

**CC side:** one interactive + `-p` headless; native scrollback; invisible config refresh [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| One-shot | `chat` + `run` | `-p` |
| Interactive | TUI (+2 legacy) | TUI |
| Pipe | Faux-interactive REPL | Non-interactive contract |
| Scrollback | Mirror + replay | Native buffer |
| Reload | Explicit guarded | Auto/invisible |

**Divergences:** (1) 3 runtimes shipped; (2) honest-but-incomplete deprecation; (3) faux-prompt pipes; (4) mirror duplication; (5) explicit reload granularity; (6) shell-mirroring exit codes. **Takeaway:** converge on TUI + headless; CC leads simplicity. Next: Round 34.

## Round 34 — Approval UX

**Contract:** ask → block → choose (once/session/always/deny/edit/explain) → fail-safe headless.

**Verified local:** single-flight bridge + fan-out (`approval.tsx:39-62,34-37`); Enter=deny, `A`=persist vs `a`=session, `f` expand, `?` explain (`:91-110,133-148`); choices exactly allow|deny|always|always-persist (`approval.ts:13-20`); **`e` advertised but maps to `deny`** (`:61-70`), runtime treats non-deny as allow+`repairs++` (`runtime.ts:1023-1039`); session `Set` + best-effort settings append, no retro-deny (`approval.ts:110-135`, `repl.ts:241-255`); non-TTY stdin→deny, `DenyAll` non-interactive (`approval.ts:73-96`, `repl.ts:236-238`); sequential gating even on parallel path (`runtime.ts:1189-1199`); queue blocked on `awaitingApproval`, input swallowed (`app.tsx:572-582,725`); **no focus capture/restore** ([Verified-Absent] 151-line modal + app sites). All [Verified-Code-Klyro].

**CC side:** once/session/always-rule/deny, Esc=deny; session vs `permissions.allow`; headless deny-or-bypass; held queue [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| Choices | y/a/A/n, Enter deny | allow/session/always/deny |
| Persistence | Set + eventual settings | Session vs rules file |
| Edit | Dead label | Re-prompt with edits |
| Explain | Inline toggles | Detail view |
| Headless | Deny by default | Deny/bypass flags |
| Focus | Absent | (not assessed) |

**Divergences:** (1) dead `e` label; (2) local toggles, no diff screen; (3) eventually-consistent persistence; (4) double-sanitized prompt text (500+300 chars); (5) one-modal-at-a-time load-bearing; (6) no focus restore. **Takeaway:** safe defaults + strongest queue gate; fix edit-and-retry. Next: Round 35.

## Round 35 — Checkpoints + audit chain

**Contract:** bit-identical restore, tamper-evident log, one-command verify, durability costs.

**Verified local:** snapshots RAW (redaction would corrupt), containment-checked (`checkpoints/store.ts:4-12,62-74`); `.meta.json` + fsync data+meta, 0600/0700 (Windows best-effort) (`:80-88,27-38`); `undo(n)`, `rewind`=`undo(1)`, guard artifacts excluded (`:157-187,132-140`); `diff()` is a `git diff --stat` stub (`:142-155`); per-snapshot diff capped 20 files/20KB/10s (`:89-128`); chain `prevHash`/`GENESIS` + canonical-JSON sha256, promise-serialized appends (`audit.ts:6-101`); `verifyAuditChain` distinguishes fork vs tamper (`:107-139`); `klyro audit <session>` exit-coded (`index.ts:762-781`); runtime checkpoints best-effort + `checkpoint_saved` (`runtime.ts:416-437`); mutation commits redacted while snapshots raw (`:1110-1144`); `last.diff` feeds `guardRepair` (`:918-924`); **no signatures, no snapshot caps** ([Verified-Absent]). All [Verified-Code-Klyro].

**CC side (grounded):** auto-checkpoints before every user prompt (Write/Edit/NotebookEdit only — not bash/user edits); 100 kept w/ retention sweep (~30d, `cleanupPeriodDays`); `/rewind` menu (Esc×2): restore code / conversation / both / summarize-from-here / summarize-up-to-here; resume-persistent; SDK `rewindFiles()` + checkpoint UUIDs [Grounded-Behavior-CC] (checkpointing docs).

| Aspect | Klyro | CC |
|---|---|---|
| Trigger | Post-mutation snapshots | Pre-prompt auto-checkpoints |
| Keep | Uncapped | 100 + 30-day sweep |
| Rewind UI | `undo(n)`/`rewind` commands | 6-action menu, Esc×2 |
| Integrity | Hash chain + verify cmd | Transcript trust |
| Diff | git-stub + capped artifact | First-class per-checkpoint |
| Repair coupling | `last.diff` → guard | (not present) |

**Divergences:** (1) audit log has no fsync (snapshots do); (2) deliberate raw-vs-redacted split; (3) decorative `diff(id)` param; (4) verify CLI deeper than transcript viewer; (5) no signatures/caps; (6) checkpoints load-bearing for policy. **Takeaway:** Klyro leads integrity, CC leads rewind UX (menu, summarize-coupled rewind). Next: Round 36.

## Round 36 — Model registry & provider resolution

**Contract:** endpoint+key+model resolution, auth dialects, honest unknown pricing, new-provider cost.

**Verified local:** 6 entries + 100k/$0/tools:true unknown fallback (`model-info.ts:18-29`); single-sourced rates, family fallbacks, local-$0 regex, never-invent-nonzero (`:35-64`); Anthropic-only 0.1×/1.25× cache billing (`:71-73`, `runtime.ts:245-255`); precedence env→config→env-key→stored→local-probe (`providers.ts:50-174`); unsafe explicit URL hard-errors (`:74-91`); local Ollama/LM-Studio/vLLM/llama.cpp + 600ms `/models` probe (`:24-29,177-193`); HTTPS allowlist + opt-in (`chat.ts:42-71`); body builder + Bearer-if-nonempty + 120s timeout + REQUEST_TOO_LARGE vs 429/5xx+Retry-After (`provider-adapter.ts:189-302`); Anthropic `x-api-key`/Bearer switch + cache-breakpoint layout (`anthropic-adapter.ts:128-191`); read-only tool set in providers absent ([Verified-Absent] 207 lines). All [Verified-Code-Klyro].

**CC side:** closed first-party + Bedrock/Vertex bridges, OAuth/keychain login, curated catalog, no local story [Inferred-Design-CC].

| Aspect | Klyro | CC |
|---|---|---|
| World | Open any OpenAI-compatible URL | Closed managed |
| Unknown price | $0 fallback | Rejected/unmapped |
| Local | 4-endpoint probe + loopback | None |
| Auth | Conditional Bearer / x-api-key | Internal dialects |
| HTTPS | Explicit allowlist | TLS-first managed |
| New provider | Adapter + resolution + pricing + dispatch (4 touchpoints) | N/A |

**Divergences:** (1) open vs closed; (2) $0-unknown under-bills hosted unknowns; (3) fixed probe order, no weighting; (4) cache pricing runtime-side only; (5) no single registration point; (6) anti-exfil hard-fail. **Takeaway:** breadth + honesty vs managed depth; unify provider registration. End of Phase 1 (36 rounds).

# PHASE 2 — CROSS-CUTTING AUDIT (post-1.0.5, residual)

Prior HIGHs (abort cascade, default-allow, screen/log scrub, downgrade recommend, lossy import) are **fixed in 1.0.5** — verified by 889 green tests. What remains:

## Risk register (residual top 10)

| # | Risk | Severity | Location | Fix |
|---|---|---|---|---|
| 1 | `e` (edit) approval choice is a dead label mapping to deny | MED | `approval.ts:61-70`, `runtime.ts:1023-1039` | Re-prompt loop with edited input |
| 2 | Dead `shouldRemind`/`reminderForTodos` (20-turn nudge never fires) | LOW-MED | `memory.ts:63-71` | Wire into assembly or delete |
| 3 | Memory 4k silent tail-loss | MED | `memory.ts:18,32` | Summarize-on-rotate vs slice |
| 4 | Hooks: no matchers, 2 events, env-only 16k input | MED | `hooks.ts`, `runtime.ts:1051-1078` | Matcher field + stdin JSON + session/stop events |
| 5 | Closed 6-agent registry, no custom agents/MCP prompts/commands | MED | `orchestrator.ts:73-116` | `.klyro/agents/*.md` + command-file loaders |
| 6 | `orchestrator.abortOnParent: undefined` (children rely on TaskManager path) | LOW | `orchestrator.ts:476` | Wire parent signal through |
| 7 | stdio-only MCP, no remote/SSE/OAuth | MED | `mcp/client.ts`, `config.ts` | Remote transport + auth fields |
| 8 | Internal-shaped JSONL, no committed stable envelope; no `--bare` | LOW-MED | `run.ts:381-417`, `renderers/` | `result` envelope + `--bare` |
| 9 | Triple runtime (TUI+chat+REPL) + dual session namespaces + ignored globals | LOW-MED | `index.ts` | Canonicalize, merge, honor-or-drop |
| 10 | Uncapped snapshots, unsigned chain, audit without fsync, stub `diff(id)` | LOW-MED | `checkpoints/store.ts`, `audit.ts` | Caps + signatures + fsync + real diff |

## HIGH-severity findings
None outstanding at 1.0.5 rigor level. Nearest (all MED): edit-path stub, matcher-less hooks, memory tail-loss, closed registries.

## Known flakes
None confirmed across three full runs (835→851→889). Timing-sensitive candidates (not observed failing): scroll settle-waits, `vi.stubGlobal` update tests, Windows shell timeouts, MCP temp-dir races.

## Documentation gaps (residual)
Hook event catalog vs CC surface; MCP collision policy; worktree merge protocol; calibration bounds rationale. Fixed in 1.0.5: exit-code table (README), `KLYRO_YES` scope (README + help), scroll spec-vs-shipped notes (`scroll.md`, `TUI_DESIGN.md`), `Tool.permission` consumption docs.

## Performance hotspots (residual)
Streaming copies bounded by 64ms throttle (fixed 1.0.5); `scanner separator-flush` ordering bug fixed 1.0.5. Remaining: uncapped checkpoint growth; 10k bus history halving (amortized fine); `groupTools` per-transcript memo (fine).

---

# PHASE 3 — CAPSTONE

**12 load-bearing dimensions, in order:** turn loop · policy tree · provider streaming · context budget · verification sub-loop · session/audit durability · tool catalog · interrupt/abort · secret hygiene · sandbox/CWD · orchestration/isolation · headless contract.

**4 deepest structural asymmetries:**
1. **Verification as code vs as advice** — bounded classified repair + exit 8 vs hooks + model judgment.
2. **Durability vs fluidity** — hash chain, atomic writes, raw snapshots, redacted traces vs transcript trust + rewind menus.
3. **Breadth vs depth in providers** — open dual-adapter + local probing vs Anthropic-native managed depth.
4. **Explicitness vs extensibility** — closed registries (agents, commands, hooks) with observable semantics vs open markdown/hook/skill surfaces with opaque internals.

**7 highest-leverage moves for Klyro:** (1) hook matchers + stdin JSON + session/stop events; (2) `.klyro/agents/` + command-file loaders (+ MCP prompts); (3) stable JSON `result` envelope + `--bare`; (4) real edit-and-retry approval path; (5) memory summarize-on-rotate + wire reminders; (6) single provider registration point; (7) canonicalize TUI/session namespaces.

**7 inverted moves for CC:** (1) bounded verify loop + exit codes; (2) hash-chained audit + `audit` cmd; (3) open provider adapter + local probing; (4) commit-time secret gate; (5) worktree-per-writer two-phase apply; (6) pure capability intersection w/ drop reasons; (7) in-tree mock eval + `eval:compare`.

**Distillation:** Klyro is a harness engineered for auditability — every loop, verdict, byte, and cent typed, persisted, and re-checkable — while Claude Code is an instrument engineered for flow, where safety lives in prompts, hooks, and settings hierarchy. Klyro's leads are structural (verification, audit chain, capability narrowing, commit gate, worktree isolation, explicit budgets); CC's leads are experiential and extensible (hooks, subagents, skills, rewind UX, onboarding, self-update). Each side's cheapest win is the other's home turf: Klyro needs open surfaces (hooks with matchers, agent/command files); CC would gain most from Klyro's closed-loop guarantees (bounded verify, hash-chained audit, capability intersection).

---

# Where the verbatim text lives

- Header + Phase 0 + Rounds 1–18: reconstructed from the prior audit turn's delivered text (same session, same evidence).
- Rounds 19–36: investigator outputs from six parallel read-only subagents, lightly trimmed for length; file:line references preserved as delivered.
- Risk register + capstone: synthesized from all 36 rounds post-1.0.5 (prior HIGHs marked fixed only where the 1.0.5 diff + 889 green tests confirm).
- `comparison.md.bak` (111KB) was NOT overwritten — it holds the pre-1.0.3 audit and remains intact.
