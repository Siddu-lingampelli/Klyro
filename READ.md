# Klyro — Complete Build Documentation

**For any coding agent:** This file is the single source of truth for what has been built till now (v0.1.15, Levels 1-5 complete, Level 6-8 partial, TUI full-screen). After reading, you have the complete picture.

---

## 1. What is Klyro?

**Klyro** is an autonomous AI coding harness — a terminal-native agent that understands repositories, executes tools, verifies its work, and repairs failures.

> **Vision:** *Build a highly autonomous software engineering harness capable of understanding complex codebases, executing long-running tasks, dynamically coordinating workflows, verifying its own work, and continuously improving through evaluation.* — `PRD.md:3`

**Not a chatbot.** The harness wraps the model: `CLI → Session → Context → Agent Runtime → Model → Tool → Observation → Verification → Repair → Persistence`.

**Current version:** `0.1.15` (`package.json:3`, `npm view klyro dist-tags → latest:0.1.15`, `43 files 309/309 tests`)

---

## 2. Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript 5.5, Node 20+ | Strict, `NodeNext`, `tsc` → `dist/` |
| CLI | `commander 12.1` | Stable, `InvalidArgumentError` for `exit 2` |
| TUI | `ink 7.1` + `react 19` + `ink-spinner 5` | React for terminal, proven by Claude Code/Gemini |
| Schema | `zod 4.5` | Tool input validation + config schema |
| Test | `vitest 4.1` `fileParallelism:false` `10s timeout` | `node` env, deterministic mocks |
| Build | `tsc` (not `tsup`) | `tsc --noEmit` `typecheck`, `tsc` `build` |
| Providers | Native `fetch` (Node 20) | No SDK lock-in, 3 adapters |
| Workspace | `pnpm-workspace.yaml` `packages/*` | `shared` `KlyroError` |
| CI | `.github/workflows/ci.yml` `ubuntu/macos/windows × 20/22` | `pnpm install` `typecheck` `test` `build` `pack` |

**No Docker, no MCP, no browser in MVP** — deferred to post-1.0.

---

## 3. Architecture (Full)

```
USER
  │
  ▼
CLI / TUI (ink)  ←→  Global flags (--cwd/--config/--debug/--json) + completion + update + login
  │
  ▼
Session Manager (SessionStore + TraceWriter + AuditLog)
  │
  ▼
Task Analyzer
  │
  ▼
Context Engine (L6 ProjectMap + L7 Telemetry + L8 Accounting)
  │
  ▼
Agent Runtime (ProviderAdapter → Policy → Registry → Tool → Observation → Repair)
  │
  ├─ Model Layer (OpenAI httpChatAdapter / Anthropic anthropicAdapter / retryingAdapter)
  ├─ Tool Registry (18 tools: fs/search/shell/git/verify/plan)
  ├─ Policy Engine (modes default|plan|accept-edits|auto + .env guard)
  ├─ Memory Engine (history 40 turns / 80k chars, pair-preserving)
  └─ Verification Engine (verify + detect + auto + repair loop ≤3)
  │
  ▼
Repair Loop (verify → classify → diagnosis → repair → re-verify)
  │
  ▼
Completion Engine (diff + report + status)
  │
  ▼
Observability ( Ink transcript + status line + trace JSONL)
  │
  ▼
Evals (harness + fixtures + compare)
```

**Data Flow (one `klyro run`):**
```
Task → makeRunSystemPrompt() injects L6 (12k) + KLYRO.md (4k) + telemetry
     → CallRequest{system, transcript, tools} → ProviderAdapter.stream()
     → StreamEvent{ text_delta | tool_call_start/delta/end | message_end | error }
     → finalize ToolUseBlock → PolicyEngine.evaluate() → ApprovalPrompt → registry.execute()
     → redactOutput() deep → transcript.push(tool_result) → telemetry.record*()
     → hasEdits? → verify() → detect() → diagnosticForModel() → repair (up to 3)
     → checkpoint (SessionStore + TraceWriter) per step
     → onEvent → stdout/stderr (human) | JSONL | TUI
```

---

## 4. 20-Level Plan — Status

