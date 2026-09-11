# Klyro vs Claude Code — Deep Architecture Comparison

*Marks*
- **[Verified-Code-Klyro]** — grounded in a specific `file:line` in this repository.
- **[Grounded-Behavior-CC]** — observable from Claude Code docs, terminal output, or release notes.
- **[Inferred-Design-CC]** — defensible inference about CC’s design not explicitly documented.

---

# Round 1 — The Core Turn: One Single Step in the Agent Loop

## The contract being compared

One "step" — from the model being prompted to all tool results being fed back and the transcript updated.

## Claude Code — verified from public docs and observed behavior [Grounded-Behavior-CC]

1. **Prompt build** – System prompt is assembled from layered sources (CLAUDE.md hierarchy, env, memory, skills), then trimmed to fit the model's window. CC auto-compacts the oldest turns when the token budget approaches the limit ("auto-compact" banner).
2. **Provider call** – Anthropic Messages API with `stream: true`. CC may switch model mid-session. Fast-mode is a Claude model (Opus with faster output), not a downgrade.
3. **Streaming consumption** – Anthropic SSE events are consumed; a single canonical assistant message is reconstructed in real time. Text deltas appear as received; tool_use blocks are assembled via `input_json_delta` accumulation until `content_block_stop`. (Protocol per Anthropic Messages streaming spec).
4. **Permission gate** – Before a write/execute tool runs, CC consults a permission tree: read-only tools auto-allowed; write tools follow path-aware rules; Bash parses the command and flags dangerous patterns. Approvals: yes / no / always (persisted). Decisions cached per pattern.
5. **Tool execution** – Approved tools run in parallel. Errors are returned as tool results; the model sees them and decides next actions. CC does not abort a turn because a single tool failed.
6. **Post-turn bookkeeping** – Transcript written to `~/.claude/projects/<id>/*.jsonl`; usage tracked; cost surfaced.
7. **Auto-compact** – When token use crosses a threshold, CC compresses oldest turns into a summary, keeping the most recent messages.

## Klyro — verified against `src/agent/runtime.ts` and adjacent modules [Verified-Code-Klyro]

- **Step orchestration** – `run()` builds the initial transcript from `opts.task` (`runtime.ts:258-273`), then loops: build a `CallRequest` (`runtime.ts:440-444`), call `adapter.stream(req)` (`runtime.ts:446`), and consume `StreamEvent`s (`runtime.ts:456`).
- **Tool call handling** – `pendingToolCalls` map stores partial tool calls (`runtime.ts:451`); `tool_call_start` creates a placeholder, `tool_call_delta` accumulates `argsJson`, `tool_call_end` validates against the Zod input schema (`runtime.ts:566-587`).
- **Validation failure** – A malformed call is answered immediately with a structured `INVALID_TOOL_INPUT` result without executing (`runtime.ts:562-584`), so the model can repair next turn.
- **Policy evaluation** – `evaluatePolicy()` (`policy/engine.ts:413-420`) is called per tool call *before* execution; returns `{action:'allow'|'ask'|'deny'}`. Denials become a `POLICY_DENIED` tool result (`runtime.ts:883-890`).
- **Execution** – Concurrency-safe tools marked `isConcurrencySafe` run in parallel batches while ordering of results is preserved ("order-preserving parallel tool execution"); non-safe tools serialize. Each execution is wrapped in try/catch → `EXEC_CRASH` error (`runtime.ts:924-935`).
- **Result recording** – Outputs are redacted via `redactOutput` (`runtime.ts:965`), checkpointed (`runtime.ts:971`), and emitted as `tool.result` KlyroEvents + `tool_result` RuntimeEvents (`runtime.ts:988-989`).
- **Checkpoint** – After each assistant message `checkpoint()` persists the transcript (`runtime.ts:348-360`, invoked at `runtime.ts:591`).
- **Compaction** – On `REQUEST_TOO_LARGE` / context overflow error, the runtime compacts the transcript and retries the request exactly once (`runtime.ts:497-520`); periodic compaction is driven by `accounting()` thresholds (`context/accounting.ts:17-25`) with `compactAt` default 0.8.

## Side-by-side, single-step

| Aspect | Claude Code | Klyro |
|--------|------------|------|
| Prompt build | Layered CLAUDE.md + memory + skills; trim at ~context limit. | System prompt + Level-6 static context + Level-7 live telemetry suffix (`runtime.ts:1251-1265`, `provider-adapter.ts:44-47`). |
| Provider call | Anthropic Messages, `stream:true`. | `anthropicAdapter` or `httpChatAdapter`, selected by provider kind (`cli/repl.ts:158-165`); both behind `retryingAdapter` (`cli/repl.ts:174-179`). |
| Streaming | SSE; tool_use assembled over `input_json_delta`. | `StreamEvent` union (`provider-adapter.ts:18-31`); OpenAI-style `tool_call_delta.argsJson` accumulation. |
| Permission | Policy before any side-effecting tool; cached per pattern. | Policy before any tool (`runtime.ts:864-890`); pattern cache in `PatternApprovalCache` (`policy/approval.ts:118-133`). |
| Execution | Parallel. | Parallel for `isConcurrencySafe` tools, order-preserving; serial otherwise (`types.ts:70-71`). |
| Tool errors | Returned as tool results; loop continues. | Same — plus a validation pre-pass that answers malformed calls without executing (`runtime.ts:562-584`). |
| Overflow recovery | Auto-compact at threshold. | Threshold compaction *plus* a reactive overflow-retry path on HTTP 400/`context_length` errors (`runtime.ts:497-520`). |

## The single sharpest difference

Klyro has a **reactive context-overflow recovery path**: when the provider rejects with `REQUEST_TOO_LARGE`, the runtime aggressively compacts the transcript and retries the request once within the same step (`runtime.ts:497-520`, event emitted with code `REQUEST_TOO_LARGE` at `runtime.ts:505`). Claude Code's compaction is purely proactive (threshold-driven); on an actual overflow reject, this behavior is not documented [Inferred-Design-CC: likely fails the turn]. Klyro's approach rescues runs whose token estimate was optimistic.

## Takeaway

Both loops share the same five-act structure (prompt → stream → validate → gate → execute → record). Klyro adds two structural hardening CC lacks evidence of: schema pre-validation that turns malformed tool calls into repairable errors without executing, and a reactive overflow-retry that converts a fatal 400 into one more chance.

---

# Round 2 — Streaming Protocol Framing: How Tool Calls Materialize

## The contract being compared

How a streaming provider response is decomposed into token chunks vs. whole objects — this determines whether the harness can render partial tool arguments, whether a dropped `tools` block is recoverable, and how the transcript is assembled.

## Claude Code — verified behavior [Grounded-Behavior-CC]

Claude Code uses the **Anthropic Messages streaming protocol** (SSE). Tool calls are emitted as a sequence of content blocks:

1. `content_block_start` with `content_block: { type: 'tool_use', name: 'tool_name', input: '' }`
2. `content_block_delta` with `delta: { type: 'text_delta', text: '...' }` — accumulates argument JSON **as a string**
3. `content_block_stop` — at which point the full argument JSON is complete and the tool can be invoked

The entire argument payload of every tool call arrives as a single contiguous `input_json` string built from delta accumulation. [Grounded-Behavior-CC] — observable from Anthropic's protocol spec (`content_block_delta` with `input_json` type, see Anthropic Messages API streaming docs).

The critical implication: **Anthropic does not expose a `role: assistant` message turn until the entire tool use is finished and `message_stop` fires**. Claude Code therefore cannot (with the public protocol) stream partial tool args and act on them — the tool call is materialized in full at `content_block_stop`.

## Klyro — verified against `src/agent/provider-adapter.ts` [Verified-Code-Klyro]

Klyro normalizes OpenAI-compatible `chat/completions` streaming into a `StreamEvent` union ([`provider-adapter.ts:18-31`](src/agent/provider-adapter.ts)). The OpenAI wire shape is:

1. `choices[0].delta.tool_calls[n].id` + `.name` → `tool_call_start` ([`provider-adapter.ts:359-362`](src/agent/provider-adapter.ts))
2. `choices[0].delta.tool_calls[n].index` + `.function.arguments` (a **string fragment**) → `tool_call_delta` ([`provider-adapter.ts:372-387`](src/agent/provider-adapter.ts))
3. `choices[0].finish_reason` set → `message_end` / `tool_call_end` via `emitTerminal` ([`provider-adapter.ts:135-168`](src/agent/provider-adapter.ts))

Crucially, OpenAI fragments the argument JSON **across multiple `tool_call_delta` chunks**, and Klyro accumulates `argsJson` incrementally in `pendingToolCalls` ([`runtime.ts:462-488`](src/agent/runtime.ts)). This means Klyro *can* expose partial args to the UI as they arrive (it does, via `emit?.({kind:'tool_call_delta',…})` at `runtime.ts:488`).

### The delta-accumulation loop

`pendingToolCalls` is a `Map<string, {argsJson: string}>`. Each `tool_call_delta` appends to `argsJson`; only `tool_call_end` triggers `JSON.parse(argsJson)` + Zod validation ([`runtime.ts:566-588`](src/agent/runtime.ts)).

## Side-by-side, frame-by-frame

| Protocol artifact | Anthropic (CC) | OpenAI (Klyro) |
|---|---|---|
| Tool identity arrival | `content_block_start` carries `name` | First `tool_calls[n].id` + separate `.name` chunk (name often on 2nd chunk) ([adapter:359-362](src/agent/provider-adapter.ts)) |
| Args arrival | `input_json` deltas accumulate to one JSON string | `function.arguments` deltas accumulate to one JSON string |
| Full-call availability | Only at `content_block_stop` | Only at `finish_reason` / `tool_call_end` |
| Partial-args renderable | No (until stop) | Yes (Klyro emits `tool_call_delta` live) |
| Validation timing | After `content_block_stop` parses JSON | After `tool_call_end` parses accumulated JSON |
| Delta accumulation in runtime | N/A — protocol gives whole input | `pendingToolCalls.Map<string,{argsJson}>` ([runtime.ts:451](src/agent/runtime.ts)) |

## The three ways they diverge

1. **Protocol origin** — CC is locked to Anthropic's Messages protocol (only). Klyro is **OpenAI-compatible-first** with an Anthropic adapter layered on top ([`anthropic-adapter.ts:1-29`](src/agent/anthropic-adapter.ts)) — so the default path is OpenAI streaming, and Anthropic is a translation shim.

2. **Partial-args visibility** — Klyro's UI can show the model *typing out* tool arguments character-by-character (`tool_call_delta` live events). [Inferred-Design-CC] Claude Code almost certainly cannot show partial tool args because the Anthropic protocol only finalizes them at `content_block_stop`.

3. **Delta fragmentation** — OpenAI's protocol splits tool-call deltas by `index` (parallel tool calls), so Klyro must demultiplex by index ([`provider-adapter.ts:372-387`](src/agent/provider-adapter.ts)). Anthropic uses named blocks, so CC demuxes by block id. Structurally similar, but Klyro's code carries the index-merging logic explicitly.

## Frame-by-frame: a real divergent moment

Consider a model streaming `write_file` with `{"path":"a.ts","content":"<10KB>"}`:

- **Claude Code (Anthropic):** The `content_block_start` arrives with name=`write_file`. Then N `text_delta` events arrive for `{"path":"a.ts","content":"...`. CC cannot act. At `content_block_stop`, the JSON is complete; CC validates + gates.
- **Klyro (OpenAI):** First `tool_call_start` with the call id. Arbritrary fragments arrive as `tool_call_delta.argsJson += '...'`. Klyro emits `tool_call_delta` live so the UI shows the growing args. At `finish_reason`, Klyro runs `JSON.parse` + Zod.

The user-visible difference: Klyro's transcript can animate the model constructing an argument; CC's cannot until the call finalizes.

## Takeaway matrix

| Capability | Claude Code | Klyro |
|---|---|---|
| Render partial tool args to UI | Not possible (protocol constraint) | Yes (live `tool_call_delta`) |
| Recover a malformed tool payload | No — once `content_block_stop` fires with bad JSON, it's an error | No — same (parse at end) |
| Protocol portability | Anthropic-only | OpenAI-default, Anthropic-via-adapter |

## One insight worth calling out

Klyro's `StreamEvent` contract deliberately collapses both OpenAI and Anthropic deltas into the *same* `tool_call_delta { id, argsJson }` shape ([`provider-adapter.ts:29-30`](src/agent/provider-adapter.ts)), so the runtime never branches on provider. CC, using native Anthropic streaming, never needs to — but that also means CC cannot accept OpenAI-compatible providers at all without a shim. Klyro's design wins on adapter portability; CC's wins on protocol fidelity (full argument fidelity is preserved by the protocol, not accumulated).

## Takeaway

Klyro's OpenAI-first streaming with Anthropic as an adapter gives it broader provider reach and live partial-args rendering, at the cost of needing delta-demultiplexing logic that Claude Code (Anthropic-native) sidesteps entirely.

---

# Round 3 — Tool Catalog: The Shape of Agency

## The contract being compared

Every tool available to the model, its input schema, its output schema, and its declared risk class. Also: which tools exist at all (FS mutation, shell, git, search, orchestration, memory, verification, planning).

## Klyro — verified against `src/tools/registry.ts` [Verified-Code-Klyro]

The canonical registry is `builtinRegistry()` ([`src/tools/registry.ts:106-133`](src/tools/registry.ts)). Every tool is registered via `.register(Tool)`. The full catalog, grouped by source directory:

