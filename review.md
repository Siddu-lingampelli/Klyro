# Klyro 1.0.9 — Complete Repository Review

**Review date:** 2026-09-19  
**Repository:** Klyro autonomous coding harness  
**HEAD reviewed:** `cd298b0` — `release: klyro 1.0.9 - cross-turn session memory for TUI REPL`  
**Scope:** architecture, execution flow, providers, API requests, tools, agents, MCP, policy/sandbox, memory/context/compaction, persistence, checkpoints, CLI/commands, web/search, TUI/scroll, verification, evals, build/release, tests, and documentation consistency.

## 1. Executive summary

Klyro is a substantial TypeScript/Node.js terminal-native coding-agent harness. It combines a Commander CLI, an Ink/React TUI, provider adapters for Anthropic and OpenAI-compatible APIs, an autonomous runtime, 34 built-in tools, policy and approval gates, MCP client/server support, session persistence, checkpoints, memory/context assembly, verification/repair, and an evaluation harness.

The repository demonstrates unusually broad functionality for a single CLI project. The strongest areas are the explicit policy layer, separate tool registry, provider abstraction, structured event/rendering paths, checkpoint support, test coverage, and clear exit-code contract. The 1.0.8 and 1.0.9 releases also address network tools and cross-turn TUI memory rather than presenting a stateless chat shell as a full harness.

The main risks are operational and integration risks rather than one obvious single-component failure: package-manager inconsistency, incomplete or stubbed CI smoke evaluation, a very large CLI entrypoint, multiple legacy and current execution paths, broad local-machine authority inherent in coding tools, and a documentation/status surface that can drift from implementation. The project should be treated as a powerful local automation tool: the policy and approval boundaries are security-critical and require continuous regression testing.

### Overall assessment

| Area | Assessment |
|---|---|
| Architecture | Strong breadth; modular directories but a very large command entrypoint remains a maintenance hotspot |
| Provider/API layer | Good abstraction and URL validation; adapter behavior and error mapping need continued contract tests |
| Agent runtime | Feature-rich with budgets, retries, verification, tasks, and worktrees; complexity is high |
| Tools | Broad and useful; local filesystem/shell/git authority makes policy correctness critical |
| MCP | Good separation of trust/policy/client concerns; remote and stdio paths need continuous adversarial tests |
| Context/memory | Mature feature set with bounded history/compaction and project guidance loading; precedence and size limits should remain explicit |
| Persistence | JSON sessions, traces, audit chain, and checkpoints are useful; crash consistency and migration deserve more testing |
| TUI/UX | Ink architecture and dedicated scroll/diff/transcript components are appropriate; terminal edge cases remain a broad test surface |
| CI/release | Typecheck/test/build gates exist, but the smoke eval is explicitly allowed to pass as a stub and npm/pnpm workflows differ |
| Documentation | README is current at 1.0.9; historical/build-plan documents are extensive but competing sources of truth exist |

## 2. System architecture and end-to-end flow

### 2.1 Startup and command dispatch

`src/index.ts` is the Commander-based entrypoint. It handles global process behavior, command registration, error-to-exit-code mapping, session operations, MCP commands, agent commands, evaluation commands, scanning/context commands, update behavior, and other top-level operations. `src/cli/run.ts` is the central run orchestration layer for provider/model selection, session setup, MCP initialization, REPL selection, and execution mode.

The practical flow is:

1. Node starts `dist/index.js` (or `src/index.ts` in development).
2. Commander parses the command, global flags, and arguments.
3. Configuration/environment/provider resolution selects the base URL, provider, model, permissions, workspace, and run mode.
4. The run layer creates the event/output/session context and loads project context where enabled.
5. MCP servers, custom agents, custom commands, memory, hooks, and policy are initialized unless the run is explicitly bare.
6. A one-shot prompt or REPL prompt enters the agent/runtime loop.
7. The model produces text and/or tool calls. Tool calls pass through registry/schema/policy/approval handling.
8. Tool results are appended to the conversation/event trace; the runtime applies retry, budget, stuck-detection, and stop rules.
9. Verification and optional repair run before final completion when configured.
10. Output is rendered as terminal/TUI/JSON, session and audit state are persisted, and a documented exit code is returned.