| Level | Title | Spec `plan.md` | Status | Key Files |
|-------|-------|----------------|--------|-----------|
| **1** | Professional CLI Foundation | `1.1` Skeleton `1.2` Parser `1.3` Config `1.4` REPL `1.5` Output | **5/5 PASS** | `src/index.ts:50` `src/cli/config.ts:10` `src/cli/doctor.ts:1` `src/tui/app.tsx:14` |
| **2** | AI Chat Core | `2.1` Provider `2.2` OpenAI `2.3` Messages `2.4` Streaming `2.5` Cost/headless | **5/5 PASS** | `src/providers/model-info.ts:1` `src/cli/auth.ts:1` `src/context/system-prompt.ts:1` `src/tui/status.tsx:30` |
| **3** | Tool Runtime | `3.1` Events `3.2` read/write `3.3` shell `3.4` Permissions `3.5` Loop | **5/5 PASS** | `src/events/catalog.ts:1` `src/tools/fs/read-file.ts:39` `src/tools/shell/shell-exec.ts:20` `src/policy/engine.ts:34` `src/agent/runtime.ts:375` |
| **4** | Repository Coding Agent | `4.1` Edit core `4.2` Fuzzy `4.3` Navigation `4.4` KLYRO.md `4.5` Checkpoints | **5/5 PASS** | `src/tools/fs/edit-file.ts:26` `src/tools/fs/multi-edit.ts:1` `src/context/klyro-md.ts:1` `src/checkpoints/store.ts:1` |
| **5** | Autonomous Task Loop + Eval | `5.1` Limits `5.2` Stuck `5.3` Plan `5.4` Harness `5.5` Suite | **5/5 PASS** | `src/agent/runtime.ts:152` `phases` `src/tools/plan/todo-write.ts:1` `evals/fixtures/*` `evals/results/baseline.json` |
| **6** | Verification + Repair | `6.1` Verifiers `6.2` Parsers `6.3` Scoped `6.4` Repair `6.5` Contract | **PARTIAL** (engine exists, but harness needs `check.sh` from 5.5) | `src/verification/engine.ts:28` `auto.ts:10` |
| **7** | Codebase Intelligence | `7.1` Scanner `7.2` RepoMap `7.3` Search `7.4` Symbols | **PARTIAL** (heuristic, no tree-sitter) | `src/context/project-map.ts:352` `repo-map.ts:33` |
| **8** | Context Intelligence | `8.1` Accounting `8.2` Lifecycle `8.3` Compaction | **STUB** (tokenizer exists, not wired) | `src/context/tokenizer.ts:35` |
| **9** | Sessions, Persistence | `9.1` Store `9.2` Continue | **PARTIAL** (JSON store, no SQLite) | `src/persistence/store.ts:52` `session.ts:10` |
| **10** | Professional Harness | MCP, Hooks, SDK | **NOT STARTED** | — |
| **11-20** | Multi-Agent → Adaptive Platform | | **NOT STARTED** | — |

**Graduation for L1-L5 — PASS** (verified `vitest 309/309`, `klyro --version --help config list doctor -p "hi"`, `20-turn`, `cancel <1s`, `10/10 smoke` `evals/fixtures`).

---

## 5. Detailed Flows (Per Level)

### L1 — CLI
```
klyro --version → readVersion() tries 3 candidates src/index.ts:28 → 0.1.15
klyro --help → commander tree src/index.ts:50 + showSuggestionAfterError
klyro → isTTY ? startRepl() : repl() src/index.ts:84 + --tui/--chat + -p headless src/index.ts:60
klyro config → 5-layer loadMergedConfig() src/cli/config.ts:80 → Zod validate → JSONC stripJsonComments()
klyro doctor → 7 checks src/cli/doctor.ts:20 (Node/config/Provider/Sessions/git/Tools/Platform)
```

### L2 — AI Chat
```
Provider resolution: flags → env KLYRO_PROVIDER → inferProviderFromBaseURL() src/agent/registry.ts:40 (9router→openai alias) → httpChatAdapter / anthropicAdapter
Streaming: httpChatAdapter.stream() src/agent/provider-adapter.ts:202 → fetch POST /chat/completions stream:true → SSE \n\n → toolIds map + pendingUsage + redacted error
Retry: retryingAdapter src/agent/retry.ts:46 streamWithAbort() + it.return() + combined signal (req.signal + opts.signal)
Cost: getModelInfo() src/providers/model-info.ts:1 estimateCost() → StatusLine src/tui/status.tsx:30 $0.043 · ctx 6%
Headless: klyro -p "hi" argument('[prompt]') src/index.ts:60 → runOnce output json|stream-json
```

### L3 — Tool Runtime
```
KlyroEvent bus src/events/bus.ts:1 globalBus.emit() + TraceWriter src/trace/writer.ts:1 JSONL fsync on tool.result
Tool<TInput,TOutput> src/tools/types.ts:1 {name, description, inputSchema, permission, isConcurrencySafe, renderCall}
read_file: 2000 window src/tools/fs/read-file.ts:70, 10MB refusal src/tools/fs/read-file.ts:49, binary null-byte src/tools/fs/read-file.ts:60, 8k tokens hint
write_file: wasRead guard src/tools/fs/read-history.ts:1, diff, 0600, atomic tmp+fsync
shell: 120s max 600s src/tools/shell/shell-exec.ts:20, persistentCwd, filteredEnv(), 30k head+tail → ~/.klyro/tool-output/<id>.txt, tree-kill taskkill/SIGKILL, interactive block
Policy: mode default|plan|accept-edits|auto src/policy/engine.ts:34, glob allow/deny/ask matchesGlobRule() src/policy/engine.ts:120, .env deny src/policy/engine.ts:99, sandbox --add-dir
Loop: stream→collect → no tools? return → policy → parallel if all isConcurrencySafe src/agent/runtime.ts:386 → Promise.all else sequential
```

