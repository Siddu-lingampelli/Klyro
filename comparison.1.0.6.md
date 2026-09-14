# Klyro vs Claude Code — 1.0.6 Superseding Addendum

*Scope: the delta commit `b28b98f (1.0.5) → f748aeb (1.0.6)`. Every claim below is [Verified-Code-Klyro] with a `file:line` read live from the 1.0.6 tree in this session; nothing is re-verified-by-memory. Companion to `comparison.md` (the 36-round 1.0.5 audit, whose unaffected rounds 1, 4, 5, 6, 8, 9, 11, 12, 13, 15, 16, 17, 25, 27, 28, 29, 33, 34, 35 still stand as written).*

**Headline:** 1.0.6 is a **beat-CC extensibility + determinism release**. It resolves **9 of the 10 residual top-10 risks and 3 of the 4 "deepest structural asymmetries"** from the 1.0.5 capstone, almost exactly per the capstone's recommended moves. The commit message's `hooks v2 · open registries · approval edit-retry · rewind menu · result envelope · bare · memory trio · eval judge · provider registry · vim grammar · at-complete · remote MCP · init · session merge` maps one-to-one onto the diff.

**Build/test state (verif�ed this session):** `tsc --noEmit` **exit 0** (background task, completed) · `npm test` **91 files / 920 passed** (background task, exit 0) — up from 85 files / 889. HEAD `f748aeb`, working tree clean.

---

## Phase 0 — Reconnaissance (1.0.6 point)

- **Project:** same as 1.0.5 (`package.json:2-11`), version bumped `1.0.5 → 1.0.6` (`package.json:3`).
- **Delta shape:** 43 files touched, **+3231 / −478 lines**; 12 net-new files. New source modules under the existing families: `agent/custom-agents.ts`, `cli/init.ts`, `cli/slash/custom.ts`, `eval/judge.ts`, `mcp/remote.ts`, `providers/endpoints.ts` (+ 6 test files each).
- **New slash/CLI surface:** `klyro init` (first-class, `index.ts:207-224`); `--bare` (`index.ts:321`, 12 source sites); `--temperature --max-tokens` on headless, `--judge-model` on eval, `--bare` on run (`index.ts:68-70, 316-322, 399-401`); `/rewind <n>` `/rewind <n> summary` `/checkpoints` `/undo <n>` `/memory append <text>` (`slash/parser.ts:29-30,160-183,385-393`); full `/checkpoints` handler (`repl.ts:1140-1164`); **custom command files** (`cli/slash/custom.ts:105-124`) and **MCP prompt-commands** (`repl.ts:2671-2686`).

---

## Phase 1 — Updated rounds (in comparison.md's order)

### Round 3 — Tool catalog (UPDATE: open-agent registry)

**What changed:** tool count is unchanged (32 builtins, `tools/registry.ts:98`), but the *agent* catalog is no longer closed. `.klyro/agents/*.md` + `~/.klyro/agents/*.md` are parsed with frontmatter `name/description/tools/model/readonly/canSpawn/maxSteps/maxTokens/maxCost/maxTimeMs/allowedPaths` + body-as-instructions (`custom-agents.ts:3-11,21-53`); global-then-project, **`custom id wins on clash, overriding a builtin`** (`:69-85`, header note at `:2-4`); id constrained to `[A-Za-z0-9_-]{1,32}` (`:19`); unknown tool names are deliberately *not* rejected at load — they're dropped with `dropped[]` reasons by `resolveCapabilities` at spawn (`:9-11`). Unified lookup `listAllAgents()` (builtins + custom, `orchestrator.ts:219-228`) and `findAgent()` (`:230-236`); `orchestrator.listAgents()/getAgent()` now delegate to it (`:316-321`). The `prompt` body is prepended to the delegated task on both in-process and fork-child paths (`orchestrator.ts:554-557, 619-635`). **Divergence (1.0.5 #5 "closed 6-agent registry" → resolved).** `findAgent` used for early `--agent` fail-fast in `run.ts:134-140`.