This is a sound high-level shape for an autonomous coding CLI. The main maintainability concern is that the large `src/index.ts` command registration surface makes it easy for command-specific setup, exit semantics, and security policy to diverge. Keep command handlers in focused modules and leave `index.ts` as registration/composition wherever possible.

### 2.2 Modes and bypasses

The documented `klyro run --bare` mode intentionally skips MCP, hooks, memory, `KLYRO.md`/context, and persistence. This is useful for deterministic operation and tests, but it is also a meaningful behavioral change. Users and scripts must not assume that a bare run has the same trust, context, audit, or tool availability as a normal run. The mode should remain clearly visible in traces and JSON output.

The repository contains legacy one-shot/REPL code (`src/chat.ts`, `src/repl.ts`) as well as newer `src/cli` and `src/agent` paths. This provides compatibility but creates a risk that fixes to provider validation, retry, history, output envelopes, or policy are applied in one path and not the other. The legacy paths should either be removed, explicitly marked compatibility-only, or covered by the same contract tests as the current paths.

## 3. Providers, models, connections, and requests

### 3.1 Provider model

The project supports Anthropic `/v1/messages` and OpenAI-compatible `/v1/chat/completions` endpoints. Provider definitions and inference live under `src/providers/` and `src/providers.ts`; adapter logic is under `src/agent/provider-adapter.ts` and `src/agent/anthropic-adapter.ts`.

The README documents:

- `KLYRO_BASE_URL`
- `KLYRO_API_KEY`
- `KLYRO_MODEL`
- `KLYRO_PROVIDER`
- configuration file overrides
- local-provider examples
- timeout/retry/usage/cost behavior

This is a good provider-neutral design. The endpoint registry has built-in hosted and localhost defaults and validates provider IDs. Provider contract tests exist and should be expanded whenever the wire format changes.

### 3.2 URL and transport security

The project documents HTTPS-only behavior with a localhost exemption for local models. The code also contains URL validation for provider and remote MCP URLs, including explicit handling for HTTPS, loopback/local development, and opt-in insecure exceptions. This is an important baseline because provider API keys and prompts are sent over these connections.

Review points:

- Ensure every provider path uses the same URL validation helper. The presence of both current provider code and legacy `src/chat.ts` makes duplicate validation a regression risk.
- Keep credentials out of URLs and error bodies.
- Keep request timeout and abort behavior consistent across streaming and non-streaming calls.
- Maintain tests for redirect behavior, malformed URLs, non-HTTPS hosts, loopback exceptions, and explicit insecure opt-ins.
- Ensure remote MCP and model-provider URL policies cannot be confused with each other; they have different trust and capability implications.

### 3.3 Request/retry/usage behavior

The runtime includes per-request timeout, retry with backoff, provider error mapping, usage/cost accounting, and streaming. Retries must remain limited to safe retry classes and must not duplicate non-idempotent side effects. Model calls themselves are generally safe to retry, but tool execution must not be repeated merely because a model transport attempt was retried.

The runtime should preserve an explicit distinction between:

- request was never accepted;
- provider accepted but stream failed;
- model response was complete;
- tool call was emitted and executed;
- tool result was persisted;
- run was stopped after a budget/verification condition.

That distinction is necessary for correct retry, audit, cost reporting, and resume behavior.

### 3.4 Model negotiation and errors

The user-facing exit-code contract is useful: configuration errors, provider errors, missing final answers, stopped/budget runs, verification failures, and aborts are distinct. Continue to test both human-readable and JSON/headless modes against every exit class. In particular, headless JSON should retain exactly one stable final `kind:result` envelope, with diagnostics sent separately or represented as structured events.

## 4. Agent runtime and sub-agents

The `src/agent/` package contains the runtime loop, orchestration, child workers, worker spawning, task management, scoped registries, custom agents, worktree management, retry, and provider adapters.

### Strengths