### L4 — Repository Coding
```
edit_file: EOL CRLF/LF src/tools/fs/edit-file.ts:40, BOM src/tools/fs/edit-file.ts:40, trailing newline, staleness mtime+hash src/tools/fs/edit-file.ts:26, actionable findClosestMatch() src/tools/fs/edit-file.ts:70
Fuzzy tiers after exact fails: trailing-whitespace → indent → unicode quotes → line-window 0.95 src/tools/fs/edit-file.ts:40
multi_edit atomic src/tools/fs/multi-edit.ts:10, apply_patch Codex tolerant src/tools/fs/apply-patch.ts:1
Navigation: list_dir/glob/grep respect .klyroignore, git_log/status/diff src/tools/git/git-log.ts:1, background shell src/tools/shell/background.ts:1 1MB ring
KLYRO.md: loadKlyroMd() ~/.klyro/KLYRO.md → KLYRO.local.md → subdir lazy src/context/klyro-md.ts:1 @import depth5
Checkpoints: snapshot() src/checkpoints/store.ts:13 .klyro/checkpoints/<id> → diff vs HEAD → undo/rewind
```

### L5 — Autonomous Loop + Eval
```
Loop controller: maxSteps alias maxTurns src/agent/runtime.ts:152, maxCost/maxTimeMs src/agent/runtime.ts:180 → status:limit phase:limit exit 7
Phases: understanding→exploring→planning→implementing→verifying setPhase() src/agent/runtime.ts:180 phase.changed
Stuck: identical call×3 src/agent/runtime.ts:180, same file >8× fileEditCounts, ≥5 fails → [system note]
Planning: todo_write src/tools/plan/todo-write.ts:1 → .klyro/plans/todos.json, plan mode blocks writes, ask_user src/tools/plan/ask-user.ts:1 HEADLESS → KLYRO_AUTO_ANSWER
Eval: FileFixture {dir, task.md, check.sh, meta.json} loadFileFixture() src/eval/harness.ts:130, runFileFixture() tmp cp + bash -c check.sh, harness 10 fixtures evals/fixtures/*, baseline evals/results/baseline.json 8/10, compareReports() src/eval/harness.ts:180, klyro eval --suite smoke src/cli/eval.ts:84
```

---

## 6. File Structure (Purpose)