**CC side re-grounding:** `.claude/agents/*.md` with the SAME frontmatter names (`name/description/tools/model`), subagents cannot spawn, `memory:` and downloadable-scope fields — Klyro closes the *discovery* gap (open files) while keeping CC's *cannot-spawn* spine (`canSpawn` default false, `custom-agents.ts:38`) and *inherits-parent-tools* default (`allowedTools` omitted → parent's, `:34-35`) [Grounded-Behavior-CC, prior round + CC sub-agents docs].

| Aspect | Klyro 1.0.5 | Klyro 1.0.6 | CC |
|---|---|---|---|
| Agent discovery | 6 closed constants | Open markdown, global+project | Open markdown |
| Override | N/A | File overrides builtin (source surfaced) | User above/instead of builtin |
| Frontmatter | none | name/desc/tools/model/readonly/canSpawn/max*/allowedPaths | name/desc/tools/model/memory/… |
| Unknown tool | n/a | Deferred to `resolveCapabilities` drops | Allowed then per-tool gated |
| Instructions | Fixed prompt | Body prepended to task | Body = system prompt |

Update: prior Round 3's takeaway "CC leads breadth/auditability tradeoff" — a *6-point closed registry* was the narrowest part; the catalog surface is now extensible. **Takeaway:** Klyro's agent surface converges on CC's shape; the distinctive remainders are code-audited capability intersection and surfaced name-clash precedence.

### Round 21 — Hooks (UPDATE: v2, matchers + stdin JSON + lifecycle)

**What changed:** exactly the prior HIGH "matcher-less hooks, 2 events, env-only 16k input" — delivered as `hooks v2`. Schema now `preToolUse|postToolUse|sessionStart|sessionEnd|stop` + optional per-tool `matcher` (regex against tool name; **invalid regex never matches**, `hooks.ts:165-182`, `HookEventSchema` at `:31`); config merge + project-wins unchanged (`:58-105`). **stdin JSON is now the primary contract** (`{event,tool,input,sessionId,cwd,status,step}`), env vars kept as convenience; payload written then `stdin.end()` so a hook never hangs on EOF, write errors ignored (`:182-247`). Tool-event hooks run per call via `hooksForEvent` at the pre- and post- call sites (`runtime.ts:1154-1180, 1263-1276`). Lifecycle wiring:
- **sessionStart** — loaded once (`runtime.ts:367-378`); runs before step 1; **non-zero exit aborts the run** with status `blocked` + `session_blocked` bus error, no step spent (`:454-472`).
- **stop** — fires after each agent step (`runtime.ts:1347-1349`).
- **sessionEnd** — best-effort, in the REPL/headless caller, never affects exit (`repl.ts:963-975`; `runSessionEndHooks` in `hooks.ts:245-279`).
- **`--bare` skips hooks entirely** (load + lifecycle, `runtime.ts:364-379`) for deterministic runs.

**CC side re-grounding:** CC's hook surface is far larger (SessionStart/End, per-turn UserPromptSubmit/Stop/Failure, Pre/PostToolUse/Failure, PostToolBatch, Permission Request/Denied, SubagentStart/Stop, Pre/PostCompact; matchers; stdin JSON; command+HTTP+MCP+prompt types). Klyro now *structurally matches* the stdin-JSON + matcher + sessionStart-gate concepts, but still has **5 events vs CC's 15+** and no HTTP/MCP hook types [Grounded-Behavior-CC, hooks reference, prior round].

Update: prior Round 21's verdict "CC leads decisively" and Risk #4 are **moved to "converging"**. Klyro matches each: stdin JSON parity, matcher parity, a *blocking* sessionStart gate CC lacks, sessionEnd parity. Remaining gaps: event breadth (no Subagent/Compact/Permission), HTTP/MCP hook types, exit-2-with-feedback vs 0/abort.

**Takeaway:** hooks are no longer the weakest quarter — the invented `sessionStart` pre-flight gate is a small Klyro advantage. **CC still leads event breadth.**

### Round 22 — MCP client stack (UPDATE: remote transport + prompts)