- Separate orchestration and task management concepts.
- Child-worker support for isolated work.
- Worktree management for parallel or safer changes.
- Scoped registries reduce accidental global tool exposure.
- Custom agent definitions are lintable and can be loaded from `.klyro/agents/*.md`.
- Budgets, stuck detection, verification, and repair provide termination mechanisms beyond “keep asking the model.”
- Worker isolation can be disabled explicitly with `KLYRO_WORKER=0`, which is useful for environments where subprocesses are unavailable.

### Risks and recommendations

1. **Authority inheritance:** Every child worker must receive only the intended tool/policy/capability scope. Do not infer authority from the parent prompt or an unvalidated agent document.
2. **Cancellation propagation:** Abort, `/cancel`, Ctrl+C, and stop conditions must cancel the model request, pending tool calls, child workers, and subprocesses. Tests should assert no child remains active after the parent exits.
3. **Task lifecycle:** `task-get`, `task-list`, `task-apply`, `task-stop`, and `task-wait` need consistent state transitions and clear behavior for unknown, expired, failed, and already-completed tasks.
4. **Worktree cleanup:** Failed or aborted tasks must not leave stale worktrees, locks, branches, or misleading checkpoint state.
5. **Retry boundaries:** A provider retry must not re-run a tool call whose side effect already occurred.
6. **Prompt/tool scope:** Custom-agent metadata and prompt content are untrusted configuration inputs from the project; schema and policy validation must happen before registration.

## 5. Built-in tools and tool execution

The repository documents 34 built-in tools across filesystem, search, shell, git, verification, planning, and web areas. The registry/schema layer is the right place to enforce unique tool names, input validation, capability metadata, and availability checks.

### 5.1 Filesystem tools

Read/list/history tools provide repository inspection. Apply-patch and editing paths are higher impact because they modify files. Path normalization and workspace guards should be applied consistently before reads and writes; symlink behavior should be tested explicitly. A path guard that validates only the textual path before symlink resolution can still be bypassed by a link inside the workspace pointing outside it.

Approval-edit/retry behavior is valuable: it lets a user inspect or modify a proposed edit before application. The approval surface should display the exact target paths and diff, not only a model summary.

### 5.2 Search/repository tools

Glob, grep, dependency search, import graph, repo map, recent files, and symbol tools improve context gathering. Search output should remain bounded and should not silently turn an ignored/private file into model context without the normal trust/context rules.

### 5.3 Shell tools and sandbox

Shell execution is the highest-risk built-in capability because it can modify the host, access credentials, invoke network clients, and create subprocesses. The project has shell sandbox tests, policy classes, approval handling, and worker-entry paths. Maintain the following invariants:

- default shell policy is deny/ask as documented, never accidental allow;
- command arguments are passed without `shell: true` where possible;
- working directory is explicitly constrained;
- environment inheritance is deliberate and secret-sensitive;
- timeout/abort kills the complete process tree;
- command output is bounded and classified;
- approval is tied to the exact command and cwd;
- network permission is separate from ordinary shell permission;
- a child worker cannot silently widen the parent policy.

Shell command strings in tests are not evidence of production command injection by themselves; the important review boundary is the production command-construction path and whether untrusted model arguments are passed as argv or interpreted by a shell.

### 5.4 Git tools

Git status/diff/log and checkpoint operations use subprocesses with `shell: false` in the reviewed paths, which is the correct default. Commit/push operations require special risk handling, including the documented protected-branch escape variable. Keep commit identity, branch protection, push approval, and dirty-tree checks explicit. A model should not be able to turn a read-only git operation into a push by changing a natural-language instruction.

### 5.5 Verification and repair tools

Verification registry/parsers, baseline, scoped verification, automatic verification, and repair loops are a strong design. They should treat verifier commands as configured executable actions, not as arbitrary model-provided commands. Verification failure must be distinguishable from provider failure and from user cancellation.

### 5.6 Web tools

`web_fetch` and `web_search` were added in 1.0.8 with a network permission class, explorer/docs allowlists, and prompt discipline for fetched claims. This is an appropriate separation from filesystem/shell permissions. Continue to test:

- host/protocol validation;
- redirects to disallowed hosts or protocols;
- content-size/time limits;
- network approval cancellation;
- prompt-injection text in fetched pages;
- provenance in the model context;
- no claim that a URL was fetched when the tool did not return it;
- consistent denial behavior in one-shot, REPL, bare, and child-worker modes.

Web content must remain data, not instructions that can override system policy or tool permissions.

## 6. MCP client, server, trust, and connections

The MCP area includes client support, schemas, policy, trust, remote connections, serving, and OAuth-related functionality. README coverage includes stdio/SSE/HTTP client paths, remote MCP, prompt trust, `mcp add`, `mcp trust`, and `mcp prompts`.

### Trust model

MCP servers are an extension boundary: they can expose tools, prompts, resources, and potentially network/process capabilities depending on the server. The explicit trust/policy modules are therefore essential. Trust should be keyed to a stable server identity/configuration and should not be granted merely because a server name matches a prior name while its command/URL changed.

### Client recommendations

- Validate stdio command and argument configuration before spawning.
- Avoid shell interpretation when starting stdio servers.
- Apply remote URL validation and HTTPS policy before connection.
- Keep authentication material out of model-visible tool schemas and logs.
- Bound message sizes and connection lifetimes.
- Handle disconnect and reconnect without duplicating tool execution.
- Treat server-returned text as untrusted data.
- Enforce MCP tool policy through the same registry/approval path as built-ins.
- Make trust changes visible in audit traces.

### Server recommendations

The MCP server should expose only intentionally registered capabilities, validate request schemas, and return bounded structured errors. It must not inherit arbitrary CLI process authority merely because it runs in the project. Tests should cover malformed JSON-RPC, unknown methods, invalid tool arguments, server shutdown, and tool-denial paths.

## 7. Policy, approvals, secrets, and sandbox boundaries

The policy package includes an engine, path guard, approval behavior, secret redaction, and tool policy concepts. This is one of the most important parts of Klyro because the agent is designed to operate on real repositories.

### Positive design choices

- Tool capability metadata and a central registry.
- Explicit approval flows for risky operations.
- Separate network permission class introduced with web tools.
- Commit/push risk handling rather than treating all git actions equally.
- Secret redaction support.
- Project/context trust facilities.
- Audit and trace outputs.

### Required invariants

- Deny must be terminal for the specific operation, not interpreted as “try a similar command.”
- Approval must bind to the precise operation, arguments, paths, and relevant environment.
- A model-provided justification must never count as approval.
- A policy downgrade must not occur through retry, child worker, MCP, or bare-mode paths.
- Secret redaction must cover provider errors, tool results, traces, audit records, TUI transcript, and JSON output.
- Paths must be normalized and symlink-tested.
- Network access must be classified independently from local command execution.
- Credentials should be read from the OS keychain where available and from a 0600 fallback file as documented.

## 8. Context, memory, history, and compaction

The context package includes project maps, repository maps, tokenizer/measurement, assembly, lifecycle, trust, `KLYRO.md` loading, import graphs, memory, and compaction/selection. The 1.0.9 release adds bounded cross-turn session memory to the TUI REPL and ensures short prompts do not incorrectly bypass the tool loop for URL-related questions.

### Context assembly flow

1. Discover project metadata and repository structure.
2. Load trusted project instructions and relevant `KLYRO.md` content.
3. Load selected memory/history/session messages under bounded limits.
4. Add user prompt and system/runtime instructions.
5. Select or compact material to fit the model context budget.
6. Preserve tool-call/tool-result pairing and the current task state.

### Review conclusions

- Bounded history is necessary and is now present on the TUI path.
- Compaction must never remove a required tool call/result pair or change the meaning of an approval decision.
- Imported project instructions are data/configuration and must not override hard-coded safety policy.
- Prompt injection from repository files, memory files, MCP resources, or web results must be treated as untrusted content.
- Memory writes need provenance and should avoid silently converting arbitrary model output into durable instructions.
- Context selection should expose enough diagnostics to explain why a file or memory item was included or omitted.
- The legacy and current REPL paths must share history semantics or clearly document the difference.

## 9. Persistence, sessions, traces, audit, and checkpoints