```
klyro/
├── package.json                 # klyro 0.1.15, bin klyro/ky, files [dist], commander/ink/zod
├── pnpm-workspace.yaml          # packages/*
├── tsconfig.json                # ES2022, NodeNext, strict, noUncheckedIndexedAccess
├── vitest.config.ts             # include src/**/*.test, fileParallelism:false
├── .github/workflows/ci.yml     # ubuntu/macos/windows × 20/22 → typecheck/test/build/eval smoke
├── src/
│   ├── index.ts                 # commander entry: tui/run/chat/eval/session/resume + global flags --cwd/--config/-p
│   ├── chat.ts                  # one-shot chat, normalizeBaseURL, assertSafeBaseURL (loopback+private+ALLOW_INSECURE), streamToStdout \n\n, writeWithBackpressure, readBoundedText
│   ├── repl.ts                  # legacy readline REPL, history 40/80k, trimHistory pair-preserving
│   ├── providers.ts             # resolveProvider() probe Ollama 11434 etc 600ms, providerHelp()
│   ├── agent/
│   │   ├── runtime.ts           # run() loop: CallRequest → ProviderAdapter → policy → registry → checkpoint → verify→repair (≤3) → trace
│   │   ├── message.ts           # Message{role, content: TextBlock|ToolUseBlock|ToolResultBlock}
│   │   ├── provider-adapter.ts  # httpChatAdapter, buildChatCompletionsBody, streamChatCompletions \n\n + pendingUsage + redact + isConcurrencySafe
│   │   ├── anthropic-adapter.ts # anthropicAdapter, x-api-key, indexToToolId map, assertSafeBaseURL
│   │   ├── registry.ts          # buildProvider(), inferProviderFromBaseURL() 9router→openai, isLoopback, retryingAdapter
│   │   ├── retry.ts             # retryingAdapter, computeBackoff, streamWithAbort it.return()
│   │   ├── worker-spawner.ts    # stub for future sub-agents
│   │   └── observation.ts       # ObservationStore (placeholder)
│   ├── tools/
│   │   ├── types.ts             # Tool<TIn,TOut> + ToolContext{sessionId,permissions,logger,emit}
│   │   ├── registry.ts          # ToolRegistry 18 tools: fs/search/shell/git/verify/plan
│   │   ├── schema.ts            # zodToJsonSchema (Zod3/4)
│   │   ├── normalize.ts         # safe(), TOOL_ERROR_CODES
│   │   ├── fs/read-file.ts      # 2000 window, 10MB, binary, 8k hint, wasRead
│   │   ├── fs/write-file.ts     # 0600 tmp+fsync, diff, needsApproval
│   │   ├── fs/edit-file.ts      # EOL/BOM/trailing, staleness, findClosestMatch, fuzzy tiers
│   │   ├── fs/multi-edit.ts     # atomic sequential
│   │   ├── fs/apply-patch.ts    # Codex tolerant
│   │   ├── fs/read-history.ts   # wasRead Set
│   │   ├── fs/list-dir.ts       # depth, .klyroignore
│   │   ├── search/glob.ts       # globToRegex **, SKIP_DIRS
│   │   ├── search/grep.ts       # RegExp g + lastIndex, binary skip, 500 cap, ReDoS risk noted
│   │   ├── search/search-files.ts# fzf query, firstParty+recency ranking
│   │   ├── search/recent-files.ts# mtime >= since, .map skip
│   │   ├── search/dependencies.ts# npm/py/go/rust/Cargo parsers
│   │   ├── shell/shell-exec.ts  # 120s, persistentCwd, filteredEnv, 30k head+tail, tool-output file, DANGEROUS_PATTERNS + $HOME
│   │   ├── shell/background.ts  # 1MB ring, startBackground/getOutput/killJob
│   │   ├── git/git-status.ts    # porcelain + branch + log
│   │   ├── git/git-log.ts       # read-only
│   │   └── verify/run-verify.ts # 5m, 256k cap
│   ├── context/
│   │   ├── repo-map.ts          # regex symbols ts/js/py/go/rs, 500 files
│   │   ├── project-map.ts       # language/framework/PM/test detection
│   │   ├── level6.ts            # buildLevel6Context 12k = project+repo(40)+recent(15)+deps
│   │   ├── level7.ts            # RuntimeTelemetry step/tools/errors/tokens
│   │   ├── tokenizer.ts         # estimateTokens chars/4, compressTranscript deep-copy
│   │   ├── selector.ts          # selectFiles (dead, not wired)
│   │   ├── snippets.ts          # readSnippet windowed
│   │   └── system-prompt.ts     # buildSystemPrompt layered identity→env→global
│   ├── policy/
│   │   ├── engine.ts            # PolicyEngine 4 rules + mode/ glob/.env/add-dir
│   │   ├── approval.ts          # StdinApprovalPrompt/DenyAll/InMemoryAllowlist + TuiApprovalBridge
│   │   ├── path-guard.ts        # resolveWithinCwd + resolveAndFollowSymlinks (TOCTOU noted)
│   │   └── secret-redactor.ts   # redact() 7 patterns + createRedactor 1KiB tail
│   ├── persistence/
│   │   ├── store.ts             # SessionStore JSON per session + sessions.json index (atomic tmp→fsync→rename, retry)
│   │   ├── session.ts           # getDefaultSessionsDir ~/.klyro/sessions, formatSession, resolveSessionId prefix
│   │   └── audit.ts             # AuditLog JSONL
│   ├── verification/
│   │   ├── engine.ts            # verify() spawn shell, timeout SIGKILL, detect(), diagnosticForModel()
│   │   ├── detect.ts            # heuristic type/test/lint/build/runtime + summarize()
│   │   └── auto.ts              # detectVerifyCommand() npm test / tsc / make
│   ├── checkpoints/
│   │   └── store.ts             # snapshot/.klyro/checkpoints/<id> diff/undo/rewind
│   ├── events/
│   │   ├── catalog.ts           # KlyroEvent 15 types
│   │   └── bus.ts               # EventBus + globalBus
│   ├── trace/
│   │   └── writer.ts            # TraceWriter JSONL appendFile + fsync on tool.result
│   ├── renderers/
│   │   ├── terminal.ts          # TerminalRenderer
│   │   └── json.ts              # JsonRenderer
│   ├── tui/
│   │   ├── app.tsx              # Ink full-screen: Static history + live region batched 30fps + single useInput
│   │   ├── tokens.ts            # accent #8B7CF6, glyphs › ● ⎿ ✔, spacing
│   │   ├── banner.tsx           # 5.1 Banner + resume
│   │   ├── input-box.tsx        # 5.2 InputBox queued
│   │   ├── thinking-block.tsx   # 5.5 Thinking
│   │   ├── activity-line.tsx    # 5.6 Spinner + verb·elapsed
│   │   ├── transcript.tsx       # 11 kinds: text/tool/policy/error/file_changed/diff
│   │   ├── status.tsx           # model step/max repairs tokens cost ctx%
│   │   ├── header.tsx           # abbrevPath
│   │   ├── diff.tsx             # DiffView per-file hunk
│   │   ├── approval.tsx         # TuiApprovalBridge y/a/A/n/e/?
│   │   ├── plan.tsx             # PlanView glyphs ◯●✓✗⊘
│   │   └── diff-parser.ts       # parseUnifiedDiff
│   ├── cli/
│   │   ├── repl.ts              # startRepl() Ink TUI: resolveProvider probe, httpChat/anthropic, queued bridge, verify repair loop
│   │   ├── run.ts               # runOnce() one-shot: verify/persist, session create/resume, headless -p
│   │   ├── eval.ts              # runEval() JSONL suite + --suite smoke file fixtures
│   │   ├── config.ts            # 5-layer loadMergedConfig, Zod, JSONC stripJsonComments, get|set|list|path
│   │   ├── doctor.ts            # 7 checks Node/config/Provider/Sessions/git/Tools/Platform
│   │   ├── completion.ts        # bash|zsh|fish|powershell
│   │   ├── update.ts            # 24h cache, KLYRO_NO_UPDATE_CHECK
│   │   ├── auth.ts              # login 0600 credentials.json, MODEL_ALIASES sonnet→claude
│   │   ├── markdown.ts          # renderMarkdown incremental, stripMarkdown
│   │   ├── errors.ts            # handleFatal ✖/hint, setupGlobalHandlers
│   │   └── slash/parser.ts      # /clear/compact/model/diff/plan/status/quit/help/config/doctor/cost/thinking
│   ├── shared/
│   │   ├── errors.ts            # KlyroError{code,exitCode}
│   │   └── types.ts             # Role, Message, ExitCode
│   └── util/log.ts              # pino JSON ~/.klyro/logs/klyro-YYYY-MM-DD.log 14d rotation redact
├── packages/shared              # workspace: @klyro/shared (re-export)
├── evals/
│   ├── fixtures/                # 10 smoke fixtures: read-answer, add-fn-test, fix-failing-test…
│   └── results/baseline.json    # 8/10 80% + markdown compareReports()
├── .klyro/                      # runtime: sessions.json, traces/*.jsonl, checkpoints/<id>, logs/, history, memory/
└── dist/                        # tsc output, bin klyro
```