**What changed:** two of the prior round's "no X" items landed. **Remote Streamable-HTTP transport** — `RemoteMcpClient` (`mcp/remote.ts:31-161`): POST JSON-RPC over HTTPS, `${env:VAR}`-expanded headers (`remote.ts:41, from config.ts:106-111`), SSE-bodied responses parsed (`parseSseBody` `:17-29`), protocol `2024-11-05`, 30s default timeout + caller abort; typed errors `INVALID_SPEC/TIMEOUT/HTTP_ERROR/SERVER_ERROR/PROTOCOL_ERROR/IO_ERROR/ABORTED` (`:128-155`). Spec now `command` XOR `url` (+ `headers`), enforced by a `superRefine` that fails *both* and *neither* (`config.ts:23-45`); `McpClient` ctor fails fast on a url-less command (`client.ts:88-93`); `makeMcpClient()` routes stdio vs remote (`registry.ts:172-180`). **Prompts** — `prompts/list`+`prompts/get` on both stdio (`client.ts:33-38, 194-230`) and remote (`remote.ts:83-106`); unsupported → `[]` for list, error for get. Consumed as first-class slash commands.

**Remains absent:** OAuth, servers-with-configurable auth, pure-SSE GET streams (probe reports this explicitly, `remote.ts:5-9`), resource mutation, sampling/roots.