Persistence includes JSON session storage, traces/event output, hash-chained audit behavior, session list/resume/merge/import/export paths, and checkpoint snapshots/undo/rewind.

### Strengths

- JSON sessions are easy to inspect and migrate.
- Session operations are exposed through CLI commands.
- Hash-chained audit entries provide tamper-evident sequencing.
- Checkpoints support recovery and undo.
- The 1.0.9 TUI history can be persisted rather than resetting each prompt.
- Relocatable state variables (`KLYRO_SESSIONS_DIR`, update cache, credentials file) help tests and power users.

### Risks/recommendations

- Use atomic write/rename for session and audit files; test interruption between write and rename.
- Validate imported JSON structurally before accepting it into a session.
- Version persisted schemas and provide migrations for future releases.
- Treat session files as sensitive because they can contain prompts, tool results, paths, and code.
- Keep credentials out of session JSON and traces.
- Ensure hash-chain verification reports the first broken link and does not silently continue.
- Ensure undo is scoped to the requested worktree and does not restore unrelated user changes.
- Ensure resume checks cwd/worktree identity before continuing a session.
- Resolve abbreviated IDs unambiguously, as the CLI currently attempts to do.
- Define retention and cleanup behavior for traces/checkpoints.

## 10. CLI commands and user-facing behavior

The CLI surface includes chat/run modes, REPL/slash commands, session management, MCP management, agent linting, initialization, scan/project/context, evaluation and judge operations, update operations, commit/audit operations, hooks, and provider/config/doctor flows. `commands.md` and README document much of this surface.

Important documented command behaviors include:

- one-shot and interactive chat;
- `run --bare`;
- `session list/resume/continue/merge/import/export` style operations;
- `mcp add`, `mcp trust`, and prompt inspection/trust;
- `agents lint`;
- `init` without overwriting existing files;
- `eval --judge-model`;
- `update --apply` only after verified update handling;
- `/vim`, `@` file completion, slash commands, approvals, and cancellation.

The command surface is broad enough that generated command help and `commands.md` should be tested for drift. Every command should have tests for success, invalid usage, refusal, provider failure, cancellation, and JSON output where applicable.

## 11. TUI, UI, input, and scroll behavior

The TUI uses Ink/React. The relevant areas include transcript rendering, markdown, approvals, diffs, input, measuring, scroll state, transcript commands, and diff parsing. `scroll.md` and `TUI_DESIGN.md` document intended behavior.

### Positive aspects

- Dedicated transcript and approval components.
- Dedicated diff parser and measurement tests.
- Slash command and transcript command separation.
- Explicit scroll design rather than relying on incidental terminal behavior.
- Keyboard handling for cancellation and exit paths.

### Review points

- Preserve scroll position when new streaming chunks arrive unless the user is following the bottom.
- Distinguish user scroll from automatic follow mode.
- Recalculate layout on terminal resize and narrow widths.
- Ensure long tool results and diffs are bounded/expandable rather than forcing unbounded terminal output.
- Ensure approval dialogs are keyboard reachable and cannot be accidentally accepted by unrelated keypresses.
- Ensure Ctrl+C, Escape×2, Ctrl+D, and `/cancel` all produce consistent abort semantics.
- Avoid rendering unsanitized terminal control sequences from model/tool output.
- Keep JSON/headless mode entirely separate from Ink output so automation receives parseable output.
- Test Unicode, wide characters, ANSI escapes, paste bursts, empty input, and very long lines.

## 12. Verification, tests, and eval harness

The project has a large TypeScript test suite across runtime, child workers, providers, tools, policy, MCP, context, TUI, persistence, verification, and CLI behavior. Evals use fixture/result directories and include scripted harness/judge concepts.

The strongest test categories are the ones that exercise security and state transitions: shell sandbox, policy, MCP policy/trust, providers, runtime, child workers, checkpoints, context trust, TUI parsing/measurement, and update verification.

### Important CI observation

`.github/workflows/ci.yml` runs install, typecheck, tests, build, and a smoke evaluation command. However, the smoke command is written with an unconditional fallback equivalent to:

```sh
node dist/index.js eval --suite smoke --runs 1 --parallel 1 || echo "smoke eval (stub) ok"
```

Therefore the CI job can remain green even if the smoke eval fails. This is the clearest process-level weakness found in the repository. Replace the fallback with a real fixture-backed smoke test, or mark it as a separate explicitly non-gating informational step. A release gate should never report success after a failed required smoke evaluation.

### Recommended evaluation matrix

- deterministic tool-schema and policy tests;
- provider contract tests with mocked streaming/error responses;
- prompt-injection fixtures in repository, MCP, memory, and web content;
- shell/path/symlink boundary fixtures;
- abort and child-process cleanup tests;
- session crash/recovery and schema migration tests;
- TUI resize/scroll/input tests;
- end-to-end smoke runs with no live provider dependency;
- judge-model tests that record rubric/version/cost and never gate solely on an unavailable external model.

## 13. Build, packaging, CI, and release

`package.json` targets Node >=20, uses strict TypeScript, emits declarations, builds to `dist`, and has `typecheck`, `test`, `build`, packaging, and publish scripts. The repository also contains `pnpm-workspace.yaml` for `packages/*`, while `package-lock.json` and publish/Docker paths use npm in places.

### Findings

1. **Package-manager inconsistency:** CI uses pnpm; publish uses npm; the repository contains `package-lock.json` and a pnpm workspace. This can produce different dependency graphs and should be normalized or deliberately documented with lockfile validation.
2. **Nested package drift:** `packages/shared/` exists as a workspace area but the main app appears primarily rooted in `src`. Verify whether the package is shipped/tested or stale; unused workspace packages add release ambiguity.
3. **Docker/release parity:** Docker installation and published package installation should use the intended lockfile and the same Node compatibility assumptions.
4. **Ignored build output:** `dist/` is present locally but not tracked, which is correct for a source repository; release checks should build from a clean checkout rather than relying on local `dist`.
5. **CI smoke fallback:** as noted above, the smoke eval failure is masked.
6. **Version/documentation drift:** README is updated for 1.0.9, while historical comparison and plan documents contain point-in-time claims. Label historical counts and maintain one authoritative current status document.

## 14. Documentation and project hygiene

The repository contains README/READ documentation, PRD, build plans, command references, TUI design and scroll documents, comparison material, prompts, and status/build artifacts. This is valuable project history, but multiple “source of truth” documents can disagree.

Recommended documentation hierarchy:

1. `README.md`: current user-facing installation and quick start.
2. `docs/done.md` or equivalent: current verified implementation/status.
3. `PRD.md`: product requirements.
4. `HarnessFlow.md`: authoritative architecture flow.
5. `plan.md`: roadmap and future work.
6. `comparison.md`: historical release comparison.
7. `commands.md`: generated or tested command reference.

The working tree currently shows deleted historical files (`comparison.1.0.6.md`, `comparison.md.bak`, `design.md`, and `.claude/scheduled_tasks.lock`) and no pre-existing `complete-review.md`. This report is the requested new `review.md` deliverable; it does not restore or remove those unrelated working-tree changes.

## 15. Prior release progression

Based on repository history and current documentation:

- **1.0.5:** addressed a broad audit set including abort cascade, default-ask execute/admin behavior, output scrubbing, update integrity, import restore, window-aware caps, stream throttling, error mapping, Vim/paste/fuzzy behavior, MCP serve, LSP, and sandbox rows.
- **1.0.6:** expanded the harness with hooks v2, open/scoped registries, approval edit-retry, rewind menu, result envelope, bare mode, memory trio, eval judge, provider registry, Vim grammar, file completion, remote MCP, init, and session merge.
- **1.0.7:** version/chore release in the available history.
- **1.0.8:** added `web_fetch`, `web_search`, and a network permission class, increasing the tool count from 32 to 34.
- **1.0.9:** added cross-turn TUI REPL session memory, full transcript adoption, short-prompt history handling, URL/tool-loop behavior, and prompt discipline for fetch claims/disambiguation.

The release history shows a consistent pattern of closing audit findings with targeted features. Future releases should preserve that discipline by attaching tests and explicit acceptance criteria to every new capability boundary.