---

## 7. CLI Reference

```
klyro                          # TUI REPL (TTY) or legacy pipe REPL
klyro --tui / --no-tui         # force TUI / legacy
klyro -p "prompt"              # headless one-shot (stdin piped + --output-format json)
klyro tui [-m model] [--max-steps n]
klyro run <prompt> [-m model] [--max-steps 30] [--max-cost $] [--max-time ms]
        [--verify/--no-verify --verify-command <cmd> --max-repairs 3]
        [--persist/--no-persist --resume-session <id>] [--output human|json|silent]
klyro chat [prompt] [-s system] # legacy streamed chat
klyro eval <input.jsonl> | --suite smoke [--filter str] [--runs 1] [--parallel 1] [--output json]
klyro eval:compare <a.json> <b.json>
klyro config [list|get <key>|set <key> <value>|unset <key>|path|edit]
klyro doctor [--json]
klyro completion <bash|zsh|fish|powershell>
klyro update
klyro login / logout [provider]  # 0600 credentials.json, MODEL_ALIASES
klyro session list|show <id>|resume <id> [--json]
klyro resume <id>                # alias
klyro trace <id> [--stats --json]
klyro --version / --help
```

Global flags (preAction `src/index.ts:60`): `--cwd <path>` `--config <path>` `--debug` `--verbose` `--quiet` `--json` `--yes` `--no-color` (respects `NO_COLOR/FORCE_COLOR`)

---

## 8. Provider System

- **Resolution:** `flags` → `KLYRO_PROVIDER` (aliases `9router/openrouter/groq→openai`) → `inferProviderFromBaseURL()` `anthropic.com` exact → `openai` default `src/agent/registry.ts:30`
- **Adapters:** `httpChatAdapter` `src/agent/provider-adapter.ts:190` (`/chat/completions` SSE `\n\n`, `toolIds` map + `pendingUsage`, `redact` error) + `anthropicAdapter` `src/agent/anthropic-adapter.ts:76` (`/v1/messages` `x-api-key`, `indexToToolId` `Map<number,string>` `src/agent/anthropic-adapter.ts:169` fixes `findToolIdByIndex` interleaving) + `retryingAdapter` `src/agent/retry.ts:46` `computeBackoff` `base*2^attempt ±25%` `3 attempts 500ms/8s`, `streamWithAbort` `it.return()` `src/agent/retry.ts:46`
- **Security:** `assertSafeBaseURL()` `src/chat.ts:38` `https:` OK, `http:` only `localhost/127.*` `10/8` `192.168/16` `172.16/12` or `KLYRO_ALLOW_INSECURE=1` with warning.

---

## 9. Tool System (18 tools)