**Divergence (1.0.5 #7 "stdio-only MCP, no remote/SSE/OAuth" → partial).** The prior takeaway "Klyro leads posture, CC leads reach" narrows to "leads reach on OAuth/SSE only."

**Takeaway:** remote + prompts materially broaden MCP reach while keeping deny-by-default posture + redact + 12k truncation (`registry.ts:59,154-160`).

### Round 23 — MCP serve + registry operations (UPDATE: prompt-commands)

**What changed:** the pure reverse-direction `handleMcpRequest` service is unchanged (`serve.ts`), but a **new consumer path** makes MCP *renderers* first-class: `/mcp__<server>__<prompt> [args…]` expands and runs the resolved prompt text through the normal bridge (`repl.ts:2671-2686`), backed by `runMcpPrompt()` (`registry.ts:356-382`): fresh connection per invocation, **redacted output capped 8k**, explicit typing = consent so project servers connect without the registration-time trust gate. Prompt *arguments* are positional (`arg1, arg2, …` + `input`), untyped.

**Remains absent:** prompt autocomplete/frontmatter param declarations, resources-as-commands, sampling.

Update: prior Round 24 "MCP prompts absent" is no longer true — still **[Verified-Absent]** as *autocomplete-inventory* but *present* as run-on-demand slash expansion. The capstone "no MCP promresults" item is closed.

**Takeaway:** MCP *renderers* (prompts→commands) now exist; MCP *interaction* (resources/sampling) remains a gap.

### Round 24 — Slash command system (UPDATE: file-based commands + @-completion)

**What changed:** two of the prior "extensibility" gaps closed. (1) **File-based custom commands** — `.klyro/commands/*.md` + `~/.klyro/commands/*.md`, project-wins, frontmatter `name`/`description|hint` + body, `$1..$9` + `$@` expansion with missing→`''`, and a **recursion depth guard (max 3)** (`cli/slash/custom.ts:57-70, 105-124`; dispatch + guard in `repl.ts:2659-2670`). (2) **`@` file completion** — a `listCompletableFiles()` walker (ignores `node_modules/.git/dist/…`, depth-cap 1000 entries, directories trailing `/`, top-level dotfiles completable but never traversed — `custom.ts:126-167`) feeds a fuzzy `@path` suggest in the TUI (`app.tsx:699-738`, path suggestions rendered at `app.tsx:1067-1075`); merged `suggestCommands(prefix, limit, extra)` pools custom + builtins (`parser.ts:470-482`). Custom commands surface in `/` autocomplete (`app.tsx:699-714`).

**Remains absent:** versioned/scoped command files, skill directories with `metadata`, MCP prompt schema-typed params, declarative args typed in frontmatter.

Update: prior Round 24's-leading gap — "no versioned command files… third-party packs can't plug in" — is **resolved** (open files + args + recursion guard). The residual is Cmd/C-skills *typed-parameter* rigor, not discoverability.

**Takeaway:** slash surfaces are now open on both axes CC has (custom commands + user files); Klyro differs in treating commands as *prompt-text expansion* rather than *mounted skills* with declarative params.

### Round 25 — Memory system (UPDATE: "memory trio")

**What changed:** three memory gaps closed against the capstone's move #5. (1) **Tail-loss · rotation**: on exceeding the 4k steady-state, the *dropped head is archived* to `<dir>/archive-<stamp>.md` and the archive set is pruned to the latest 20 — no more silent loss (`memory.ts:29-49`, `MEMORY_STEADY_STATE_CHARS` `:18`). (2) **Dead reminder helpers → wired**: `shouldRemind(turn,last)` + `reminderForTodos()` were defined-but-unused in 1.0.5; the runtime now calls `shouldRemind` every ~20 turns (`runtime.ts:511-536`) and re-injects pending `todo_write` items as a `[system note]` checkpointed message (`lastRemindTurn` at `:323,511-512`, todos read from `.klyro/plans/todos.json` `:516-524`, bad/absent file silently skipped `:534`). (3) **Human write path**: `/memory append <text>` (`parser.ts:180-183`) uses the *same* redact + atomic tmp+rename+fsync path as the `memory_write` tool (`repl.ts:1052-1065`, `memoryWrite`).

**Remains absent:** signposting/significance rankings (CC auto-memory), memory *search/injection into child/subagent scopes*, a global store; summarization of archives is explicitly deferred (`memory.ts:36-37`).

**Divergence (1.0.5 #2 dead reminders + #3 silent tail-loss → both resolved).**

**Takeaway:** the memory module is no longer "durable-but-dumb." It is durable-with-a-wastebasket, self-reminding, and human-writable. **CC still leads** on system memory *discovery* (hierarchical + ranked).

### Round 28 — Headless & exit-code contract (UPDATE: stable `kind:result` envelope + `--bare`)

**What changed:** the two headline items from the prior takeaway. (1) **Stable `kind:result` envelope** — `emitEnvelope(exitCode, …)` emits exactly one line per run in json mode after all legacy per-status lines, carrying `{status, exit_code, text, steps, toolCalls, cost_usd, usage, verification?, session_id?}` (`run.ts:490-510`); all status branches route through it (`:511-548`). The per-status `kind:final` lines are *kept for compat* and the `kind:cost` line precedes it; the headless grade now specifies **"read the LAST line."** (2) **`--bare`** — run-level flag (17 source sites across `index.ts`/`run.ts`/`runtime.ts`): skips MCP (`run.ts:217-245`), hooks (`runtime.ts:364-379`), memory/KLYRO.md/L6 (`run.ts:566,606-610`, `makeRunSystemPrompt` returns `base` when bare), session persistence (`run.ts:248-249`), and the post-run notification/cleanup block (`run.ts:443-445`) — model gets *base system prompt + tools only*. (3) `--temperature` and `--max-tokens` are now accepted headless (`index.ts:68-70`), threaded to the adapter via `RunCliOptions` (`run.ts`). (4) In the REPL path, cost is computed once via `estimateCost()` and surfaced in the same additive `kind:cost` JSONL shape (`run.ts:480-486`).

**CC-side inversion-landmark:** CC's `--bare` determinism flag is [Grounded-Behavior-CC]; with #1 and #2 Klyro now deliberately *matches* that contract (`--bare` + LAST-line result envelope ≈ CC `--bare` + single `type:result`).

Update: prior Round 28 #1 "internal-shaped JSONL, no committed envelope; no --bare" → **both resolved**; #6 "file-transcript vs session-store resume" still stands. Notably the envelope *also* closes the cost-before-final two-line parse concern (a parser may read last line only).

**Takeaway:** Klyro reached CC-level stable machine output + determinism. The result envelope is richer than CC's (additive `exit_code/verification`); lineage remains for compat.

### Round 31 — Eval harness (UPDATE: model-graded judge)

**What changed:** the prior "no model-graded judge" and takeaway "Klyro leads machinery, CC leads signal" — a judge lands. New opt-in `judge.rubric: string[]` on ScriptedTask (`harness.ts:44-48`); `runTask` grades semantic rubric via a live judge adapter when supplied, else records `skipped` (`harness.ts:114-141`). `runJudge` (`judge.ts:41-86`) streams to any `ProviderAdapter`, asks for `{scores:{cN:1|0},notes}` JSON only, and is **fail-closed** — unparsable output or a call error yields `pass:false` with a reason, never a silent pass (`judge.ts:36-40,68-76`); empty rubric → pass immediately (`:47`). CLI: `klyro eval --judge-model <id>` builds an `httpChatAdapter` from env/stored key for the judge (`eval.ts:170-181`). 3 new structural fixtures with real FS asserts (`t7`/`t8`/`t9` in `eval/tasks.ts:101-235`); TaskResult carries `judge{pass,notes,skipped}` (`harness.ts:57-60,E`).

**Remains absent:** a clean *offline* judge (mock `runJudge` needs a real endpoint+key — the bundled mock adapter can cycle tool_text but there's no canned high-level judge script), rubric per-jsonl-scenario wiring, judge-cost telemetry.

Update: prior Round 31 #5 "judge: None" → present. Klyro's harness now has both structural asserts *and* semantic grading, the two signals CC covers only via live runs + human/CI review.

**Takeaway:** Klyro's eval is now a complete three-layer gate (structural + FS-verify + semantic judge); `--judge-model` gives live-model similarity without sacrificing replay determinism — worth noting the judge path runs a *live* adapter, so it lives in the "CI" lane, not the offline replay lane.

### Round 34 — Approval UX (UPDATE: real edit-and-retry)

**What changed:** the prior HIGH "`e` (edit) is a dead label mapping to deny" and the capstone move #4 — shipped as a real bounded loop. `ApprovalChoice` gains `{kind:'edit'; editedInput}` (`approval.ts:17-32`); the TUI modal intercepts `e` to open an **inline JSON editor** with Enter-submit/Esc-back, JSON validation + must-be-object errors (`approval.tsx:92-121, 132-143, 181-187`); the stdin prompt keeps `e`→deny since it has no editor (`approval.ts:61-72`, NOTE comment). Runtime: an `edit` choice re-`safeParse`s the edited input against the tool schema (malformed → structured `POLICY_DENIED` + `edit_invalid`, no execution — `runtime.ts:1103-1122`), then **re-enters the policy loop on the edited input** up to `round < 3`; on approval the *executed + checkpointed* input is the approved edited one (`runtime.ts:1047-1129`); 3-round exhaustion → `POLICY_DENIED` without running (`:1129-1138`). Pattern-approval cache **does not cache an edited call** (`approval.ts:129-137`) so the re-evaluated call prompts on its own.

**CC side re-grounding:** CC's edit-and-approve compares tool calls with visible diffs and supports a rejection/feedback loop; Klyro's is a raw-JSON-inline editor. **Behavioral parity** (edit→re-validate→re-run) reached; **UX** (JSON buffer vs structured diff) leans CC [Inferred-Design-CC].

Update: prior Round 34 #1 "dead `e` label" → resolved; #2 "no diff screen" & #4 "double-sanitized prompt" stand; #6 "no focus restore" stands.

**Takeaway:** the edit-retry path is real and bounded (3), schema-guarded, typed, and cache-correct — a genuine safety improvement over both the 1.0.5 grounded denial and, arguably, an unbounded CC retry. **CC leads** on the authoring UX (diffing), Klyro on the bounded-safety property.

### Round 19 — Orchestration (UPDATE: open agents + moved-abort; NEW: providers)

**What changed:** (1) agents open (see Round 3 update) riding the exact capability-narrowing machinery (`capabilities.ts` unchanged; custom tools dropped with reasons at spawn). (2) The `abortOnParent: undefined` stub — the prior LOW — is *still declared-but-inert at the orchestrator def* (`orchestrator.ts:476` stays `abortOnParent: undefined`); real abort remains in `TaskManager` (unwired to orchestrator). **Not resolved in 1.0.6.** (3) Provider *registration* is now closed to one file — see below.

**NEW — providers consolidation (was Phase 0 / Round 36 machinery):** `providers/endpoints.ts` is the **single registration point** the 1.0.5 capstone asked for ("no single registration point"). One entry holds `id/label/kind(baseURL/defaultModel/probePath/apiKeyEnv)` (`endpoints.ts:16-31`); 6 builtins (`:33-82`); `registerEndpoint()` allows programmatic/enterprise providers at runtime `:92-95`; `localProbeEndpoints()` derives the probe list (`:111-113`); `inferProviderId()` guesses id from host (`:119-134`). `providers.ts` now *derives* its local-probe list from the registry (`providers.ts:19-28,105-119,160-187`) instead of a hardcoded array — **adding a local server anywhere updates probing automatically**. Pricing stays model-keyed in `model-info.ts` (unified touch → one file, but a *second* place still knows provider names). `estimateCost` imported by `run.ts:28` for the REPL/headless cost line. Provider **default wire kind** (`openai-compatible` vs `anthropic`) is now explicit per entry — `endpoints.ts:14,43-48` — though `providers.ts` adapter selection is unchanged. (This is the resolution of 1.0.5 Round-36 divergence #6 and capstone "unify provider registration".)

### Round 30 — Auth & commit (UPDATE: gradient) — no change in 1.0.6
No auth/commit files in the delta. Prior Round 30 stands.

### Round 35 — Checkpoints (UPDATE: rewind menu equivalent)
`listCheckpointInfo()` (`checkpoints/store.ts:141-169`) powers numbered `/rewind <n>` with a **real rewind menu**: bare `/rewind` lists snapshots (1 = latest) with `id·files·age`; `/rewind <n>` restores `n`-back; `/rewind <n> summary` also reports the reverted working-tree files (captured via `git status --porcelain` pre-restore) (`repl.ts:1128-1163`); `/undo <n>` (`repl.ts:1118-1127`). CC's menu is interactive (Esc×2 → 6 actions incl. summarize-from-here), Klyro's is a numbered-arg *command* — same restore function, different interaction [Grounded-Behavior-CC]. Audit chain, raw-vs-redacted split, stub `diff(id)` all unchanged.

### Round 18 — Bootstrap / first-run (UPDATE: standalone init)
`klyro init` is now a first-class CLI subcommand (`index.ts:207-224`, wired to `initProject`), **shared** with REPL `/init` (`repl.ts:1352-1368` now delegates to the same `src/cli/init.ts` module, de-duplicating the old inline copy). `initProject` creates KLYRO.md (scan-seeded, `init.ts:29-50`) + `.mcp.json` skeleton (`:51-57`), never overwrites, and prints `nextStepsText()` (`:61-68`). CC's `/init` interactive multi-phase onboarding is richer [Grounded-Behavior-CC]; Klyro now at least exits the REPL.

### Round 26/27 — TUI & vim (UPDATE) — covered inline in Phase 0 balloon; see "8" note below.

---

## Phase 2 — Cross-cutting audit (1.0.6 residual)

**Risk register — resolved by 1.0.6 (with where):**
| Prior risk | Status in 1.0.6 |
|---|---|
| #1 `e` edit dead label → deny | **Resolved** — real bounded edit-retry (`runtime.ts:1047-1138`, `approval.tsx:92-143`) |
| #2 Dead `shouldRemind`/`reminderForTodos` | **Resolved** — wired every ~20 turns (`runtime.ts:511-536`) |
| #3 Memory 4k silent tail-loss | **Resolved** — archived to `archive-*.md`, pruned to 20 (`memory.ts:29-49`) |
| #4 Hooks matcher-less / 2 events / env-only | **Resolved** — matchers + stdin JSON + 5 events (`hooks.ts:31,165-247`) |
| #5 Closed agent registry | **Resolved** — `.klyro/agents/*.md` open (`custom-agents.ts`) |
| #6 orchestrator `abortOnParent: undefined` | **UNRESOLVED** — still declared-inert (`orchestrator.ts:476`) |
| #7 stdio-only MCP, no remote/SSE/OAuth | **Partial** — remote HTTP + prompts land; OAuth/SSE remain absent (`remote.ts`) |
| #8 Internal JSONL, no envelope; no --bare | **Resolved** — `kind:result` + `--bare` (`run.ts:490-548`) |
| #9 Triple runtime + dual session + ignored globals | **Partial** — session namespaces merged; TUI/chat/REPL + ignored globals stand |
| #10 Uncapped snapshots/unsigned/no-fsync/stub diff | **UNRESOLVED** — all stand (`checkpoints/store.ts`, `audit.ts`) |

**New residual top-10:**
| # | Risk | Severity | Location | Fix |
|---|---|---|---|---|
| 1 | `orchestrator.abortOnParent: undefined` still declared-but-not-threaded (children rely on `TaskManager`) | LOW | `orchestrator.ts:476` vs `task-manager.ts` | Thread parent `AbortSignal` through |
| 2 | Hook `sessionStart` gate is hard-blocking; no hook *timing* budget across a run (each 30s default, sequential) | MED | `runtime.ts:454-472`, `hooks.ts` | Aggregate deadline / concurrency caps |
| 3 | MCP remote lacks OAuth + pure-SSE GET servers (content-negotiation picks SSE-bodied POST only) | MED | `mcp/remote.ts:120-149` | Add SSE transport + auth fields |
| 4 | Custom-command args positional+untyped; MCP prompt args `argN`/`input` convention hidden | MED | `repl.ts:2671-2686`, `custom.ts:65-70` | Frontmatter-declared params + arg interpolation |
| 5 | `klyro eval --judge-model` requires a *real* live endpoint — the offline replay lane can't grade semantics | LOW-MED | `eval.ts:170-181`, `judge.ts:41-86` | Mock/vcr judge from prior transcript |
| 6 | Uncapped snapshots + unsigned audit chain + audit-without-fsync + stub `diff(id)` | MED | `checkpoints/store.ts:142-155`, `audit.ts | Caps + signatures + fsync + real diff |
| 7 | `/rewind` captures pre-restore dirty tree via `git status` only when `summary` given — non-git cwd yields `commands=` restores with no report | LOW | `repl.ts:1133-1156` | store pre-dirty in snapshot meta |
| 8 | `makeRunSystemPrompt(bare)` returns the caller's base verbatim — L6-scan context is the same import graph, `--bare` silently reuses a possibly-stale global L6 cache | LOW | `run.ts:606-610`, `context/level6.ts:184-217` | Bypass cache in bare |
| 9 | `FakeRemoteMcpClient` SSH/`env`/`headers` all run through `expandEnv` — unset → `''`, symmetric — but an unresolvable `${env:X}` silently becomes the literal string in a header (same wart as `env`); low impact | LOW | `config.ts:63-65` | Validate env-templates before load |
| 10 | TUI `@`-complete + command files add sync `readdirSync` walks on every render (`useMemo` by cwd) | LOW | `custom.ts:133-167`, `app.tsx:699-738` | Debounce / incremental index |

**HIGH-severity findings (1.0.6 rigor):** **None outstanding.** The prior four MEDs (edit-path, matcher-less hooks, memory tail-loss, closed registries) are all resolved by verified behavior + the 920-green test pass. Nearest remaining: MCP OAuth/SSE reach (MED), hooks sessionStart hard-blocking (MED).

**Known flakes:** none observed confirmed in this run (920/920, 68.55s, exit 0). Prior timing-sensitive candidates unchanged in kind; the vim count/word/`dd` additions widened the input-state surface but are covered by new `app.test.tsx` cases.

**Documentation gaps (residual 1.0.6):** remote-MCP header/`${env:VAR}` semantics; custom-agent/custom-command file format has no checked-in example (both are convention-only, `custom-agents.ts:3`, `custom.ts:3-9`); the `kind:result` LAST-line ordering is a comment not a doc (`run.ts:488`); hook `sessionStart` abort-on-nonzero is behavior-only (hook schema comment `hooks.ts:6` implies it, but no README).

**Performance hotspots (residual 1.0.6):** `listCompletableFiles` + `loadCustomCommands` run synchronously per render in the TUI (`app.tsx:699-738`) — bounded at 1000 entries but `readdirSync`-per-keystroke on a cold cache; checkpoint dir is still uncapped; the 10k bus history halving amortizes fine (unchanged).

---

## Phase 3 — Capstone (1.0.6 synthesis)

**12 load-bearing dimensions, Klyro 1.0.6 order:** turn loop · policy tree (+ edit-retry) · **extensibility surfaces (agents/commands/hooks)** · provider streaming + **single registration** · context budget · verification sub-loop · **headless contract (envelope + `--bare`)** · session/audit durability · MCP reach (stdio+remote+prompts) · memory (archive-rotate + self-remind) · interrupt/abort · TUI input (vim counts/words/@-complete).

**4 deepest structural asymmetries (updated):**
1. **Verification-as-code vs advice** — Klyro's bounded classified repair + exit-8 remains its cleanest, most-structural lead; no CC change in this window.
2. **Extensibility surfaces now CONVERGE in shape, diverge in semantics** — open agent/command files on both; Klyro = prompt-text expansion + code *intersection* narrowing, CC = mounted skills/subagent memory/HTTP. Shape gap closed, capability gap narrower.
3. **Provider world:** open dual-adapter + local probe + one-file registration vs CC's closed managed + Bedrock/Vertex + OAuth/keychain. Klyro's breadth *deepened*; CC's depth/credential story unchanged.
4. **Durability vs fluidity (unchanged + widening in headless):** Klyro matched CC's `--bare` + result envelope, *and* added a sha/audit chain CC still has no counterpart to; CC's checkpoint/rewind *menu UX* is now the one remaining polish lead after Klyro's `/rewind <n> summary`.

**7 highest-leverage moves for Klyro (next):** (1) MCP OAuth + SSE + prompt *autocomplete*; (2) hook subagent/compact/permission events + aggregate hook budget; (3) `--bare` L6-cache bypass + a *bare* variant for the eval replay lane; (4) frontmatter-typed custom-command params; (5) checkpoint caps + signed chain + real per-snapshot diff (replace the `git status`-in-rewind stopgap); (6) an offline/vcr eval judge for `rubric` without a live endpoint; (7) canonicalize TUI (drop legacy chat/REPL) + honor-or-drop the ignored globals on `-p`.

**7 inverted moves for CC (hypothetical, if it wanted Klyro's open-world guarantees):** (1) bounded classified verify loop + exit codes; (2) hash-chained offline audit artifact + one-command verify; (3) an *open* OpenAI-compatible + local-probe adapter layer; (4) commit-time diff secret gate; (5) worktree-per-writer two-phase apply; (6) pure child-capability intersection with surfaced `dropped[]` reasons; (7) checked-in structural eval + `eval:compare` (Klyro still leads *machinery*; CC leads *reach* via skills/autocomplete/OAuth).

**Distillation (updated, one paragraph):** In 1.0.6 Klyro executed most of its own 1.0.5 capstone — open registries, matcher+stdin hooks, stable envelope + `--bare`, bounded edit-retry, memory rotation + self-reminder, single provider file, remote MCP + prompts, model judge, first-class init, and a real rewind menu — and in doing so *closed the extensibility gap* while preserving (and partly widening) its structural leads: verification-as-code, hash-chained audit, capability intersection, commit gate, worktree isolation, and now deterministic headless output. What remains asymmetrical is no longer "closed registries vs open," but *depth of reach* — CC owns OAuth/keychain auth, mythos-scale managed providers, interactive diff-backed approval, checkbox auto-memory, and skill autocomplete — against Klyro's *auditability and agency over its own runtime*: every loop, verdict, byte, and cent typed, persisted, re-checkable, and now user-extensible from disk. Each side still wins what the other would have to rebuild; 1.0.6 just moved the boundary a full release toward the middle.

---

## Where the verbatim text lives

- This document is a *superseding addendum*: rounds verified against the 1.0.6 tree are updated inline; rounds unaffected by 1.0.6 (1, 4, 5, 6, 8, 9, 11, 12, 13, 15, 16, 17, 25-baseline, 27-baseline, 28-baseline, 29, 33, 34-baseline, 35-baseline) retain their 1.0.5 wording in `comparison.md`.
- Evidence: all `[Verified-Code-Klyro]` file:line references below were Read or grep-verified live this session from the 1.0.6 working tree. CC-side claims remain [Grounded-Behavior-CC] / [Inferred-Design-CC] exactly as marked in the 1.0.5 rounds, re-grounded here only where the 1.0.6 change makes the comparison sharper.
- Phase 0 + all prior-round verbatim for 1.0.5 is unchanged and lives in `comparison.md` (and `comparison.md.bak`, identical). `comparison.md.bak.pre-1.0.3` preserves the pre-1.0.3 artifact.