## 16. Prioritized recommendations

### P0 — release/process correctness

1. Remove or isolate the CI smoke-eval `|| echo ...` fallback so a required smoke failure cannot pass the gate.
2. Normalize pnpm/npm lockfile and CI/publish/Docker behavior, or make the supported package-manager matrix explicit and tested.
3. Add a clean-checkout release test that builds `dist`, runs the CLI, and validates the final JSON envelope and exit codes.

### P1 — security boundary regression prevention

1. Build an adversarial policy test matrix covering path traversal, symlink escapes, shell argv, network permission, MCP tool trust, child-agent scope, retries, and abort cleanup.
2. Ensure all current and legacy provider/chat paths share URL validation, timeout, redaction, and error-mapping contracts.
3. Add prompt-injection fixtures for repository files, memory, MCP, and web content and assert that they cannot grant tools or override policy.
4. Test that a retry or resume cannot duplicate a completed side-effecting tool call.
5. Test remote MCP identity/trust invalidation when command, URL, or server configuration changes.

### P1 — persistence/recovery

1. Add atomic-write/crash simulation tests for sessions, audit chains, traces, and checkpoints.
2. Version persisted schemas and test import/export migrations.
3. Treat session/worktree identity as a resume precondition.

### P2 — maintainability and UX

1. Decompose `src/index.ts` command registration into command modules.
2. Retire or formally isolate legacy chat/REPL paths.
3. Generate/test command documentation from Commander definitions.
4. Add terminal matrix tests for resize, Unicode, ANSI, paste, scrolling, and approval keyboard behavior.
5. Maintain one current status document and clearly label historical documents.

## 17. Final conclusion

Klyro 1.0.9 is a credible, broad autonomous coding harness rather than a minimal chat wrapper. Its architecture includes the right major control points: provider adapters, a tool registry, policy/approval handling, context and memory management, autonomous runtime budgets, verification/repair, MCP trust, persistence, checkpoints, structured output, and a dedicated TUI.

The codebase should be considered **feature-rich and suitable for continued development, with release-process and integration-hardening work still required**. The most concrete issue to address before treating CI as a strong release signal is the masked smoke evaluation. The most important continuing security responsibility is to preserve policy equivalence across every path: normal run, bare run, REPL, legacy chat, child worker, MCP, retry, resume, and TUI/headless output.

## Appendix A — reviewed areas and representative files

- Entry/CLI: `src/index.ts`, `src/cli/run.ts`, `src/cli/repl.ts`, `src/cli/slash/`, `src/cli/config.ts`, `src/cli/update.ts`
- Providers: `src/providers.ts`, `src/providers/`, `src/agent/provider-adapter.ts`, `src/agent/anthropic-adapter.ts`, `src/chat.ts`
- Agents/runtime: `src/agent/runtime.ts`, `src/agent/orchestrator.ts`, `src/agent/child-worker.ts`, `src/agent/task-manager.ts`, `src/agent/worker-spawner.ts`, `src/agent/worktree-manager.ts`
- Tools: `src/tools/`, `src/tools/registry.ts`, `src/tools/types.ts`, shell/git/fs/search/verify/plan/web subdirectories
- Policy: `src/policy/`, `src/mcp/policy.ts`, `src/mcp/trust.ts`, `src/context/trust.ts`
- MCP: `src/mcp/`
- Context/memory: `src/context/`, `src/context/assembly.ts`, `src/context/compaction.ts`, `src/context/memory.ts`, `src/context/klyro-md.ts`
- Persistence/checkpoints: `src/persistence/`, `src/checkpoints/`, `src/trace/`, `src/events/`
- Verification/evals: `src/verification/`, `src/eval/`, `evals/`
- TUI: `src/tui/`, `scroll.md`, `TUI_DESIGN.md`
- Build/release: `package.json`, `package-lock.json`, `pnpm-workspace.yaml`, `Dockerfile`, `.github/workflows/ci.yml`, `.github/workflows/publish.yml`
- Current user documentation: `README.md`, `READ.md`, `commands.md`, `PRD.md`, `plan.md`, `comparison.md`