`ToolRegistry` `src/tools/registry.ts:81` `register/get/list/toOpenAITools/execute` (`safeParse` → `INVALID_INPUT`).

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `read_file` | `path, startLine?, endLine?, maxBytes?` | `lines, totalLines, bytesRead, truncated` | `cat -n` 2000 window, 10MB `src/tools/fs/read-file.ts:49`, binary `null-byte` `src/tools/fs/read-file.ts:60`, `wasRead` `src/tools/fs/read-history.ts:1` |
| `write_file` | `path, content` | `bytesWritten, diff` | `0600` tmp `crypto.randomBytes` + `fsync` + `rename` `src/tools/fs/write-file.ts:36`, `wasRead` guard `>200` lines `needsApproval` |
| `edit_file` | `path, find, replace, replaceAll?` | `replacements, diff` | `EOL/BOM/trailing` `src/tools/fs/edit-file.ts:40`, staleness `mtime+hash` `src/tools/fs/edit-file.ts:26`, `findClosestMatch` `src/tools/fs/edit-file.ts:70`, fuzzy 4 tiers `src/tools/fs/edit-file.ts:40` |
| `multi_edit` | `path, edits[{find,replace}]` | `edits, diff` | atomic `src/tools/fs/multi-edit.ts:10` |
| `apply_patch` | `patch` | `patchedFiles` | Codex tolerant `src/tools/fs/apply-patch.ts:1` |
| `list_directory` | `path, maxDepth?` | `entries` | skips `DEFAULT_SKIP` + dotfiles `src/tools/fs/list-dir.ts:67`, depth `maxDepth` |
| `glob` | `pattern, cwd?` | `paths` | `globToRegex` `**/` `src/tools/search/glob.ts:50` |
| `grep` | `pattern, path?, include?` | `matches` | `RegExp g` `lastIndex=0` `src/tools/search/grep.ts:49` `500` cap, binary skip |
| `search_files` | `query` | `paths` | ranking `exact basename 200` `src/tools/search/search-files.ts:1` |
| `recent_files` | `sinceHours?, glob?` | `paths` | `mtime >= sinceMs` `src/tools/search/recent-files.ts:1` |
| `dependencies` | `manager?` | `deps` | `npm/py/go/rust` parsers `src/tools/search/dependencies.ts:1` |
| `shell_exec` | `command, cwd?, timeoutMs?, env?` | `exitCode, stdout, truncated` | `120s max 600s` `src/tools/shell/shell-exec.ts:20` `persistentCwd` `filteredEnv()` `30k head+tail` `~/.klyro/tool-output/<id>.txt` `taskkill /F /T` `src/tools/shell/shell-exec.ts:182`, `DANGEROUS_PATTERNS` `rm -rf` `curl|sh` `src/tools/shell/shell-exec.ts:30` |
| `git_status` | — | `porcelain, branch, log` | `spawn git` `shell:false` `15s` `src/tools/git/git-status.ts:1` |
| `git_diff` | `cached?` | `diff, stat, patchedFiles` | `diff --git` regex `src/tools/git/git-diff.ts:61` |
| `git_log` | `limit?, path?` | `log` | read-only `src/tools/git/git-log.ts:1` |
| `run_verify` | `command` | `ok, exitCode` | `5m 256k` `src/tools/verify/run-verify.ts:1` `taskkill` |
| `todo_write` | `todos[{id,title,status}]` | `updated` | `src/tools/plan/todo-write.ts:1` `.klyro/plans/todos.json` |
| `ask_user` | `question, options?` | `answer` | `src/tools/plan/ask-user.ts:1` `HEADLESS` `KLYRO_AUTO_ANSWER` |

---

## 10. Context Engine

- **L6 static:** `buildLevel6Context()` `src/context/level6.ts:131` `12k` = `projectMap` `src/context/project-map.ts:352` (`language/framework/PM` `statSync`) + `repoMap` `src/context/repo-map.ts:33` `regex symbols` 500 files + `recentFiles` `src/**` 15 + `deps` `package.json` → `truncated at last \n`
- **L7 live:** `RuntimeTelemetry` `src/context/level7.ts:60` `step/maxSteps/toolCallCount/inputTokens` `record*()` `format()` `1200` chars `emptyTelemetryBlock()` `summarize()` — injected via `systemPrompt(cwd,telemetry)` `src/agent/runtime.ts:240` each step
- **Tokenizer:** `estimateTokens(s)=ceil(len/4)` `src/context/tokenizer.ts:35` `compressTranscript()` `src/context/tokenizer.ts:76` deep-copy (was shallow mutate) + `consumed` set + `tool_result` 400 chars + `drop oldest` — **not wired into runtime** (dead code, transcript unbounded)
- **Selector:** `selectFiles()` `src/context/selector.ts:22` `+100 exact path` `+20 basename` — **not wired**

---

## 11. Verification & Repair (L6/L8)

- **auto:** `detectVerifyCommand(cwd)` `src/verification/auto.ts:10` `package.json test`→`npm test` / `tsconfig.json`→`tsc` / `Makefile` / `pytest` / `go test`
- **engine:** `verify({cwd,command,timeoutMs=5m})` `src/verification/engine.ts:28` `spawn shell true` `stdout+stderr` `timeout kill` `detect()` `diagnosticForModel()` `src/verification/engine.ts:67`
- **detect:** `detect(stdout,stderr,exitCode)` `src/verification/detect.ts:36` `type` `type|test|lint|build|runtime|unknown` `TS_LINE` `TEST_FAIL` `LINT_LINE` `RUNTIME_LINE` + `summarize()` 8 files
- **Runtime wiring:** `hasEdits` `src/agent/runtime.ts:175` `write_file/edit_file` → after `no tools` `finalText` → `verifyEnabled && hasEdits && verifyCmd` `src/agent/runtime.ts:331` → `verify()` → `verification_succeeded` → `complete` else `diagnosticForModel()` → `transcript.push(user repair)` `src/agent/runtime.ts:357` → `continue` ≤3 `maxRepairs` `src/agent/runtime.ts:330` → `verify_failed` `src/agent/runtime.ts:366` + `repair_started` event