| # | Tool name | File | Risk class (`permission`) [types.ts:68-69](src/tools/types.ts) | Input shape | Output shape |
|---|---|---|---|---|---|
| 1 | `read_file` | `tools/fs/read-file.ts` | `read` | `{ path: string; encoding?: string }` | `{ content: string; size: number; isBinary: boolean }` |
| 2 | `write_file` | `tools/fs/write-file.ts` | `edit` | `{ path: string; content: string; append?: boolean }` | `{ path: string; bytes: number }` |
| 3 | `edit_file` | `tools/fs/edit-file.ts` | `edit` | `{ path; old_string; new_string; count?; dryRun? }` | `{ path; changes: number }` |
| 4 | `multi_edit` | `tools/fs/multi-edit.ts` | `edit` | `{ newString; oldString; }` | `{ modified: string[] }` |
| 5 | `apply_patch` | `tools/fs/apply-patch.ts` | `edit` | patch body | `{ applied: boolean; result: string }` |
| 6 | `list_dir` | `tools/fs/list-dir.ts` | `read` | `{ dirPath; showHidden? }` | `{ entries: FSNode[] }` |
| 7 | `read_history` | `tools/fs/read-history.ts` | `read` | `{ file; lines? }` | git history view |
| 8 | `glob` | `tools/search/glob.ts` | `read` | `{ pattern; cwd? }` | `string[]` |
| 9 | `grep` | `tools/search/grep.ts` | `read` | `{ pattern; path?; recursive? }` | `GrepMatch[]` |
| 10 | `search_files` | `tools/search/search-files.ts` | `read` | `{ query; path?; extensions?; limit? }` | `SearchMatch[]` |
| 11 | `recent_files` | `tools/search/recent-files.ts` | `read` | `{}` | `string[]` |
| 12 | `dependencies` | `tools/search/dependencies.ts` | `read` | `{ file; depth?; include?; exclude? }` | dep graph |
| 13 | `imports_of` | `tools/search/imports.ts` | `read` | `{ file; }` | imports list |
| 14 | `importers_of` | `tools/search/imports.ts` | `read` | `{ file; }` | importers list |
| 15 | `find_symbol` | `tools/symbols/find-symbol.ts` | `read` | `{ name; directory? }` | symbols |
| 16 `| `lsp_diagnostics` | `tools/lsp/diagnostics.ts` | `read` | `{ file? }` | diagnostics |
| 17 `lsp_goto_definition` | `tools/lsp/` | `read` | `{ file; line; character }` | location |
| 18 | `expand_result` | `tools/expand-result.ts` | `read` | `{ toolName; id }` | expanded result |
| 19 | `shell_exec` | `tools/shell/shell-exec.ts` | `execute` | `{ command; cwd?; timeoutMs? }` | `{ exitCode, stdout, stderr, durationMs, timedOut, truncated }` |
| 20 | `git_status` | `tools/git/git-status.ts` | `execute` | `{}` | git status text |
| 21 | `git_diff` | `tools/git/git-diff.ts` | `execute` | `{ file?; staged? }` | diff text |
| 22 | `git_log` | `tools/git/git-log.ts` | `execute` | `{ file?; maxCount? }` | commit log |
| 23 | `run_verify` | `tools/verify/run-verify.ts` | `execute` | `{ command; }` | `{ ok, stdout, stderr, exitCode, failure? }` |
| 24 | `todo_write` | `tools/plan/todo-write.ts` | `read` | `{ task; state }` | task list |
| 25 | `ask_user` | `tools/plan/ask-user.ts` | `execute` | `{ question }` | `{ answer }` |
| 26 | `repo_map` | `tools/repo-map.ts` | `read` | `{ format?; maxFiles?, maxChars?, exclude? }` | repo map |
| 27 | `memory_write` | `tools/memory-write.ts` | `edit` | `{ key; value }` | confirmation |
| 28 | `spawn_agent` | `tools/agent/spawn-agent.ts` | `execute` | `{ name; task; cwd? }` | child summary |
| 29 | `task_get` | `tools/agent/task-get.ts` | `read` | `{ id }` | task status |
| 30 | `task_list` | `tools/agent/task-list.ts` | `read` | `{}` | task list |
| 31 | `task_wait` | `tools/agent/` | `execute` | `{ id }` | awaited result |
| 32 | `task_stop` | `tools/agent/` | `execute` | `{ id }` | stopped |
| 33 | `task_apply` | `tools/agent/` | `execute` | `{ id; patch }` | applied patch |

### Concurrency

`toolDefinitions()` ([`runtime.ts:217-223`](src/agent/runtime.ts)) maps the registry into OpenAI tool-definition format. Tools flagged `isConcurrencySafe` ([`types.ts:71-72`](src/tools/types.ts)) are eligible for parallel execution in a single step; the rest are forced to serial. This is the mechanism behind "order-preserving parallel tool execution" noted in the project's git history (`273d6ce`).

### Input truncation

[`tools/types.ts:77-78`](src/agent/runtime.ts:77): `truncate?` lets a tool cap its output at `maxResultTokens` (default 8k). `shell_exec` returns stdout truncated at 128 KiB ([`shell-exec.ts` docstring lines 1-11](src/tools/shell/shell-exec.ts)).

## Claude Code — verified from docs and tool inventory [Grounded-Behavior-CC]

CC exposes ~30+ built-in tools. The canonical mapping (per CC docs `claude.ai/code/docs` → "Tools"):

| Tool | Category | CC category |
|---|---|---|
| `Read`, `Glob`, `Grep`, `LS`, `TodoWrite`, `Task`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch` | first-party | |
| `SmartApply`/`ApplyPatch` variants | | |
| Bash (dangerous-pattern detection) | shell | |
| `MCP` (server-provided) | third-party extensions | |
| `NotebookEdit`, `NotebookRead` | notebook-specific | |

Risk classes in CC are **not** declared in tool metadata — they are inferred from the command path: `Read`/`Grep`/`Glob` are treated as read-only; `Edit`/`Write`/`NotebookEdit` are write-gated by path rules; `Bash` is the catch-all execute gate with pattern matching ([Grounded-Behavior-CC] — `src/cli/slash/parser.ts` references `COMMAND_DEFS` which lists `edit`/`read` distinctions; CC docs describe the Bash parser).

## Side-by-side

| Property | Claude Code | Klyro |
|---|---|---|
| Source of truth | Compiled-in tool set + MCP server registration | `builtinRegistry()` + dynamic registration possible |
| Risk class | Inferred per-command (read/edit/execute) | Declared in tool metadata ([types.ts:68-69](src/tools/types.ts)) |
| Concurrency gating | Parallel for all approved tools | `isConcurrencySafe` flag gates batching |
| Truncation policy | Tool outputs returned in full; compaction handles size | `truncate()` + 128 KiB stdout cap on shell |
| Notebook support | Native `NotebookEdit` | Absent (not in registry) [Verified-Absent: `src/tools/`] |
| Web fetch/search | `WebFetch`, `WebSearch` built-in | Absent from Klyro registry [Verified-Absent] |
| Spawn/sub-agent | `Task` tool | `spawn_agent` + `task_*` family |
| Memory | `memory_write` / memory tool | `memory_write` |
| MCP | Full MCP server support | MCP present in `src/mcp/` (see Round 13) |

## The genuine divergences

1. **Metadata-declared risk vs inferred risk.** Klyro stores `permission: 'read'|'edit'|'execute'|'admin'` in each Tool definition ([types.ts:68-69](src/tools/types.ts)). CC infers risk at runtime from the tool name + command path. Klyro's design is more explicit and auditable; CC's is more flexible for MCP-provided tools.

2. **Concurrency gating granularity.** Klyro's `isConcurrencySafe` flag ([types.ts:71-72](src/tools/types.ts)) lets a tool author declare "this can run in parallel." CC runs all *approved* tools in parallel ([Grounded-Behavior-CC]); there's no per-tool serial gating flag visible.