---

## 12. Persistence (L9)

- **Store:** `SessionStore` `src/persistence/store.ts:52` `dir .sessions` `sessions.json` index + `{id}.json` `{record,messages,observations}` `randomUUID` `ensureDir` `readIndex` `writeIndex` `tmp→fsync→rename` `src/persistence/store.ts:74` (was non-atomic) + 3-attempt `writeSession` `src/persistence/store.ts:100`
- **Session:** `SessionRecord{id,cwd,task,status,createdAt,updatedAt,config,finalText}` `SessionStatus open|complete|verify_failed|aborted|max_steps` `src/persistence/store.ts:17` + `getDefaultSessionsDir()` `~/.klyro/sessions` `src/persistence/session.ts:10` `formatSession()` `resolveSessionId(prefix)` `src/persistence/session.ts:30`
- **Audit:** `AuditLog` `src/persistence/audit.ts:23` `AuditEvent` 11 kinds `JSONL appendFile`
- **Trace:** `TraceWriter` `src/trace/writer.ts:1` `JSONL .klyro/traces/<id>.jsonl` `appendFile + open/sync/close` on `tool.result` (was persistent `FileHandle` leak `src/trace/writer.ts:20` fixed)
- **Checkpoints:** `src/checkpoints/store.ts:1` `snapshot(cwd,files)` `.klyro/checkpoints/<id>` `listCheckpoints` `diff` `git diff --stat` `undo` `rewind` — **not wired to runtime snapshots** (runtime uses `SessionStore` checkpoint, not `checkpoints/store.ts`)

---

## 13. TUI (Professional, Full-Screen)

- **Stack:** `ink 7.1` `react 19` `ink-spinner 5` `react/jsx` `target ES2022` `module NodeNext`
- **Tokens** `src/tui/tokens.ts:1` `accent #8B7CF6/magenta` `muted #7A7A7A` `success #4ADE80` `error #F87171` `glyphs › ● ⎿ ✔ ✘ ⚠` + ASCII fallback `isAsciiMode()`
- **App** `src/tui/app.tsx:14` inline/scrollback per `TUI_DESIGN.md` `Static` history `src/tui/app.tsx:325` + batched `30fps` `src/tui/app.tsx:117` + single `useInput` `src/tui/app.tsx:185`
  - `Banner` `src/tui/banner.tsx:1` `◆ Klyro v0.1.11` `cwd (branch ✎3)` `KLYRO.md` + resume `↻`
  - `InputBox` `src/tui/input-box.tsx:1` `accent` `queued:` `shell` `!` `note` `#`
  - `ThinkingBlock` `src/tui/thinking-block.tsx:1` `∴ Thinking… ctrl+t`
  - `ActivityLine` `src/tui/activity-line.tsx:1` `✻ verb (4s · ↑1.2k)` + `CompactionDivider` `⟲`
  - `Transcript` `src/tui/transcript.tsx:37` 6 kinds `ToolCard` `round` `cyan running` `green ✓`
  - `StatusLine` `src/tui/status.tsx:23` `model step/max repairs tokens $0.043 ctx 6%`
  - `Header` `src/tui/header.tsx:31` `abbrevPath`
  - `DiffView` `src/tui/diff.tsx:57` `DiffHunk` `+ green` `- red` `context gray`
  - `ApprovalModal` `src/tui/approval.tsx:60` `[y] once [a] session [A] always [n] [e] [?]` `TuiApprovalBridge` `src/tui/approval.tsx:31` promise `PendingPrompt`
  - `PlanView` `src/tui/plan.tsx:44` `◯●✓✗⊘` `expanded`
  - `DiffParser` `src/tui/diff-parser.ts:20` `parseUnifiedDiff`
- **Full-screen alt:** `src/tui/app.fullscreen.tsx:1` `width={width} height={height-1}` `Header` `KLYRO v0.1.9` `Conversation` `flexGrow` `Input` `StatusBar` (kept as `app.inline.tsx` backup)
- **History:** `~/.klyro/history` JSONL per project `src/tui/app.tsx:50` `loadHistory/appendHistory` `↑/↓` `Ctrl+R`

---

## 14. Policy & Safety

- **PathGuard** `src/policy/path-guard.ts:46` `resolveWithinCwd` `path.relative` + drive `PathGuardError`, `resolveAndFollowSymlinks` `realpath` `realParent` parent-symlink defense `src/policy/path-guard.ts:106`
- **Engine** `src/policy/engine.ts:84` `Decision allow|ask|deny` `PolicyConfig mode default|plan|accept-edits|auto + allow/deny/ask glob` `src/policy/engine.ts:34` `matchesGlobRule()` `src/policy/engine.ts:120` `.env` deny `src/policy/engine.ts:99` `additionalDirs` `src/policy/engine.ts:176` `shellDeny` `curl|sh` `src/policy/engine.ts:141`
- **Approval** `StdinApprovalPrompt` `DenyAll` `InMemoryAllowlist` `src/policy/approval.ts:21` + `TuiApprovalBridge`
- **Redactor** `src/policy/secret-redactor.ts:14` 7 patterns `aws-key` `aws-secret+b64` `pem-block` `github-token` `slack-token` `bearer` `jwt` `redact()` `createRedactor()` 1KiB tail

---

## 15. Eval Harness

- **Harness** `src/eval/harness.ts:70` `runTask()` `tmp klyro-eval-<id>` `ToolRegistry 9 tools` `verify()` + `runHarness()` `formatReport()` `compareReports()` `src/eval/harness.ts:180`
- **Tasks** `src/eval/tasks.ts:1` `MVP_TASKS 5` `t1 direct-answer` `t2 write-then-answer` `t3 policy-deny` `t4 max_steps` `t6 multitool`
- **File fixtures** `evals/fixtures/*` 10 smoke `read-answer` `add-fn-test` `fix-failing-test` … `task.md` `check.sh` `meta.json` `src/eval/harness.ts:130` `loadFileFixture` `runFileFixture` `bash -c`
- **Results** `evals/results/baseline.json` `8/10 80%` `src/eval/harness.ts:130`, `compareReports` `src/eval/harness.ts:180`, `klyro eval --suite smoke` `src/cli/eval.ts:84`

---

## 16. CLI Surface

```
klyro                          # TUI REPL (isTTY ? TUI : legacy pipe)
klyro --tui / --no-tui / --chat # force
klyro -p "prompt"              # headless positional (2.5)
klyro tui [-m model] [--max-steps n]
klyro run <prompt> [-m model] [--max-steps 30] [--max-cost $] [--max-time ms]
        [--verify/--no-verify --verify-command <cmd> --max-repairs 3]
        [--persist/--no-persist --resume-session <id>] [--output human|json|silent]
        [--provider openai|anthropic] [--dry-run] [--resume <file>]
klyro chat [prompt] [-s system] # legacy
klyro eval [input] [--suite smoke --filter str --runs 1 --parallel 1 --output json]
klyro eval:compare <a> <b>
klyro config [list|get <key>|set <key> <value>|unset <key>|path|edit]  # 5-layer Zod JSONC
klyro doctor [--json]          # 7 checks
klyro completion <bash|zsh|fish|powershell>
klyro update                   # 24h cache
klyro login / logout [provider] # 0600 credentials.json, MODEL_ALIASES
klyro session list|show <id>|resume <id> [--json]
klyro resume <id>              # alias
klyro trace <id> [--stats --json]
klyro --version / --help       # global --cwd/--config/--debug/--json/--yes/--no-color
```

Global flags `src/index.ts:60` `--cwd/--config/--debug/--verbose/--quiet/--json/--yes/--no-color` via `preAction` hook, `showSuggestionAfterError`.

---

## 17. Testing

- **Config:** `vitest.config.ts:1` `include src/**/*.test` `environment node` `fileParallelism:false` `testTimeout 10_000`
- **Results:** `43 files 309/309` (was 36/288, +7 P0 L4)
- **Coverage:** No `--coverage` threshold; L4 new tests: `edit-file.test.ts:1` 10 tests (CRLF/BOM/trailing), `multi-edit` 2, `apply-patch` 2, `background` 2, `klyro-md` 2, `checkpoints` 1, `git` 2
- **Security gate:** `src/security.test.ts:1` 16 tests (cwd jail, policy, redaction, hostile)
- **Flaky:** `fileParallelism:false` hides concurrency bugs (`plan.md:199` parallel tools)

---

## 18. Known Gaps (Post-MVP)

- `compressTranscript()` `src/context/tokenizer.ts:76` deep-copy fixed but **not wired** into `runtime` (transcript unbounded)
- `verify` unbounded `stdout` `src/verification/engine.ts:31` no cap (vs `run_verify` 256k) — repair OOM
- `AuditLog` `src/persistence/audit.ts:23` defined but never written (dead code)
- `L6 repo-map` heuristic, no `tree-sitter`/`LSP` (plan L7)
- `L8+L9` wiring: `compressTranscript` + `checkpoints/store.ts` not used by `SessionStore`

---

## 19. For a New Agent — Where to Start

1. **Runtime is king:** `src/agent/runtime.ts:150` `run()` — get this loop right, everything else is leaf.
2. **Provider contract:** `src/agent/provider-adapter.ts:42` `ProviderAdapter` + `src/tools/schema.ts:63` Zod→JSON — defines `multi-model`.
3. **Edit tool:** `src/tools/fs/edit-file.ts:26` — most used, diff-return shapes model reasoning.
4. **Verification:** `src/verification/engine.ts:28` + `detect.ts:36` — the “more reliable than prompting” claim.
5. **Config:** `src/cli/config.ts:10` Zod-derived types constrain every module.

Run: `pnpm build && pnpm test && node dist/index.js --help` → `klyro -p "fix login test" --output json` → `klyro doctor`.