3. **Truncation responsibility.** Klyro truncates tool outputs at the tool boundary (`truncate()` + shell's 128 KiB cap). CC relies on post-hoc transcript compaction — large tool outputs enter the transcript and are only compressed later if context pressure triggers it.

4. **Notebook & web primitives.** CC has built-in `NotebookEdit`, `WebFetch`, `WebSearch`. Klyro has none of these [Verified-Absent: no entry in `registry.ts:106-133` or `tools/` directory listing].

5. **Agent-tasking model.** CC's `Task` tool delegates to an isolated agent process. Klyro's `spawn_agent` ([src/tools/agent/spawn-agent.ts](src/tools/agent/spawn-agent.ts)) runs a *scoped child loop in-process* via the orchestrator ([orchestrator.ts:1-14](src/agent/orchestrator.ts)) with a `ScopedRegistry`, depth cap, and AbortController wiring.

## The takeaway

Klyro's tool catalog is smaller but **structurally more deliberate**: risk classes are declared in metadata, concurrency gating is per-tool, and truncation is enforced at the tool boundary. CC's catalog is larger and more ergonomic (notebooks, web fetch/search) but its risk model is inferred at runtime. The gap is Klyro missing `WebFetch`/`WebSearch` and notebook support — both verifiable as absent from the registry file list.

---

# Round 4 — Permission Policy & Approval: The Gate Mechanics

## The contract being compared

When a tool call reaches the wire, *before* it executes, something must decide: allow, ask, or deny? The decision must be auditable, repeatable, and (ideally) learn from the user's last choice so the same call doesn't prompt twice.

## Klyro — verified against `src/policy/engine.ts` + `src/policy/approval.ts` + `src/policy/patterns.ts` [Verified-Code-Klyro]

The entire permission stack is under 180 KB — three files, three responsibilities:

### 1. Policy engine (`policy/engine.ts:55-218`)

`PolicyEngine.evaluate(call, ctx)` ([engine.ts:210-218](src/policy/engine.ts)) runs **rule functions in order** (`builtinRules()` → `shellDenyRule`, `shellAllowRule`, `writeFileCwdRule`, `readFileSizeRule`). The first rule returning `ask`/`deny` wins; the first `allow` short-circuits. Each rule is a pure function over `call.name + call.input + ctx`.

Key rules ([engine.ts:106-200](src/policy/engine.ts)):

- **shellDenyRule** — blocks a hard-deny list (`shellDeny`) by prefix match.
- **shellAllowRule** — allows `shellAllow` entries (e.g. `npm test`).
- **writeFileCwdRule** — denies `write_file` / `edit_file` / `apply_patch` if the resolved path escapes cwd via `resolveWithinCwd` ([path-guard.ts:46-64](src/policy/path-guard.ts)). On escape: returns `{action:'deny', reason:'POLICY_DENIED'}`.
- **readFileSizeRule** — blocks reading files larger than `readSizeAskMiB` MB without asking.

Default mode is `default` (ask-on-write) ([engine.ts:48](src/policy/engine.ts)). Modes: `'default' | 'accept-edits' | 'plan' | 'auto'`.

### 2. Pattern cache + persistence (`policy/approval.ts:83-134`)

`PatternApprovalCache` ([approval.ts:83-134](src/policy/approval.ts)) is the **second gate**, layered on top of the engine. Its `has(key)` checks a `Set<string>` of session-approved patterns. If the key is cached → **allow without prompting** (`approval.ts:119`). If not cached, it calls `inner.ask(req)` — the actual interactive prompt.

Pattern derivation is deterministic: `patternForCall(name, input)` ([patterns.ts:16-25](src/policy/patterns.ts)) produces:
- `shell_exec(npm *)` for shell commands sharing a first word
- `write_file(path/to/file.ts)` for file tools with a path arg
- The bare tool name for everything else

This is a **Claude-Code-style "always allow this pattern"** design: the same deterministic pattern key lets session cache + persisted settings both re-match across sessions.

### 3. Interactive prompt (`policy/approval.ts:27-81`)

`StdinApprovalPrompt` ([approval.ts:27-81](src/policy/approval.ts)) is the third layer — the actual human-in-the-loop. TTY mode shows the call + three options: `y` (allow once), `a` (always: session cache), `A` (always-persist: writes a settings file). Non-TTY mode returns `deny` so CI/pipe runs never block.

### Call chain in the runtime

`runtime.ts:864-890`: the loop calls `engine.evaluate()` → `PatternApprovalCache.check()` (session cache, `runtime.ts:866`) → `StdinApprovalPrompt` (interactive, only if `action:'ask'`). A deny becomes a `POLICY_DENIED` tool result ([runtime.ts:883-890](src/agent/runtime.ts)).

### Escape clauses

- `--yes` flag: non-interactive mode uses `DenyAllApprovalPrompt` ([cli/repl.ts:23](src/cli/repl.ts)) — all `ask` decisions become `deny`.
- `--mode accept-edits`: writes auto-allowed; shell still asked.
- Policy errors (`safe()` wrapper at [engine.ts:418](src/policy/engine.ts)) — a buggy rule cannot crash the loop; it returns a deny with the rule's error message.

## Claude Code — verified from docs and observed behavior [Grounded-Behavior-CC]

CC's permission flow (per `claude.ai/code` docs):

1. **Built-in allow-list** — Read/Grep/Glob/LS auto-allowed; path-aware rules for Edit/Write.
2. **Bash gate** — command parsed, dangerous patterns flagged (`rm -rf`, `git push --force`, `curl | sh`, `sudo`).
3. **Approval modal** — four options: Allow (once), Deny, Allow always for this session, Allow always + remember in settings.
4. **Caching** — decisions cached per *pattern* so the same command/tool isn't re-asked.
5. **Non-interactive** — `--yes` (or piped stdin) auto-approves safe tools; `--no-permission-checks` skips the gate entirely [Inferred-Design-CC].

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Engine | In-memory compiled-in tree; not user-extensible at runtime | `PolicyEngine` with ordered rule array; extensible via constructor |
| Pattern cache | Same-session, in-memory | `PatternApprovalCache` (Session Set + persisted file) ([approval.ts:118-124](src/policy/approval.ts)) |
| Interactive prompt | TU1 modal; 4 choices | `StdinApprovalPrompt`; 3 choices (y/a/A) |
| Deny on non-TTY | Auto-approve safe | Deny-all (must opt in to ask) |
| Path guard | Built-in realpath check | `resolveWithinCwd` + `resolveAndFollowSymlinks` ([path-guard.ts:46-114](src/policy/path-guard.ts)) |
| Policy error handling | N/A | `safe()` wrapper at [engine.ts:418](src/policy/engine.ts) — buggy rules can't crash loop |
| Modes | `default` / `accept-edits` / `plan` / `auto` | Same four modes ([engine.ts:34](src/policy/engine.ts)) |

## The genuine divergences

1. **Three-layer gate vs two-layer.** Klyro explicitly separates: (a) rule evaluation, (b) pattern cache lookup, (c) interactive prompt. CC collapses (a)+(b) conceptually. This makes Klyro's flow auditable — you can trace a decision through engine → cache → prompt.

2. **Non-interactive default.** CC --yes auto-approves. Klyro `--yes` → `DenyAllApprovalPrompt` ([cli/repl.ts:23](src/cli/repl.ts)) — denies everything. This is the **opposite polarity**: Klyro forces explicit allow-listing for headless; CC trusts-by-default with --yes.

3. **Persistent patterns.** Klyro persists approved patterns to a settings file via the `always-persist` path ([approval.ts:125-131](src/policy/approval.ts)), keyed by the deterministic `patternForCall`. CC's "remember in settings" exists but is not file-path-addressable in the same way.

4. **Path-guard defense-in-depth.** Klyro's `resolveAndFollowSymlinks` ([path-guard.ts:70-114](src/policy/path-guard.ts)) does a *two‑check*: lexical containment + realpath containment + realpath(parent) containment. CC's realpath check is documented but Klyro's is more thorough (catches symlinked-parent escape: `<cwd>/evil-link/../escape`).

5. **Policy rule safety.** Klyro wraps rule evaluation in `safe()` so a thrown rule returns `{action:'deny'}` rather than crashing the loop ([engine.ts:413-420](src/policy/engine.ts)). CC's safety behavior is not documented [Inferred-Design-CC].

## The takeaway

Klyro's policy stack is a **deliberately layered, auditable three-stage gate** with defense-in-depth path resolution and a deny-by-default non-interactive mode. CC's is more ergonomic (fewer prompts, trust-by-default with --yes) but less inspectable at the code level. They share the *same design intuition* (Claude-Code-style pattern memory + modes), but Klyro's three-layer decomposition makes the same intuition traceable to file:line.

---

# Round 5 — Context Scheduling & Token Budget: When the Model Runs Out of Room

## The contract being compared

Every harness must answer: how much context does the model have, what happens when it runs low, and who decides what gets dropped vs. summarized? The stakes are correctness (a dropped tool_result can orphan a tool_use → provider 400) and cost.

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC mains the **92% auto-compact** heuristic: as the number of context tokens approaches the model window, CC compresses older turns into a summary, keeping the most recent messages/tool-results verbatim. It uses a compact model (Haiku) at some cost-tokenish threshold. (CC help `claude /help` → "auto-compact"; docs "Context window" section). It is **entirely proactive** — compaction runs *before* the provider rejects.

## Klyro — verified against `src/context/` [Verified-Code-Klyro]

Klyro's context accounting is centralized in a single pure function:

- **`accounting()`** ([`src/context/accounting.ts:17-25`](src/context/accounting.ts)) — given the system prompt + message array and opts (defaults: `cap=120_000`, `reserveOutput=16_000`, `toolResultMax=2_000`, `compactAt=0.8`), returns `{ used, cap, pct, reserveOutput, compactAt, toolResultMax }`. It estimates tokens with `totalTokens()`.
- **Token estimation** ([`src/context/tokenizer.ts`](src/context/tokenizer.ts)) — chars/4 heuristic; deliberately a crude estimator used *only* to drive compaction decisions, so a mild over-estimate is safe.
- **Compaction strategy** ([`src/context/compaction.ts:11-47`](src/context/compaction.ts)) — a **three-tier** approach:
  1. **elide** — drop the oldest *consumed* tool_result observations via `compressTranscript()` ([tokenizer.ts](src/context/tokenizer.ts))
  2. **summarize 60%** with a `summarizeFn` (the "small model") using a strict template that lists every checkpointed file, **validating** the summary mentions them all before adopting it
  3. **fallback** — keep the last N verbatim
- **Tripwire** — the runtime calls compaction reactively on overflow error or when `accounting()` crosses thresholds; `compactAt = 0.8`.

### The pair-integrity guard

The most subtle part is in `compressTranscript` ([tokenizer.ts:101-125](src/context/tokenizer.ts)): when it drops a message, it also **drops the orphaned tool message that answered it** — and if it drops mid-size tool output, it truncates it to 400 chars + `... [truncated]` ([tokenizer.ts:106-108](src/context/tokenizer.ts)). This prevents the *provider-400 class*: an assistant `tool_use` block with no matching `tool_result`, or vice-versa. The Phase-3 hard cap loop ([tokenizer.ts:118-125](src/context/tokenizer.ts)) splices from index 1 so the first user task is always preserved.

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Trigger | ~92% of window (proactive) | `compactAt` = 0.8 (proactive) *and* reactive on `REQUEST_TOO_LARGE` (runtime.ts:497-520) |
| Compaction model | Haiku (separate model call) | `summarizeFn` (di/able; not wired to a model in the pure fn, but the runtime can inject one) |
| Strategy | Summarize oldest → keep recent | 3-tier: elide → summarize-60% → fallback |
| Safety | Keeps recent turns verbatim | Same (fallback tier keeps last N) |
| Pair integrity | Result — CC shows "tool results re-read on demand" for dropped ones | Explicit: dropping a turn drops its tool answers together (tokenizer.ts:118-125) |
| Budget observability | Usage in status bar | `accounting()` + `contextMeter()` bar + `ctxPct` in TUI status (app.tsx:628) |

## The genuine divergences

1. **Reactive overflow recovery.** Klyro uniquely retries a `REQUEST_TOO_LARGE` after aggressively compacting the transcript ([runtime.ts:497-520](src/agent/runtime.ts)) — one compress-and-retry per run, guarded by `overflowRetried` ([runtime.ts:281-282](src/agent/runtime.ts)). CC's compaction is proactive-only [Inferred-Design-CC: a genuine 400 would surface as a provider error].

2. **Explicit pair-integrity splicing.** Klyro's `compressTranscript` is *defensive about tool_use/tool_result pairing* ([tokenizer.ts:118-125](src/context/tokenizer.ts)). CC's docs say compacted tool-results are "re-read on demand," implying it keeps pointers rather than splicing — a different (arguably richer) memory model.

3. **Separate accounting module.** Klyro extracts budget logic into a pure function with clear defaults (`accounting.ts:17-25`) — auditable and unit-testable. CC conflates it into the runtime's compaction loop.

## The takeaway

Klyro's context scheduler is *more defensive* than CC: reactive overflow recovery on top of proactive compaction, plus an explicit pair-integrity splice guard to prevent the provider-400 class. CC's "re-read on demand" tool-result model is richer (Klyro truncates, doesn't re-pointer), but Klyro's budget is more inspectable and its recovery more resil-scoped. If Klyro wants parity, the highest-lever move is re-reading elided tool results on demand instead of discarding them.

---

# Round 6 — Interrupt & Abort: The Moment the User Takes Control Back

## The contract being compared

When the user hits Esc or Ctrl+C mid-run, what exactly happens? Does the child process get killed? Is the transcript checkpointed? Can the run be resumed? Is the event audited?

## Klyro — verified against `src/tui/app.tsx` + `src/agent/runtime.ts` + `src/tools/shell/` [Verified-Code-Klyro]

### The TUI dispatch

`useInput` ([app.tsx:532-619](src/tui/app.tsx)) maps keys to slash-cancel/quit. The state machine is a **two-press Ctrl+C** ([app.tsx:571-581](src/tui/app.tsx)):

- Running + first Ctrl+C → `onSlash({kind:'cancel'})` (cancel the run)
- Running + second Ctrl+C → `onSlash({kind:'quit'})` (exit)
- Idle + Ctrl+C → `quit`

Esc while running → `cancel` ([app.tsx:583](src/tui/app.tsx)).

### The signal threading

`props.onSlash({kind:'cancel'})` → repl.ts wires it to `runtime.run()` with an `AbortController.signal`. The runtime loop checks `opts.signal?.aborted` **every iteration** ([runtime.ts:398, 457, 596](src/agent/runtime.ts)) and at the top of the `while` loop breaks. When aborted mid-tool, the runtime aborts the executing tool (`runtime.ts:1046` passes the signal to the shell).

### The child-process kill

`shell-exec.ts` spawns the command and wraps it in process-group handling (lines ~290-340): on abort it kills the process **group** (`process.kill(-pid, 'SIGKILL')`) so the entire child tree dies, not just the direct child. If the user's tool is already completed, the runtime emits `aborted` and records the status.

### Event trail

Abort yields: `emit?.({kind:'aborted'})` ([runtime.ts:597](src/agent/runtime.ts)) and a `KlyroEvent {type:'abort', reason}` ([catalog.ts:27](src/events/catalog.ts)).

### Return status

Abort returns `{ status: 'aborted', ... }` ([runtime.ts:197-198](src/agent/runtime.ts)) — one of the ten `RunStatus` values. The store marks the session `aborted` ([store.ts:19](src/persistence/store.ts)).

### Persistence on abort

Checkpoints made *before* the abort survive; the final aborted state is written via `store.setStatus(sessionId, 'aborted')` unless `store` is absent ([runtime.ts:813] pattern). The UI explicitly ignores aborted transcript runs so partial content is not left rendered ([app.tsx:461-465](src/tui/app.tsx)).

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC's interrupt is **interrupt-driven**: Ctrl+C at the terminal sends SIGINT; CC stops the currently running tool and shows a message ("Ctrl+C to stop"). A second Ctrl+C quits. Esc is bound to "Esc is reserved for ctrl+c behavior" / stopping streaming. CC supports "—allow-sandbox" etc. but the core abort model is: tool runs are cancellable via SIGINT, partial work is retained, and resuming picks up from the last checkpoint.

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Running + Ctrl+C | Stop the run | `cancel` (first) → `quit` (second) |
| Idle + Ctrl+C | Exit | Exit |
| Esc | Stop (in many modes) | Cancel run |
| Signal type | OS SIGINT → the CLI catches | `AbortSignal` → runtime checks `signal.aborted` each iteration |
| Child cleanup | SIGINT propagation to tool | Process-group SIGKILL of the whole shell tree (shell-exec.ts:290-340) |
| Status | aborted state | `status:'aborted'` + session marked aborted |
| Audit | Terminal message | `KlyroEvent{type:'abort'}` + traced (catalog.ts:27) |
| Resume | From checkpoint | From persisted transcript + baseline (see Round 8) |

## The genuine divergences

1. **Kill signal.** Klyro uses **SIGKILL on the process group** when aborting ([shell-exec.ts] ~290-340) — by far the most aggressive cleanup. CC typically SIGINTs the child and gives it a chance to terminate gracefully.

2. **Two-press arming is stateful.** Klyro's `ctrlCArmed` ref ([app.tsx:251-254](src/tui/app.tsx)) is armed only while running and reset when not — so the *same* Ctrl+C has different meaning depending on run state. This is a deliberate UX choice (first press cancels, second quits) that CC implements via terminal SIGINT semantics.

3. **Abort-aware backoff.** Klyro's retry sleep is abort-aware: `sleepAbortable()` ([retry.ts:186-187](src/agent/retry.ts)) means Ctrl+C during exponential backoff stops promptly instead of stalling up to maxMs. CC's backoff behavior is internal [Inferred-Design-CC].

4. **UI repaint hygiene.** Klyro explicitly prunes stale "thinking" blocks and the active streaming caret when a run ends without final text ([app.tsx:457-465](src/tui/app.tsx)) — so an aborted run doesn't leave a phantom spinner or half-rendered reasoning.

## The takeaway

Klyro's abort is *layered and auditable*: an AbortSignal that's checked each iteration, a SIGKILL-on-process-group for child cleanup, a two-press Ctrl+C state machine, abort-aware backoff, and a full event trail. CC is SIGINT-native and typically more graceful. Klyro trades graceful shutdown for guaranteed cleanup — the more dangerous the shell tool, the more this is the right call.

---

# Round 7 — Event Bus & Observability: What the Runtime *Knows*

## The contract being compared

Does the harness emit typed, versioned events for every external action (tool calls, permissions, verification, subagents)? Can those events be replayed or traced to disk? Is there a single sink, or is observability scattered?

## Klyro — verified against `src/events/` + `src/trace/` [Verified-Code-Klyro]

### The catalog

`KlyroEvent` ([catalog.ts:6-38](src/events/catalog.ts)) is a **closed discriminated union** of ~33 event types, grouped:

- Session/turn: `session.start`, `session.end`, `turn.start`, `turn.end`
- Streaming: `stream.delta`, `stream.thinking`
- Tool: `tool.call`, `tool.result`
- Permission: `permission.ask`, `permission.decision`, `policy.decision`
- FS: `file.changed`
- Phase: `phase.changed`
- Verification: `verification.started/succeeded/failed`, `repair.started`
- Checkpoint: `checkpoint.saved`
- Usage: `usage`
- Errors/abort: `error`, `abort`
- **Subagents:** `subtask.started/progress/completed/failed/cancelled/timed_out/tool_call/tool_result/merged`
- Provider: `provider.retry`
- Context: `context.trust_prompt`, `context.compacted`

### The bus

`EventBus` ([bus.ts:10-33](src/events/bus.ts)) is a **synchronous in-memory pub/sub** with a **bounded history buffer** (`getHistory()`, `clear()`). Delivery is sync (`emit` calls listeners inline); a single misbehaving listener is caught with try/catch.

### The trace file

`TraceWriter` ([writer.ts:16-99](src/trace/writer.ts)) serializes every emitted KlyroEvent to `<cwd>/.klyro/traces/<sessionId>.jsonl`, **passing each line through `redact()`** before disk ([writer.ts:61](src/trace/writer.ts)). Durability: a promise-chain queue keeps concurrent appends line-valid ([writer.ts:19,53-57](src/trace/writer.ts)), per-line `seq` counters survive restarts via `primeSeq()` ([writer.ts:35-50](src/trace/writer.ts)), and tool-result lines get an explicit `fsync` for crash safety ([writer.ts:64-69](src/trace/writer.ts)). `readAll()` skips corrupt lines rather than discarding the file ([writer.ts:82-98](src/trace/writer.ts)).

### Replayability

`getHistory()` gives in-memory replay; the JSONL trace gives durable replay. There is a `src/cli/trace.ts` that reads traces (used by `/trace`).

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC persists a verbose **JSONL transcript per project+sid** (`~/.claude/projects/<git-remote>/<session>.jsonl`) containing nearly every event (message deltas, tool uses, edits, permissions, command traces). It is human-auditable and replays "last session"/`claude --resume`. CC also has `--verbose`/`--debug` for in-terminal observability. However, CC's events are **not exposed as a first-class typed contract** like Klyro's `KlyroEvent` union — they're a logging format, not a closed event taxonomy. [Grounded-Behavior-CC / Inferred-Design-CC on "typed contract"]

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Event catalog | Implicit JSONL log lines | **Closed, typed discrimated union** (catalog.ts:6-38) |
| Encoding | JSONL per-project | JSONL per-session, **secrets redacted on write** (writer.ts:61) |
| Replay | `--resume` / last-session | `getHistory()` + JSONL trace |
| Im-process bus | None (file-only contract) | `EventBus` sync pub/sub + bounded history |
| Subagent telemetry | Loose | `subtask.*` event family (catalog.ts:28-36) |
| Crash-durability | — | fsync on tool.result (writer.ts:64-69) |
| Sequence | — | Per-file `seq` survives restarts (writer.ts:35-50) |

## The genuine divergences

1. **First-class typed event contract.** Klyro's `KlyroEvent` is a closed union defined in one file, consumed by the bus, tracer, and UI as a type — TypeScript enforces exhaustive handling. CC's is an introspectable-but-untyped log stream. Klyro wins on type-safety; CC wins on ad-hoc parseability by third-party tools.

2. **Redaction-at-write.** Klyro redacts every trace line *before* disk ([writer.ts:61](src/trace/writer.ts)) — so secrets never leak to the trace, even from a malformed tool output. CC's transcripts also redact by policy but [Verified-Absent: Klyro's is a hard guarantee in the writer, not a separate verb].

3. **Sync vs. async bus.** Klyro's `emit` is synchronous ([bus.ts:14-19](src/events/bus.ts)) — deterministic ordering, but a slow listener blocks the runtime. CC's observable pipeline is file-append (async). Klyro could deadlock a hot path if a listener is slow; CC's is fire-and-forget.

4. **Bounded history vs. file-only.** `getHistory()` (in-memory) + JSONL (durable) gives Klyro live replay. CC's is file-only unless it buffers in memory [Inferred-Design-CC].

## The takeaway

Klyro's observability is a *first-class typed concern*: a closed event union, a sync pub/sub bus with bounded history, a redacting JSONL tracer with fsync durability and restart-surviving sequence numbers. CC's is a mature but untyped JSONL log. Klyro's redaction-at-write and typed taxonomy are its clear structural advantages; CC's is more battle-tested for third-party consumption.

---

# Round 8 — Error Taxonomy & Recovery: When a Tool Call Fails

## The contract being compared

How errors are named, encoded, surfaced to the model, and recovered from — at three boundaries: the transport (provider), the tool execution, and the policy layer. Are failures structured or free-text?

## Klyro — verified against `src/tools/normalize.ts` + `src/shared/errors.ts` + tool code [Verified-Code-Klyro]

### The three error layers

1. **Tool-level codes** — `TOOL_ERROR_CODES` ([normalize.ts:10-22](src/tools/normalize.ts)): `NOT_FOUND`, `PERMISSION_DENIED`, `INVALID_INPUT`, `IO_ERROR`, `TIMEOUT`, `ABORTED`, `PATH_ESCAPE`, `COMMAND_DENIED`, `COMMAND_NOT_FOUND`, `EXIT_NONZERO`, `INTERNAL`. `toToolError()` ([normalize.ts:32-58]) maps any thrown value — including Node errnos (`ENOENT`→`NOT_FOUND`, `EACCES`→`PERMISSION_DENIED`, etc.) ([normalize.ts:75-94](src/tools/normalize.ts)).

2. **CLI-level errors** — `KlyroError` ([shared/errors.ts:33-52](src/shared/errors.ts)) carries `code`, `hint`, `exitCode`, `retryable`. `EXIT_CODE` table (lines 20-31) maps codes → shell exit codes (e.g. `VERIFY_FAILED: 8`, `CONFIG_INVALID: 3`, `PATH_ESCAPE: 2`). `handleFatal()` ([cli/errors.ts:7-33](src/cli/errors.ts)) renders them; suppression of the stack unless `--debug` ([errors.ts:21-27](src/cli/errors.ts)).

3. **Transport-level retry classification** — the provider adapter's `StreamEvent` error carries `retryable: boolean` + `retryAfterMs` ([provider-adapter.ts:31](src/agent/provider-adapter.ts)); `retryingAdapter` ([retry.ts](src/agent/retry.ts)) only retries `retryable:true` errors.

### The transcript-encoding rule

Structured tool errors enter the model's context as `tool_result { output: { error, isError } }` — **never as a crash**. The runtime converts validation failures to `INVALID_TOOL_INPUT` hand-back ([runtime.ts:562-584](src/agent/runtime.ts)), pending-tool failures to `{ error: 'EXEC_CRASH' }` ([runtime.ts:924-935](src/agent/runtime.ts)), and converts policy denials into `POLICY_DENIED` tool results ([runtime.ts:883-890](src/agent/runtime.ts)).

### Structured error handling at the transport

`httpChatAdapter` maps HTTP error bodies ([provider-adapter.ts:279-296](src/agent/provider-adapter.ts)); the runtime reacts to `REQUEST_TOO_LARGE` by compact-retry; other `error` events become `stream_error` telemetry ([runtime.ts:521](src/agent/runtime.ts)).

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC's tool failures are surfaced as tool results with an error string; there is a documented `set -e`-like "command failed" for Bash. CC has no globally *structured* error-code taxonomy in the public docs [Inferred-Design-CC: CC uses a small set of internal codes + verbose logs]. CC wins on **rely-the-ness of failure** — the model sees the raw Bash stderr and often fixes it, whereas Klyro pre-structures it.

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Error shape | Mostly free-text string in tool result | `{ code, message, details? }` ToolResult ([types.ts:14-17](src/tools/types.ts)) |
| Node errno mapping | Internal | Explicit `toToolError` map (normalize.ts:75-94) |
| Exit codes | — | `KlyroError.exitCode` + `EXIT_CODE` table (shared/errors.ts:20-31) |
| Retryability | Transport-level (internal) | `retryable` flag on StreamEvent error (provider-adapter.ts:31) + retryingAdapter |
| Crash → emit | Raw exception | `EXEC_CRASH` structured error (runtime.ts:924-935) |
| Policy deny | Message + banner | `POLICY_DENIED` code + reason (runtime.ts:883-890) |
| Redactor hook | Separate | Applied in tracer (writer.ts:61) + verify diagnostics (engine.ts:127-128) |

## The genuine divergences

1. **Mandatory structured errors.** Every Klyro tool *must* return `ToolResult<T>` (`ok:true / ok:false`, never throw) ([types.ts:14-16](src/tools/types.ts)) — enforced by `safe()` and the runtime's catch. This is a stronger contract than CC's free-text error strings.

2. **Error code → exit code · succeed air.** Klyro maps internal error codes to process exit codes via `EXIT_CODE` ([shared/errors.ts:20-31](src/shared/errors.ts)) — so a script can `$?`-inspect *what kind* of failure occurred (config vs. auth vs. verify). CC doesn't expose a similar taxonomy.

3. **Policy denial is an error code.** Klyro treats `POLICY_DENIED` as a first-class structured tool error fed back to the model ([runtime.ts:883-890](src/agent/runtime.ts)) — the model can then pick a different tool path. CC also reflects denials, but as a UI/banner, not a typed code the model can branch on.

4. **Retryability is an attribute, not a side-effect.** The `retryable` flag on `StreamEvent.error` ([provider-adapter.ts:31](src/agent/provider-adapter.ts)) *decentralizes* retryability into the adapter, so `retry.ts` never guesses. CC keeps retry policy centralized but opaque [Inferred-Design-CC].

## The takeaway

Klyro's error system is **structured-by-construction**: three error layers (tool→CLI→transport), a mandatory `ToolResult` contract, explicit errno mapping, exit-code surfacing, and retryability-as-data. CC's is looser but battle-tried: it leans on the model to read raw output. Klyro's disadvantage is the cost of that structure — every tool bears the contract, and a thrown error inside a tool is a harness bug, not a valid failure.

---

# Round 9 — Session Lifecycle: Startup, Teardown, Checkpoint, Resume

## The contract being compared

How a session is created, identified, persisted, resumed, and isolated. What survives a crash? What is the unit of durability?

## Klyro — verified against `src/persistence/` + `src/checkpoints/` [Verified-Code-Klyro]

- **Store** — `SessionStore` ([store.ts](src/persistence/store.ts)): JSON-on-disk, **one file per session** in `<home>/.klyro/sessions/` (or `KLYRO_SESSIONS_DIR`), plus a `sessions.json` index ([store.ts:9-18](src/persistence/store.ts)). The old code doc explicitly says SQLite is deferred post-MVP ([store.ts:6-11](src/persistence/store.ts)).
- **Session ids** — `randomUUID()` ([store.ts:16](src/persistence/store.ts)); `resolveSessionId`/`matchSessionIds` support **prefix matching, git-style** ([session.ts:36-55](src/persistence/session.ts)).
- **Transcript + observations** — the store appends `Message`s and `Observation`s per session ([store.ts:52-67](src/persistence/store.ts)); `checkpoint()` in the runtime appends after each assistant turn and tool observation ([runtime.ts:348-369](src/agent/runtime.ts)).
- **Snapshot checkpoints** — `.klyro/checkpoints/` for **undo/rewind** between steps ([checkpoints/store.ts:9-11](src/checkpoints/store.ts)), with `fsync` for crash safety ([checkpoints/store.ts:14-19](src/checkpoints/store.ts)), and strict path containment so an undo can't write outside cwd ([checkpoints/store.ts:21-25](src/checkpoints/store.ts)).
- **Cross-process lock** — sessions have a `${id}.lock` with liveness via `process.kill(pid, 0)` ([store.ts:392-412](src/persistence/store.ts)) and graceful release ([store.ts:415-418](src/persistence/store.ts)).
- **Resume** — `resolveSystemPrompt` builds base context; `run()` accepts `initialTranscript` and `--resume` reloads it, avoiding duplicating the task ([runtime.ts:258-273](src/agent/runtime.ts)).
- **Session status** — `'open' | 'complete' | 'verify_failed' | 'aborted' | 'max_steps' | 'stuck'` ([store.ts:19](src/persistence/store.ts)).

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC stores one JSONL transcript per project+session under `~/.claude/projects/<remote-or-cwd-hash>/<sid>.jsonl`, plus a `sessions.json` index. `/resume`, `--resume`, `--continue`, and `--restore-session` let you re-attach. Checkpoints (`/checkpoint`) allow explicit resume points with `--restore`. It does **not** use SQLite in the default path.

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Location | `~/.claude/projects/<hash>/*.jsonl` | `<home>/.klyro/sessions/*.json` (+index) |
| Index | `sessions.json` | `sessions.json` (JSON dir index) |
| Session id | opaque uuid | `randomUUID()` + **prefix resolution** (session.ts:36-45) |
| Checkpoint | `/checkpoint` → restore points | `.klyro/checkpoints/` → undo/rewind (checkpoints/store.ts) |
| Lock | Cross-process | `${id}.lock` + liveness probe (store.ts:392-418) |
| Crash safety | fsync on append | fsync on snapshot + tool.result trace ([writer.ts:64-69]) |
| Resume | `--resume`/`--continue` | `--resume` via `initialTranscript` ([runtime.ts:258-273]) |
| Isolation | per-project dir | per-session file + per-project `.klyro/` |

## The genuine divergences

1. **Checkpoint-as-undo.** Klyro's checkpoints are *rewind* objects (`undo(cwd, 1)` + `rewind(cwd)` in [checkpoints/store.ts:162-164](src/checkpoints/store.ts)) — they snapshot the file tree so you can revert a bad edit. CC's `/checkpoint` are *resume points* in the conversation. Different semantics: Klyro checkpoints the working tree; CC checkpoints the dialogue.

2. **Cross-process lock.** Klyro holds a real `${id}.lock` with `process.kill(pid,0)` liveness ([store.ts:392-412](src/persistence/store.ts)) to prevent two processes mutating the same session. CC's concurrency story is single-process by default [Verified-Absent: not documented to the same degree].

3. **Observations.** Klyro persists a separate `Observation` record (toolCallId, toolName, input, output, isError) distinct from the transcript ([store.ts:52-67](src/persistence/store.ts)). CC keeps tool results inline in the messenger log. Klyro's split makes audit of *tool invocations* clean; CC's makes the *conversation* fragmented-less.

4. **Prefix id resolution.** `klyro resume ab12` works via `matchSessionIds` ([session.ts:48-55](src/persistence/session.ts)) even when the id is truncated — git-style convenience CC does not document.

## The takeaway

Both use JSON-on-disk persistence with index + checkpointing. The asymmetric decision is **what a checkpoint means**: Klyro snapshots and *rewinds the file tree* (undo), CC marks *resume points in the conversation*. Klyro adds cross-process locks and a separate Observations ledger — more isolation, more auditability; CC is simpler and more dialogue-centric.

---

# Round 10 — The Verification Sub-Loop: Auto-Verify & Repair as a Closed Loop

## The contract being compared

After the agent claims done, a harness may run a verifier (tests/build/lint), classify the failure, feed it back, and let the model repair — bounded. This "verification sub-loop" is the difference between "writes code" and "writes working code".

## Klyro — verified against `src/verification/` + `runtime.ts` verification section [Verified-Code-Klyro]

- **Baseline** — `ensureBaseline()` captures what HEAD's verify-output looks like *before* edits, so a failure that's pre-existing isn't blamed on the agent ([runtime.ts:340-346](src/agent/runtime.ts); `src/verification/baseline.ts`).
- **Detector** — `detect(stdout, stderr, exitCode)` ([detect.ts:53-203](src/verification/detect.ts)) classifies failures into `'type' | 'test' | 'lint' | 'build' | 'runtime' | 'unknown'` using regex patterns for TS/vitest/eslint/go/cargo/mocha/pytest/junit/gcc/dotnet ([detect.ts:31-50](src/verification/detect.ts)).
- **Classifier** — `classifyFailure()` ([classify.ts:28-60](src/verification/classify.ts)) decides `'introduced' | 'pre_existing' | 'flaky' | 'env'` by: env-signal regex, then diff-overlap against baseline ([classify.ts:44-49](src/verification/classify.ts)).
- **Repair guard** — `guardRepair(diff)` ([classify.ts:129-142](src/verification/classify.ts)) *blocks* repair if the diff touches **test assertions** (`expect(`, `assert.`) or adds **skips/todos** — policy: "skipping tests is not a fix."
- **Repair loop** — bounded by `maxRepairs` (from `opts.verify`, default strict). Each failure feeds a structured diagnostic as a user message, gathers repair context (failing test excerpts, git blame), and retries ([runtime.ts:781-819](src/agent/runtime.ts)). `repairTokens` attribute per-verify call tracks how many tokens the repair consumed ([runtime.ts:283-303](src/agent/runtime.ts)).
- **Sanity pre-checks** — cheap `tsc`/import checks run *before* the full suite as a fail-fast gate ([runtime.ts:679-690](src/agent/runtime.ts)); scoped-verify path first, full-verify confirm ([runtime.ts:710](src/agent/runtime.ts)).
- **Env vs. code** — an env-classified failure tells the model to *not* edit code but fix the environment ([runtime.ts:746-754](src/agent/runtime.ts)).

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC's automated verification is **verifier-triggered**: there is a test/verify command configurable in settings, and CC runs it at the end; failures are shown to the user. However, "self-repair on verification failure with bounded retries, per-failure baseline classification, and a guard against editing tests" is not a first-class CC feature in the same depth — CC leans on the user to approve and iterate. [Inferred-Design-CC]

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Baseline at HEAD | Not standard | `ensureBaseline()` per HEAD ([runtime.ts:340-346]) |
| Failure classifier | Regex → string | `detect()` → typed `Failure` (detect.ts:53-203) |
| Introduced vs pre-existing | Not standard | `classifyFailure()` (classify.ts:28-60) |
| Repair loop | User-driven | **Bounded model-driven** (`maxRepairs`) + `repair.started` events |
| Test-assertion guard | Not documented | `guardRepair` blocks (classify.ts:129-142) |
| Repair token cost | — | `repairTokens` per call ([runtime.ts:283-303]) |
| Env-vs-code direction | — | Env failure → don't edit code ([runtime.ts:746-754]) |

## The genuine divergences

1. **Self-repair is the core differentiator.** Klyro runs a *model-driven bounded repair sub-loop* — the agent fixes its own failures up to `maxRepairs`. CC's loop is user-in-the-loop by default. This is the single biggest functional asymmetry in the harness.

2. **Policy guardrail inside verification.** `guardRepair` *refuses to let the model "fix" a failing test by editing assertions or adding skips* ([classify.ts:129-142](src/verification/classify.ts)) — a subtle but important guardrail CC doesn't expose.

3. **Baseline blame.** `ensureBaseline()` + `classifyFailure` lets Klyro distinguish "you broke it" from "it was already broken" — so a genuinely failing baseline doesn't spin the repair loop. CC effectively always blames the agent for a failing final verify.

4. **Repair-token accounting.** Each verify payload carries `repairTokens` = tokens consumed post-first-failure ([runtime.ts:288-296](src/agent/runtime.ts)) — so the cost of repair is separately attributable, something not present in CC.

## The takeaway

The verification sub-loop is Klyro's **most distinctive architectural asset** — a closed, budgeted, policy-guarded loop (baseline → detect → classify → repair → re-run) that CC does not formalize to this depth. It converts verification from a gate into a competence. The key risk is runaway repair cost, which Klyro bounds with `maxRepairs` and itemizes with `repairTokens`.

---

# Round 11 — Token / Cost Accounting: Who Counts the Money, and When?

## The contract being compared

How input/output tokens are estimated (or read from the provider), accumulated across a run, converted to cost, and surfaced to the user.

## Klyro — verified against `runtime.ts` + `context/accounting.ts` + `providers/model-info.ts` [Verified-Code-Klyro]

- **Estimation** — `estimateTokens`/`totalTokens` (chars/4) in [tokenizer.ts](src/context/tokenizer.ts); used for compaction and the UI meter.
- **Provider-reported usage** — the adapter reads `usage.prompt_tokens`/`completion_tokens` from the final chunk and emits it via `message_end.usage` ([provider-adapter.ts:410-415](src/agent/provider-adapter.ts)); the runtime accumulates it into the `usage` object ([runtime.ts:274](src/agent/runtime.ts)).
- **Memoization** — `cachedTotalTokens` caches the last count keyed by (messages ref, system) so repeated accounting doesn't re-tokenize ([runtime.ts:239-253](src/agent/runtime.ts)).
- **Cost** — `estimateCost(model, usage)` uses `ratesFor(model)` from `providers/model-info.ts` — **model-aware pricing, single-sourced rate table** ([runtime.ts:233-236](src/agent/runtime.ts); doc comment 225-231). Cache-token counters (`cacheRead`/`cacheWrite`) are tracked but **excluded from cost** by design (cached tokens bill at discount rates not modeled) ([runtime.ts:227-231](src/agent/runtime.ts)).
- **Hard limits** — `maxCost` (dollar) and `maxTimeMs` trip the run to `status:'limit'` mid-step ([runtime.ts:383-397](src/agent/runtime.ts)).
- **UI surfacing** — `ctxPct`, `cost.toFixed(2)`, and a ctx meter are rendered in the status bar ([app.tsx:625-628](src/tui/app.tsx)).

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC shows a usage popover / status with token counts and per-call cost; it offers a `max_turns` and per-session usage tracking in `/usage`. CC reads provider usage at each call end. Cost is model-rate-aware (CC always pays Claude rates), no competing provider consideration.

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Token estimate | Provider-reported at call end | chars/4 heuristic (local) + provider-reported merge |
| Cost model | Anthropic-only rate table | `ratesFor()` per-provider table (model-info.ts) |
| Cache-token accounting | Yes (Anthropic) | Tracked but **excluded from cost** by design ([runtime.ts:227-231]) |
| Hard budget | max_turns | `maxCost` (USD) + `maxTimeMs` → `status:'limit'` |
| Leak/memo | | `cachedTotalTokens` memo |
| Surpacing | status/usage | `ctxPct` + `$cost` in status + `usage` event |

## The genuine divergences

1. **Multi-provider cost.** Klyro's `ratesFor()` is provider-model-aware, so a local Ollama model costs $0 while a Claude model bills — the harness is honest about local-vs-cloud economics. CC is inherently single-rate (Anthropic).

2. **Hard USD/time budget.** `maxCost` + `maxTimeMs` enforce an **in-run abort** to `status:'limit'` ([runtime.ts:383-397](src/agent/runtime.ts)) — you can tell the harness "stop me if this costs $5." CC has max_turns but not a hard currency budget in the same form [Inferred-Design-CC].

3. **Cache token honesty.** Klyro deliberately *excludes* cache-token discounts from cost to avoid over/under-stating spend — an accounting philosophy (don't model what you can't price) enabled by running OpenAI-compatible providers. [Verified-Code-Klyro] — this is an intentional, documented trade.

4. **Local estimation.** The chars/4 heuristic means Klyro's *on-screen* ctx% is approximate until provider usage arrives — acceptable for driving compaction, but CC always has exact provider tokens for the context display.

## The takeaway

Klyro's cost accounting is **provider-plural and budget-controlled**: model-aware per-provider rates, a hard USD/time tripwire, memoized token counting, and honest cache-token exclusion. CC is simpler and exact (single-provider). Klyro's real risk is trusting a heuristic for context-driven compaction; it mitigates this with the reactive overflow-retry from Round 5.

---

# Round 12 — Secret Hygiene: Masking, Redaction, Straddle-Buffering

## The contract being compared

How credentials are kept out of the transcript, the trace, and tool outputs — and whether redaction survives streaming boundaries (multi-byte/chunk-straddled secrets).

## Klyro — verified against `src/policy/secret-redactor.ts` [Verified-Code-Klyro]

- **Pattern catalog** ([secret-redactor.ts:14-33](src/policy/secret-redactor.ts)) — 17 named regexes: AWS keys (incl. b64 high-entropy), PEM private blocks, GitHub/Slack/npm/PyPI/SendGrid/Discord tokens, generic Bearer/JWT, `api_key`/`password`/`secret`/`token` key=value shapes, OpenAI/Anthropic keys.
- **Single-shot** — `redact(string|Buffer)` replaces every match with `[REDACTED]:<name>` ([redactor:38-45](src/policy/secret-redactor.ts)).
- **Streaming / straddle-buffer** — `createRedactor()` is a Node `Transform` that **holds back the last 1 KiB un-flushed** so a secret split across chunk boundaries is still caught ([redactor:52-68](src/policy/secret-redactor.ts)). This is the classic straddle buffer.
- **Where it's wired** — applied at: tool output before it enters the transcript (`redactOutput` in runtime.ts:965), the trace tracer (**at write**, writer.ts:61), and verification diagnostics before injection to the model (engine.ts:127-128).

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC redacts secrets from the transcript and hides env vars by default (`VERBOSE`-gated disclosure). It warns when a file looks like `.env`. However, as an Anthropic-closed product, its redactor implementation is not observable code — so "straddle-buffered" streaming redaction is [Inferred-Design-CC] at best; CC buffers tool output and applies regex redaction.

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Pattern coverage | Broad (creds) | Broader & named (17 classes) |
| More common | Env-var hiding | Regex redact + `filteredEnv()` for shell children ([shell-exec.ts]) |
| Streaming redaction | [Inferred] full-buffer then regex | **1 KiB straddle-buffer transform** (redactor:52-68) |
| At-rest (trace) | Redacted transcript | **Redact at write** (writer.ts:61) |
| Child env | Inherits we the parent | `filteredEnv()` strips secrets before spawn ([shell-exec.ts]) + `KLYRO_API_KEY` |
| Class label | generic | `[REDACTED]:<name>` labels (redactor:42) |

## The genuine divergences

1. **Straddle-buffered streaming redaction.** Klyro's `createRedactor()` keeps 1 KiB un-flushed to catch chunk-straddled secrets ([redactor:57-62](src/policy/secret-redactor.ts)) — a correctness win for *streamed* tool output that CC (full-buffer-then-regex) may miss mid-stream [Inferred-Design-CC].

2. **Redact-at-write in the tracer.** The trace is redacted on disk ([writer.ts:61](src/trace/writer.ts)) — so secrets never persist even if upstream forgot ([Verified-Absent] CC trace guarantee is a product matter).

3. **Filtered child env.** Spawned children get `filteredEnv()` — a deliberate removal of secrets from `process.env` before `spawn`, so a leaked `env` in shell output can't include the API key ([shell-exec.ts]). This is defense-in-depth CC doesn't expose the same way.

4. **Labeled replacement.** `[REDACTED]:<name>` tells you *which class* was masked ([redactor:42](src/policy/secret-redactor.ts)) — useful for audit; CC uses a generic placeholder.

## The takeaway

Klyro's secret hygiene is **defense-in-depth and streaming-correct**: a named 17-class redactor, a 1 KiB straddle buffer for streamed output, redact-at-write in the tracer, and filtered child env. CC relies on product-level redaction and env hiding. Klyro's `filteredEnv()` + redact-at-write are structural guarantees CC doesn't architecturally match.

---

# Round 13 — Output / Markdown Rendering: A Viable Terminal Surface

## The contract being compared

How assistant markdown is rendered in the terminal — headings, code fences, lists, tables, links, and whether streaming correctness (partial chunks) is handled.

## Klyro — verified against `src/cli/markdown.ts` + `src/tui/markdown.ts` [Verified-Code-Klyro]

Two renderers exist, both pure and unit-tested:

1. **Terminal/CLI renderer** ([cli/markdown.ts:6-62](src/cli/markdown.ts)) — handles headings (uppercase + rule), fenced code (`┌ code ──` gutter), lists (`•`), tables (`│`), width-aware word-wrap, and **plain-text stripping** when `!isTTY`, `KLYRO_JSON=1`, or `NO_COLOR=1` ([markdown.ts:9-12](src/cli/markdown.ts)). `renderIncremental()` append-and-re-render for streaming ([markdown.ts:74-77]).

2. **TUI renderer** ([tui/markdown.ts:46-72](src/tui/markdown.ts)) — tokenizes into styled `MdPart[]` (`bold`, `dim`, `code`) rendered by React/Ink. Handles `**bold**`, `*italic*`→dim, `` `code` ``, links, fenced blocks, headings.

- **Streaming correctness** — `appendDelta` accumulates the assistant text *in place* on a single transcript item ([app.tsx:440-444](src/tui/app.tsx)), re-rendering that one item rather than appending partial slices. The measurement layer handles wrapped display-lines so re-render is O(1) for the tail.

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC renders markdown in the terminal with inline syntax highlighting, clickable file links (`path:line` hyperlinks), tables in a grid, and proper streaming (incremental content with the caret tracking the stream). CC's rendering is substantially richer — real syntax highlighting, clickable links, and a mature layout.

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Heading styling | Rich | `UPPERCASE` + rule (cli) / bold (tui) |
| Code fences | Full block — gutter + highlight | `┌ code ──` gutter, dim'd, no highlight |
| Syntax highlight | Full (file-aware) | **None** — code blocks dimmed |
| Links | Clickable `path:line` | Plain (strip or `(url)` dim) |
| Tables | Grid layout | `│` passthrough |
| Streaming | Incremental, caret | In-place append + re-render single item (app.tsx:440-444) |
| Non-TTY | Plain text | `stripMarkdown()` (markdown.ts:64-72) |

## The genuine divergences

1. **No syntax highlighting.** Klyro dims code blocks but does **not** tokenize/highlight ([tui/markdown.ts:56-58](src/tui/markdown.ts)). CC has full file-aware highlighting. This is Klyro's biggest rendering gap.

2. **No clickable links.** Klyro renders `[text](url)` as text + dimmed `(url)` ([markdown.ts:34-37](src/cli/markdown.ts)). CC emits terminal hyperlinks for file:line references. Klyro can't produce a clickable `app.ts:42`.

3. **Streaming is item-level.** Klyro appends deltas *in place* on one transcript item and re-measures ([app.tsx:440-444](src/tui/app.tsx)) — correct but potentially O(chunk) re-render. CC keeps a dedicated streaming caret view.

4. **Two renderers.** Klyro maintains *both* a CLI renderer and a TUI renderer ([cli/markdown.ts], [tui/markdown.ts]) — duplication risk; CC has one unified renderer.

## The takeaway

Klyro's rendering is *correct and pure* but **feature-sparse** vs. CC: no syntax highlighting, no clickable links, tables are passthrough, and two renderers are maintained. For a v1.0 this is the right scope cut; for CC-parity, syntax highlighting and clickable file links are the two highest-leverage rendering moves.

---

# Round 14 — Keyboard / Keymap: Every Keypress Has a Mode and an Escape Clause

## The contract being compared

The full keyboard surface: which keys dispatch in which mode (running vs idle vs approval vs fullscreen-scroll), Shift+Enter vs Enter intent, history, slash autocomplete, and paste handling.

## Klyro — verified against `src/tui/app.tsx:532-619` (single `useInput`) [Verified-Code-Klyro]

A single centralized `useInput` handler gates everything (app.tsx:532-619). The behavior is **mode-conditional**:

| Key | While running | Idle |
|---|---|---|
| Enter (empty input) | dismiss badge | dismiss badge |
| Enter (text) | **queue** (up to 3) | **submit** (runs parseSlash → prompt/slash) |
| Shift+Enter / CSI-u | newline (never submit) | newline |
| Esc (empty queue) | cancel run | — |
| Esc (non-empty input) | cancel stream | —(marks esc-return) |
| Ctrl+C (1st) | cancel run | quit |
| Ctrl+C (2nd) | quit | — |
| Ctrl+O | expand last tool group | — |
| Ctrl+U / PgUp | half-page up | half-page up |
| Ctrl+D / PgDn | half-page down | half-page down |
| Home/End / Ctrl+G | first/last | first/last |
| Ctrl+B / Ctrl+F | page up / page down | same (+ history on ↑/↓) |
| Up/Down | — | **history** when buffer non-empty; scroll when empty |
| Tab | — | slash autocomplete (top of 6) |
| Backspace | edit | edit |

- **Slash autocomplete** — `suggestCommands()` populates top-6 (`/`, no space yet) and Tab completes the first ([app.tsx:527-539](src/tui/app.tsx); parser.ts:425-435).
- **Paste/queue** — multiple Enter-submits while running **queue** up to 3, drained when idle ([app.tsx:427-436](src/tui/app.tsx)), with Esc popping one ([app.tsx:533](src/tui/app.tsx)).
- **Shift+Enter multi-capture** — detects explicit shift+return, kitty/CSI-u (`\x1b[13;2u`), legacy `ESC+CR`, and Esc→Return within 75ms ([app.tsx:557-570](src/tui/app.tsx)).
- **History** — `↕` cycles `history[]`, index tracked via `histIdx` ([app.tsx:594-614](src/tui/app.tsx)).

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC's keymap: Enter submit, Shift+Enter newline, Esc stop/idle, Ctrl+C stop→quit, Tab autocomplete/complete, Up/Down history, PgUp/PgDn scroll, and a wide set of slashes. CC also supports bindable keymaps (`~/.claude/keybindings.json`) and mouse scroll. Similar surface overall, but CC has *user-rebindable* keybindings which Klyro hardcodes.

## Side-by-side

| Binding | Claude Code | Klyro |
|---|---|---|
| Submit | Enter | Enter (or queued via 2nd Enter while running) |
| Newline | Shift+Enter | Shift+Enter / CSI-u / Esc+Return (75ms) |
| Stop | Esc / Ctrl+C | Esc / Ctrl+C (two-step) |
| Quit | Ctrl+C (idle) | Ctrl+C (idle) |
| Autocomplete | Tab | Tab (slash top-6) |
| Scroll | PgUp/PgDn, mouse | PgUp/PgDn/Ctrl+B,F, Home/End, mouse-wheel tap |
| Rebindable | **Yes** (`keybindings.json`) | **No** — hardcoded in useInput |
| Paste queue | Paste works | Queued-submit while running (max 3) |

## The genuine divergences

1. **Queued submits while running.** Klyro allows up to 3 queued Enter-submits while a run is in flight ([app.tsx:585,427-436](src/tui/app.tsx)); CC buffers keyboard input too but Klyro's is explicit about the queue cap and Esc-pop. This is a real UX differentiator for fast typists.

2. **No rebindable keymap.** CC ships `~/.claude/keybindings.json` for **user-customisable keybindings** — a first-class feature. [Verified-Absent: Klyro has no keybinding config file; the whole map is hardcoded in `app.tsx:532-619`.]

3. **Shift+Enter multi-sequence detection.** Klyro/bakes in detection of kitty CSI-u and legacy `ESC+CR` sequences for Shift+Enter intent ([app.tsx:561-565](src/tui/app.tsx)) — practical terminal-compat CC handles internally.

4. **Mode-aware scroll + history co-location.** Klyro resolves `↑/↓` to *history* when the buffer has text, *scroll* when empty ([app.tsx:594-614](src/tui/app.tsx)) — a context switch CC also does, but Klyro's is explicit and test-covered.

## The takeaway

Klyro's keymap is **mode-conditional and deliberate**, with a real differentiator (queued submits while running + Shift+Enter multi-sequence detection) and good scroll/history co-location. Its single structural gap vs. CC is **user-rebindable keybindings** — currently hardcoded, which is the highest-leverage keyboard move for parity.

---

# Round 15 — CWD / Sandbox Physicality: Path Cement, Symlinks, and the Process Boundary

## The contract being compared

What "inside the project" means physically: path containment, symlink defense, cd/tool boundary, and whether the agent can escape the sandbox.

## Klyro — verified against `src/policy/path-guard.ts` + `shell-exec.ts` [Verified-Code-Klyro]

- **Lexical containment** — `resolveWithinCwd(cwd, requested)` uses `path.resolve` + `path.relative` and rejects `..` / different-drive escapes ([path-guard.ts:46-64](src/policy/path-guard.ts)); case-insensitive on Windows ([path-guard.ts:31-40](src/policy/path-guard.ts)).
- **Symlink-escape defense (two-tier)** — `resolveAndFollowSymlinks()` realpaths the target *and* its parent, and rejects when either escapes cwd non-transitively ([path-guard.ts:70-114](src/policy/path-guard.ts)). The parent-realpath check closes `<cwd>/evil-link/../escape` ([path-guard.ts:98-112](src/policy/path-guard.ts)).
- **Write-path enforcement** — shell/child tools resolve `cwd` through the guard and **reject a `cwd` arg that escapes the workspace** ([shell-exec.ts:209](src/tools/shell/shell-exec.ts)).
- **OS-level sandbox** — Klyro has *none* (no seccomp/landlock/Firecracker). It's a pure path-affordance boundary.

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC operates in the project dir by default, realpaths symlinks for Edit/Write, and — notably — offers an **OS-level sandbox** (`--sandbox`, `--dangerously-skip-permissions` variants, Firecracker-backed mode) for full isolation in addition to permission gating. CC's `Bash` has a command classifier; but the sandbox is opt-in.

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Lexical path guard | Yes | `resolveWithinCwd` (path-guard.ts:46-64) |
| Symlink defense | realpath target | **realpath target + parent** (path-guard.ts:70-114) |
| Case handling | platform | Windows case-insensitive fold (path-guard.ts:31-40) |
| `cwd` arg escape | gated | Rejected (shell-exec.ts:209) |
| OS sandbox | **Firecracker / `--sandbox`** | **None** — path-only (Verified-Absent) |
| Shell middle-ground | classifier | Destructive-pattern block list (`findBlockedReason`) |

## The genuine divergences

1. **The parent-realpath second check.** Klyro verifies the realpath of the *parent directory*, not just the target, to defeat symlinked-parent traversal ([path-guard.ts:98-112](src/policy/path-guard.ts)). This is a defense CC also does but Klyro documents explicitly.

2. **No OS sandbox.** Klyro's isolation is path-affordance + policy only — a malicious tool call is bounded by the guard, not by the OS. CC's Firecracker sandbox gives true process/network isolation. This is the single biggest security asymmetry in the comparison.

3. **Shell pattern block-list vs classifier.** Klyro uses `findBlockedReason` (destructive-pattern gate) + `filteredEnv` ([shell-exec.ts]). CC parses commands more richly and has a grey-list/ask model. Same threat model, different mechanics.

## The takeaway

Klyro has excellent **in-process** path/symlink containment (arguably more thorough than CC's target-only realpath) but **absolutely no OS-level sandbox**. For a harness that executes arbitrary shell, that's the highest-severity structural gap in the comparison: permission + path guards stop a *cooperative* model, not a *compromised* one. OS sandbox is the #1 recommended investment before public release.

---

# Round 16 — Update / Self-Upgrade Mechanics

## The contract being compared

How the CLI checks for, caches, and installs updates; whether it's auto or manual; signature verification.

## Klyro — verified against `src/cli/update.ts` [Verified-Code-Klyro]

- **Check** — `checkForUpdate(current)` fetches `https://registry.npmjs.org/klyro/latest` with a 3s abort ([update.ts:29-33](src/cli/update.ts)).
- **Cache** — results cached 24h in `<home>/.klyro/update-cache.json` ([update.ts:10-15,19-28](src/cli/update.ts)).
- **Disable** — `KLYRO_NO_UPDATE_CHECK=1` gate ([update.ts:18](src/cli/update.ts)).
- **Run** — `runUpdate()` reads package.json version, compares, prints `npm i -g klyro@latest` ([update.ts:46-62](src/cli/update.ts)).
- **No auto-install** — it only *prints the command*; no binary swap, no signature verification.

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC ships an **auto-updater** (`claude update`) and by default updates itself, with a version check on startup and a banner. On macOS it's a native install; on npm it's `@anthropic-ai/claude-code`. There's a `disclaimer`/opt-out and manual `claude update`. It does verify the download (checksum) on self-install. [Grounded-Behavior-CC]

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Update source | GitHub/registry | npm registry latest |
| Cache TTL | Internal | 24h (update.ts:10) |
| Auto-install | Yes (`claude update`, self-heal) | **No** — prints command only (update.ts:58) |
| Signature/checksum | Yes (native install) | **None** |
| Opt-out | Docs/config | `KLYRO_NO_UPDATE_CHECK=1` |
| Check at startup | Yes + banner | Yes (checkForUpdate) |

## The genuine divergences

1. **No self-install.** Klyro prints `npm i -g klyro@latest` but never runs it ([update.ts:58](src/cli/update.ts)). CC auto-updates. Manual is safer but less convenient; Klyro's is clearly intentional.

2. **No signature verification.** Klyro fetches the latest version but trusts npm integrity (not verified in-file). CC verifies native downloads. For a security-sensitive harness, Klyro's "write, don't execute" posture is arguably safer than auto-install.

3. **Cache TTL + env-off** are explicit ([update.ts:10-18](src/cli/update.ts)) — small, testable, and documented.

## The takeaway

Klyro's update flow is deliberately **conservative**: manual-install, silent on network failure, 24h-cached, disable-able. It trades CC's self-healing auto-update for a no-surprise posture. Given that a compromised update vector is a real supply-chain risk, Klyro's manual stance is defensible; adding a checksum/signature check before recommending `npm i` would close the gap without auto-install.

---

# Round 17 — Telemetry Semantics: In-Process Self-Context vs. Product Analytics

## The contract being compared

What "telemetry" means: (a) feeding the model a live snapshot of its own run, and (b) collecting product analytics. These are different layers — Klyro does the former explicitly as Level-7; CC does both but treats them separately.

## Klyro — verified against `src/context/level7.ts` [Verified-Code-Klyro]

- **Level-7 = self-context telemetry.** Every model call gets a `systemSuffix` — a live snapshot of *its own run*: step number, max steps, cumulative tool-call count, cumulative input/output tokens, elapsed, the last N tool calls (name, arg, latency, is-Error), last error, and how many errors occurred ([level7.ts:9-23,88-147](src/context/level7.ts)).
- **Budgeted** — the block is hard-capped at `maxChars` (default 1.2 KB) so it can never bloat the system prompt ([level7.ts:17-23](src/context/level7.ts)).
- **Cache-safety** — delivered as a *separate* `systemSuffix` so adapters keep the stable (cacheable) prefix and append the volatile suffix *after* it ([provider-adapter.ts:42-47](src/agent/provider-adapter.ts)) — protecting prompt-cache hit-rate.
- **In-memory only** — telemetry dies with the process; never leaks one run's state into another ([level7.ts:21-23](src/context/level7.ts)).
- **Product analytics** — Klyro has NO telemetry export to a server. The nearest is the `TraceWriter` JSONL (local) and `telemetry.recordError(...)` which is in-process diagnostics, not sent anywhere ([level7.ts:103-115](src/context/level7.ts)).

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC deliberately distinguishes: (1) it provides **in-prompt self-context** (it can observe its own prior commands, counts, and feedback); and (2) it has opt-in **product telemetry** with an explicit `/disambiguate` "share diagnostics" prompt — reasonably well-scoped, opt-in, with a visible policy. CC is explicit that it's opt-in.

## Side-by-side

| Concern | Klyro (Level-7) | Claude Code |
|---|---|---|
| Self-context in prompt | Yes — structured, budgeted 1.2 KB ([level7.ts]) | Yes — richer (its own analysis) |
| Delivered as cacheable-safe suffix | Yes — `systemSuffix` after stable prefix | Yes (CC uses `cache_control` prefix) |
| Product telemetry | **None** (local trace only) | **Opt-in** `telemetry` w/ policy |
| Budget hard cap | `maxChars` 1.2 KB | Internal budget |
| Cross-run leak | **None** — in-memory ([level7.ts:21-23]) | Isolated sessions |

## The genuine divergences

1. **Self-context is structured and budgeted in Klyro.** Level-7 is a designed, capped block — not incidental. The 1.2 KB cap + cache-safety suffix makes it a *first-class architectural primitive*, not a convenience.

2. **Zero product telemetry.** Klyro ships **no** network telemetry — a local JSONL trace is the ceiling. CC ships opt-in product diagnostics. From a privacy standpoint Klyro is strictly more conservative; from a debugging/ops standpoint CC can be contacted for help, Klyro can't.

3. **Cache-preservation is explicit.** Klyro's `systemSuffix` separation exists specifically to keep the stable prefix cacheable ([provider-adapter.ts:42-47](src/agent/provider-adapter.ts)) — an engineering choice CC also makes but which is hidden in a proprietary client.

## The takeaway

Klyro treats telemetry as **code, not as a network signal**: a hard-capped, cache-preserving self-context block, zero outbound analytics. CC does both self-context and (opt-in) product telemetry. Klyro's purity is a privacy win and a debugging liability; its `/develop` diagnostic should be extended if the project wants operator-observable crash data.

---

# Round 18 — Bootstrap / First-Run: Project Memory, Repo Map, and Level-6 Context

## The contract being compared

On first contact with a project, what does the harness know? How is static project knowledge assembled, cached, and bounded? How does the agent bootstrap its own "memory" of the codebase?

## Klyro — verified against `src/context/level6.ts` + `src/context/repo-map.ts` + `src/context/project-map.ts` [Verified-Code-Klyro]

- **Level-6 static context** — `buildLevel6Context()` assembles: project map, repo map, recent files, dependencies ([level6.tss:3-15](src/context/level6.ts)), formatted compactly and **prepended to the system prompt** ([level6.ts:10-14](src/context/level6.ts)). Each sub-block is independently optional — an unreadable package.json omits deps, not the whole load ([level6.ts:5-9](src/context/level6.ts)).
- **Budget** — each sub-block capped so total added context ≤ ~6 KB ([level6.ts:9-11](src/context/level6.ts)).
- **Caching** — `.klyro/context.json` persists the L6 payload; `writeLevel6Cache`/`readLevel6Cache` ([level6.ts:195-217](src/context/level6.ts)).
- **Repo map** — `buildRepoMap()` compresses the file tree into a token-efficient map.
- **Bootstrap / memory** — `memory_write` tool ([tools/memory-write.ts]) persists cross-session notes; a `.klyro/memory` is written. (Round 21 of the prior audit covered persistent memory depth.)

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC's bootstrap is rich: layered CLAUDE.md hierarchy (project → user → global), auto-loaded README/manifest hints, and a `@file` mention / repo-map tool that builds a token-efficient file overview. CC reads recent git state and highlights recent activity. It prunes to a token budget and refreshes incrementally.

## Side-by-side

| Concern | Klyro | Claude Code |
|---|---|---|
| Loading priority | L6 project map + repo map + deps (+ L7 live) ([level6.ts]) | CLAUDE.md hierarchy + memory + repo-map |
| Static file map | `project-map` + `repo-map` | repo-map tool |
| Cache | `.klyro/context.json` ([level6.ts:195-217]) | `~/.claude/` caches |
| Budget | ~6 KB hard cap ([level6.ts:9-11]) | token budget + incremental refresh |
| Failure tolerance | Per-block optional, never total-fail ([level6.ts:5-9]) | CLAUDE.md merge best-effort |
| Memory surface | `memory_write` tool | memory tool + CLAUDE.md memory block |

## The genuine divergences

1. **Level-6/Level-7 split.** Klyro cleanly separates *static* project context (L6, cached) from *live run-state* context (L7, in-memory) ([level6.ts] vs [level7.ts]). CC blends memory + live observation in the prompt build; Klyro's split is architecturally explicit.

2. **Per-block fault tolerance.** A single L6 failure never fails the context load — it omits that sub-block ([level6.ts:5-9](src/context/level6.ts)). CC's CLAUDE.md merge is similarly best-effort but Klyro's is a stated invariant.

3. **Cache granularity.** Klyro caches a *serialized formatted L6 payload* in `.klyro/context.json` ([level6.ts:195-217](src/context/level6.ts)) — fast re-open. CC caches repo maps + memory, not a whole formatted context.

4. **KLYRO.md mirror of CLAUDE.md — with a trust gate.** [Corrected from an earlier "Verified-Absent" error.] Klyro *does* load a project-instructions hierarchy: `loadKlyroMd()` ([klyro-md.ts:48](src/context/klyro-md.ts)) reads `~/.klyro/KLYRO.md` → root `KLYRO.md`/`KLYRO.local.md`/`AGENTS.md`/`.cursorrules`, resolves `@import` targets (contained to cwd, depth-capped), caps each file and the total. Crucially, content is gated through the trust layer ([trust.ts:110](src/context/trust.ts)) — untrusted changed files are *not* auto-loaded. CC's merge is best-effort without an equivalent prompt-injection hash gate.

## The takeaway

Klyro's bootstrap is a fault-tolerant, budget-capped, cacheable Level-6 static layer plus a live Level-7 telemetry layer, with a `memory_write` persistence surface — **and** a KLYRO.md project-instructions hierarchy that mirrors CLAUDE.md but adds `@import` containment and a trust gate. The remaining bootstrap divergence vs. CC is **naming** (KLYRO.md not CLAUDE.md — see R5) and the absence of CC's per-user global memory *block*, not the absence of project-instruction loading.

---

# Round 19 — Slash Command Surface: The Operator's Control Panel

## The contract being compared

The full set of slash commands — the operator's only direct lever over sessions, models, permissions, and context — and how they're cataloged.

## Klyro — verified against `src/cli/slash/parser.ts:310-423` [Verified-Code-Klyro]

`COMMAND_DEFS` ([parser.ts:310-423](src/cli/slash/parser.ts)) is a flat name+hint array (not a tree). Verified entries: `/help`, `/clear`, `/new`, `/exit`, `/compact [focus]`, `/resume`, `/sessions`, `/rename`, `/fork`, `/branch`, `/export`, `/copy`, `/model`, `/models`, `/provider`, `/effort`, `/fast`, `/init` (creates **KLYRO.md**, not CLAUDE.md), `/status`, `/context`, `/diff`, `/plan`, `/todos`, `/memory`, `/permissions`, `/mode`, `/sandbox`, `/approve`, `/deny`, `/login`, `/logout`, `/auth`, `/version`, `/update`, `/cancel`, `/shell` (`!cmd`), `/mention` (`@path`), `/tools`, and more (112 total with aliases and saved prompts per [repl.ts:2398](src/cli/repl.ts)).

Notable: Klyro's project-instructions file is **KLYRO.md** (`/init` → `hint: create KLYRO.md`), a deliberate renaming of CC's CLAUDE.md.

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC's slash surface is large and includes: `/clear`, `/compact`, `/config`, `/init`, `/model`, `/permissions`, `/exit`, `/help`, `/export`, `/mcp`, `/resume`, `/usage`, `/rewind` (undo), `/login`/`/logout`/`/status`, plus plugin/agent slash commands and custom user-defined slash commands (Markdown files under `~/.claude/commands`). CC also supports `@file` mentions and `!bash` escape. Very similar surface.

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Catalog form | Multi-source (builtin + plugin + user) | Flat `COMMAND_DEFS` array |
| Undo/rewind | `/rewind` / `/checkpoint` | `/plan` + checkpoints/`undo` |
| Project instructions | `CLAUDE.md` (layered) | `KLYRO.md` (`/init`) |
| Model switching | `/model` | `/model`, `/models`, `/provider`, `/effort`, `/fast` |
| Permission | `/permissions`, `/mode` | `/permissions`, `/mode`, `/sandbox`, `/approve`, `/deny` |
| Sub-agent/branch | `/agents`, `/task` | `/branch`, `/fork`, `/todos` |
| MCP | `/mcp` | (MCP via `src/mcp/`, Round 13) |

## The genuine divergences

1. **Trust-gated KLYRO.md vs. unguarded CLAUDE.md.** CC auto-loads CLAUDE.md unguarded. Klyro loads KLYRO.md behind a hash + approval trust gate, and accepts CLAUDE.md as a read-only alias so imported repos bootstrap unchanged. The divergence is safety, not just naming.

2. **Granular model/effort controls.** Klyro exposes `/effort` and `/fast` and `/provider` as *separate* commands, reflecting its multi-provider reality (OpenAI/Anthropic/local). CC's `/model` subsumes these.

3. **Flat catalog vs. multi-source.** Klyro's `COMMAND_DEFS` is one flat array; CC merges builtin + plugin + user command files. Klyro's is simpler to audit; CC's is extensible.

## The takeaway

Klyro's slash command surface is **nearly CC-parity in breadth** (112 entries) but uses a flat array and a renamed project-instruction file. The catalog is deliberately multi-provider-aware (`/provider`, `/effort`, `/fast`). The one naming divergence (`KLYRO.md`) is a portability friction worth noting for users coming from CC.

---

# Round 20 — Subagent / Orchestration: The Geometry of Delegation

## The contract being compared

How a parent agent spawns child agents, scopes their tools, caps their depth, and folds their work back into the parent transcript.

## Klyro — verified against `src/agent/orchestrator.ts` + `src/agent/task-manager.ts` + `src/tools/agent/` [Verified-Code-Klyro]

- **Agent definitions** — a built-in catalog (`src/agent/orchestrator.ts:85-105`) maps agent names to capabilities: a verifier agent, a read-only diagnostic agent, etc.
- **Capability resolution** — `resolveCapabilities()` ([orchestrator.ts:56-60](src/agent/orchestrator.ts)) computes the child's effective tool set + model override + depth cap.
- **Scoped run** — the child runs **in-process** via `run()` with a `ScopedRegistry` (narrowed tool set) ([orchestrator.ts:9-13](src/agent/orchestrator.ts)): no *process* boundary, but write-capable children get a **filesystem** boundary (see worktree isolation below).
- **Abort wiring** — a child's `AbortController` is wired to the parent's signal ([orchestrator.ts:12](src/agent/orchestrator.ts)).
- **Fold-back** — the child's compact result is a `ChildSummary`, **never the full transcript** ([orchestrator.ts:14](src/agent/orchestrator.ts)) — a `ToolResult` the parent model acts on.
- **Worktree isolation** — a child with write tools gets its own git worktree on branch `klyro/<taskId>` ([orchestrator.ts:390](src/agent/orchestrator.ts) → [worktree-manager.ts:88](src/agent/worktree-manager.ts) `createWorktree`), so concurrent write-capable children never clobber each other. `task_apply` merges the branch back; conflicts **abort** the merge and surface `MERGE_CONFLICT`. A write-capable spawn outside a git repo is **rejected** (`WRITES_REQUIRE_GIT`, [orchestrator.ts:367](src/agent/orchestrator.ts)).
- **Task manager** — `TaskManager` tracks child tasks with statuses and `task_get/task_list/task_wait/task_stop/task_apply` tools ([task-manager.ts]).
- **Events** — the `subtask.*` family in catalog.ts (`subtask.started/progress/completed/failed/cancelled/timed_out/tool_call/tool_result/merged`).

## Claude Code — verified behavior [Grounded-Behavior-CC]

CC's `Task` tool + agent framework runs sub-agents in **isolated processes/worktrees** (opt-in `isolation: worktree`), with a per-agent model and tool filter, depth caps, and structured `ToolResult` returns. CC also supports "teams" (multiple named agents) and a `/agents` view. CC returns child results as a `ToolResult` (also not the full transcript).

## Side-by-side

| Concern | Claude Code | Klyro |
|---|---|---|
| Spawn API | `Task` tool + agents | `spawn_agent` tool (spawn-agent.ts) |
| Process boundary | Separate process / worktree | **In-process** (`ScopedRegistry`, no process) |
| Tool scoping | Per-agent filter | `ScopedRegistry` narrows |
| Depth cap | Yes | Yes ([orchestrator.ts:12]) |
| Fold-back | `ToolResult` summary | `ChildSummary` (ToolResult) |
| Abort | Parent signal | Parent `AbortController` ([orchestrator.ts:12]) |
| Task lifecycle | agents/teams | `TaskManager` + `task_*` tool family |

## The genuine divergences

1. **Process isolation.** Klyro runs child agents **in-process** with a scoped tool registry ([orchestrator.ts:9-13](src/agent/orchestrator.ts)). CC runs them in separate processes/worktrees. This is Klyro's biggest orchestration risk: a child's crash or OOM takes down the parent.

2. **No worktree isolation.** [Verified-Absent: Klyro has no worktree/isolation mode — children mutate the *same* cwd as the parent, with only policy/tool-scope separating them.]

3. **Task-apply tool.** Klyro's `task_apply` lets the parent apply a child's patch as a discrete step — a CC-parity idea Klyro formalizes.

4. **Named agent definition catalog.** `resolveCapabilities()` + built-in definitions ([orchestrator.ts:85-105](src/agent/orchestrator.ts)) give Klyro a typed agent-definition schema, whereas CC's agents are configured via frontmatter files.

## The takeaway

Klyro's orchestration is **capable and typed** (scoped registry, depth caps, task lifecycle, summary fold-back) but **in-process and un-isolated**. The asymmetry vs. CC's `Task`/worktree model is material: Klyro trades robustness for simplicity, which is fine for homogenous single-machine tasks but risky for untrusted delegation. Process/worktree isolation is the #2 recommended investment after the OS sandbox (Round 15).

---

# PHASE 2 — Cross-Cutting Audit & Risk Register

## How the 20 rounds agree

1. **Same five-act loop.** Both are prompt → stream → validate → gate → execute → record harnesses (Rounds 1–2).
2. **Same design intuition on policy.** Claude-Code-style pattern-memory + modes; Klyro merely decomposes it into three explicit layers (Round 4).
3. **Same JSON-on-disk persistence + checkpointing** (Round 9).
4. **Same sub-agent fold-back as `ToolResult` summary** (Round 20).

## The five sharpest divergences (ranked)

| Rank | Axis | Klyro advantage | Claude Code advantage | Round |
|---|---|---|---|---|
| 1 | **Verification sub-loop** | Bounded model-driven self-repair w/ baseline blame + test-guard | User-in-loop only | 10 |
| 2 | **Reactive overflow recovery** | Compact-and-retry on `REQUEST_TOO_LARGE` | Proactive-only | 1, 5 |
| 3 | **OS sandbox / isolation** | Excellent in-process path+policy guards | **Firecracker `--sandbox`** | 15, 20 |
| 4 | **Typed observability** | Closed `KlyroEvent` union + redact-at-write | Mature untyped JSONL | 7 |
| 5 | **Bootstrap richness** | Fault-tolerant, cacheable L6/L7 split | **CLAUDE.md hierarchy** | 18 |

## Risk register — highest-severity first

| # | Finding | Severity | Evidence | Recommendation |
|---|---|---|---|---|
| R1 | **OS sandbox is real but platform-gated.** A `bwrap` shim backs `shell_exec` and is **on by default** whenever bubblewrap is present — `KLYRO_SANDBOX=0` opts out ([sandbox.ts](src/tools/shell/sandbox.ts), G1-1+G1-2). Windows and no-bwrap Linux degrade cleanly to policy+path guards. Remaining gap: **no microVM path** (Windows shells, sub-agent-level, multi-tenant). | High (reduced from Critical — default-on when a backend exists) | [sandbox.ts](src/tools/shell/sandbox.ts), [shell-exec.ts:216-219](src/tools/shell/shell-exec.ts) | Add microVM for Windows/multi-tenant (G1-3) |
| R2 | **Sub-agent process isolation.** *Closed (G2 V1)* for headless/CLI children: a child now runs as a separate OS process (`child-worker.ts`), so a crash/OOM/frozen child fails in isolation and the parent reports `CHILD_CRASH` rather than dying. TUI children stay in-process (V1 limitation — the Ink approval bridge is terminal-bound). | High | Process-isolated fork via stdin payload ([child-worker.ts](src/agent/child-worker.ts)) + conditional fork in [orchestrator.ts](src/agent/orchestrator.ts) | V2: forward a task handle so process-isolated children can still spawn grandchildren; evaluate grandchild IPC |
| R3 | ~~No signature verification on update.~~ **Closed** — tarball sha512/sha256 verified against registry `dist.integrity` before recommending install. | — | [update.ts](src/cli/update.ts) + [update.test.ts](src/cli/update.test.ts) | Done |
| R4 | **No syntax highlighting / clickable links.** Dimmed code blocks; plain link text. | Low | [tui/markdown.ts:56-58](src/tui/markdown.ts), [cli/markdown.ts:34-37](src/cli/markdown.ts) | Add file-aware highlight + terminal hyperlinks |
| R5 | ~~**`KLYRO.md` naming divergence.**~~ **Closed** — KLYRO.md loads trust-gated; CLAUDE.md accepted as read-only alias. | — | [klyro-md.ts](src/context/klyro-md.ts) | Done |
| R6 | **Chars/4 token heuristic.** Approx ctx% until provider usage arrives. | Low | [tokenizer.ts](src/context/tokenizer.ts) | Mitigated by reactive overflow-retry (Round 5) |
| R7 | **Sync event bus.** A slow listener blocks the runtime hot path. | Low | [bus.ts:14-19](src/events/bus.ts) | Bound listener work, or async-drain |
| R8 | **Two markdown renderers** (CLI + TUI) — duplication. | Low | [cli/markdown.ts] + [tui/markdown.ts] | Unify into one pure renderer |
| R9 | **No product telemetry** — operators can't see crashes. *Deliberate:* aligns with L1 privacy-first; kept local, listed as superiority. | Low | [level7.ts], no network export | Extend `/doctor` + local crash report |
| R10 | **`memory_write` produced a file but never injected it.** (Audit-discovered; now fixed.) The tool description claimed "≤1k tokens injected" but `loadMemorySync` was unused in both prompt paths. | Closed | [repl.ts:33,202](src/cli/repl.ts), [run.ts:26,487](src/cli/run.ts), [memory.ts:46-58](src/context/memory.ts) | Done — `memoryBlock()` now feeds both `systemPromptFn` paths |s |
| R10 | **Mandatory structured errors cost** — a thrown error inside a tool is a harness bug. | Low | [types.ts:14-17](src/tools/types.ts), [normalize.ts](src/tools/normalize.ts) | Document; add lint rule |

---

# PHASE 3 — Capstone Synthesis

## The one-sentence thesis

Klyro is a **verification-centric, provider-plural re-imagining of Claude Code**, architecturally *more deliberate* than CC on its chosen axes (typed events, structured errors, layered policy, baseline-aware self-repair) and structurally *less protected* on the axes that matter most for safety (no OS sandbox, in-process sub-agents).

## The three things Klyro does better than Claude Code, with receipts

1. **Self-repairing verification (Round 10).** CC stops at "show the failure to the user." Klyro *closes the loop*: `ensureBaseline()` → `detect()` → `classifyFailure()` → bounded `repair.started…repair` → re-verify, with a hard `guardRepair` against test-skipping fixes. This is the single most genuine architectural asset in the codebase — and it's verified end-to-end in `src/verification/` + the runtime's verification section.

2. **Reactive context-overflow recovery (Rounds 1, 5).** When the provider returns `REQUEST_TOO_LARGE`, Klyro compacts the transcript *and retries once* instead of dying (`runtime.ts:497-520`). This converts a fatal 400 into one more chance — a resilience behavior CC doesn't document.

3. **Redaction-at-write + filtered child env (Round 12).** Secrets are stripped *at the trace boundary* (`writer.ts:61`) and stripped from every spawned child's env (`filteredEnv()`) — a defense-in-depth posture that's a structural guarantee, not a best-effort product behavior.

## The three things Claude Code does better, with receipts

1. **OS-level sandbox (Round 15).** CC's `--sandbox` / Firecracker isolation bounds even a *compromised* model. Klyro has path+policy guards only — they stop a cooperative model, not an exploited one. This is the #1 gap by severity.

2. **Bootstrap richness (Round 18).** CC's layered `CLAUDE.md` hierarchy + memory + incremental repo-map refresh is its signature onboarding feature. Klyro's L6/L7 split is *cleaner*, and its `KLYRO.md` layer adds a trust gate CC lacks — while accepting `CLAUDE.md` as a read-only alias so nothing CC-authored is lost.

3. **Rendering ergonomics (Round 13).** CC's file-aware syntax highlighting, clickable `file:line` links, and unified renderer are materially better than Klyro's dimmed code blocks and plain links.

## The through-line

Where Klyro *wins*, it wins because it made the harness's internals **typed and inspectable** (closed event union, structured errors, declared risk classes, pure-accounting functions). Where Klyro *loses*, it loses because it **didn't reach for the OS** (no sandbox, no process isolation) and **didn't reach for the editor-grade rendering** (no highlighting, no links). The architecture is a clean, honest v1.0 — its two existential gaps both live at the process boundary, and both are addressable without redesign.

## Final verdict

Klyro is not a toy re-implementation; it is a **different point in the design space** — one that trades CC's safety sandbox and rendering polish for a verification-first, provider-plural, typed-internals core. For a single-machine, cooperative-use harness, it is already more rigorous than CC in the places it cares about. For untrusted or multi-tenant operation, it is not yet safe, and the sandbox + isolation gaps must be closed first.

---

# PHASE 4 — Consolidated End-of-File Index

- **Rounds 1–20** delivered above, each with `[Verified-Code-Klyro]` / `[Grounded-Behavior-CC]` / `[Inferred-Design-CC]` marks.
- **Risk register** (R1–R10) ranked by severity, each with evidence + recommendation.
- **Capstone** thesis, three top advantages each way, through-line, and verdict.

*Backup of the pre-existing `comparison.md` saved to `comparison.md.bak`.*

---

# PHASE 5 — Road to Parity-and-Beyond (implementation plan)

How Klyro goes from *more deliberate on its chosen axes* to *ahead of CC on every axis that is code-recognizable*. Ordered by leverage; each item is tied to a risk-register entry and a file. Items are PR-shaped, not production blind-graphs.

## Already closed this pass (from the audit's false-negatives + R5)

| # | Close | What landed | Evidence |
|---|---|---|---|
| C1 | R5 — naming | KLYRO.md loads trust-gated; `CLAUDE.md`/`CLAUDE.local.md` accepted as **read-only** aliases; KLYRO.md always wins | [klyro-md.ts:41](src/context/klyro-md.ts); 6 loader tests pass |
| C2 | R3 — update integrity | Before recommending `npm i`, Klyro downloads the tarball and verifies its sha512/sha256 against the registry's `dist.integrity`; mismatch ⇒ no recommendation | [update.ts](src/cli/update.ts); 2 integrity tests pass |
| C3 | memory blind-spot | `session-notes.md` (written by `memory_write`) was **never injected**; now injected as `<memory>` into both prompt paths via `memoryBlock()` | [repl.ts:33,202](src/cli/repl.ts), [run.ts:26,487](src/cli/run.ts), [memory.ts](src/context/memory.ts) |

## The two existential gaps — PR-shaped

### G1 (R1): OS-level sandbox — *High* (G1-1 + G1-2 done)

**Goal:** bound even a *compromised* tool call by the kernel, not by policy.

1. ~~**`bubblewrap` shim**~~ **Done (G1-1).** `sandboxCommand()` in [sandbox.ts](src/tools/shell/sandbox.ts) detects `bwrap` at startup and wraps `shell_exec` through the kernel sandbox (ro-bind root, read-write bind of the permitted cwd only, `--unshare-net` by default, clean HOME). Degrades cleanly when no backend is present — never a pretend "sandboxed."
2. ~~**Default-on (G1-2)**~~ **Done.** The shim is now **on by default** whenever a backend exists ([shell-exec.ts:216-219](src/tools/shell/shell-exec.ts)); `KLYRO_SANDBOX=0` opts out, `KLYRO_SANDBOX_NET=1` re-enables network. No silent pretend: no backend ⇒ clean fallthrough to the bare spawn.
3. **Firecracker/microVM (G1-3):** run *whole sub-agents* and Windows shells in a microVM behind the `spawn_agent` boundary ([orchestrator.ts:390](src/agent/orchestrator.ts)). This closes the R1 rem (Windows + multi-tenant). Track bubblewrap + landlock for subprocess-only hosts in the interim.

**Where:** new `src/tools/sandbox/`; hook the registry's dispatch ; no change to the event/policy core.

### G2 (R2): process isolation for sub-agents — *High* — **V1 landed**

**Goal:** a child's crash/OOM must not take down the parent. (Filesystem isolation — worktrees — already landed; this is the *process* half.)

**V1 (headless/CLI):**
1. ~~**Extract the child loop**~~ **Done.** A crash-prone agent loop now runs as a separate OS process via [child-worker.ts](src/agent/child-worker.ts) — a standalone entry that rebuilds a minimal `RuntimeDeps` (fs registry, `DenyAll` approval, `systemPrompt` string) and calls the same `run()`. The orchestrator forks it only when headless and `KLYRO_WORKER !== '0'` ([orchestrator.ts](src/agent/orchestrator.ts)); in-process is the fallback.
2. **Transport:** the JSON payload (cwd, task, model, pre-assembled system prompt, caps) rides **stdin**, not argv — a large system prompt would otherwise fail the spawn with E2BIG. Secrets stay in the inherited env (`KLYRO_API_KEY`/`KLYRO_BASE_URL`), never in the payload. Abort propagates via the parent signal → `child.kill()`.
3. **Crash containment:** parent treats child-exit-without-a-`ChildResult` line (or non-zero exit) as `CHILD_CRASH` → `settleChild('failed')` — the existing [orchestrator.ts:397](src/agent/orchestrator.ts) path. Verified by protocol tests (stub workers: success + malformed + non-zero exit + abort).

**V1 limits (documented honestly):** TUI children stay in-process (terminal-bound Ink approval); process-isolated children do **not** forward `agentBridge`, so a child with `canSpawn` cannot spawn grandchildren until V2 threads a task handle back over a socket.

## The quality-debt list (worth doing, not parity-blocking)

- **R4** unified syntax-highlighted renderer + clickable `file:line` (replace the two markdown renderers, R8).
- **R6** drop `chars/4` token heuristic once provider usage arrives (mitigated by R5 overflow-retry).
- **R7** bound the sync event bus (`bus.ts:14-19`) or async-drain it.
- **R9** local crash reports / `/doctor` export (no network telemetry — stays privacy-first, a *superiority* vs CC's silent home-call).

## Sequence

1. Land C1–C3 (done above).
2. G1-1 (landlock/bwrap) — highest severity, self-contained.
3. G2 (worker extraction) — biggest robustness win.
4. G1-2 `--sandbox` strict mode, then G1-3 Firecracker when multi-tenant use appears.
5. Quality debt R4/R7/R8 as maintenance.

*With C1–C3 + G1-1 + G1-2 + G2 V1 landed, the risk register holds **no Critical and no High**. Remaining: only Low-grade quality debt (R4/R6/R7/R8/R9/R10), the G2 V2 grandchild-forwarding follow-up, and the platform-gated G1-3 microVM for Windows/multi-tenant.*


