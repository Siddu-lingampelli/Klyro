# Klyro

Autonomous AI coding harness — terminal-native agent (CLI + Ink TUI) for any OpenAI-compatible or Anthropic LLM endpoint.

## What works today

- Streams from `https://<host>/v1/chat/completions` (OpenAI-compatible) and Anthropic `/v1/messages`
- HTTPS-only (with localhost exemption for local LLMs)
- Per-request timeout, retry with backoff, usage/cost accounting
- Interactive Ink TUI + REPL with multi-turn history, slash commands, approvals
- Autonomous loop: phases, budgets, stuck detection, verification + repair
- 34 built-in tools (fs/search/shell/git/verify/plan/web), policy engine, MCP client/server
- Session persistence (JSON), hash-chained audit log, checkpoints/undo, eval harness
- Strict TypeScript (`tsc`, noEmit typecheck, vitest)

## Quick start

```bash
npm run build
export KLYRO_BASE_URL="https://api.groq.com/openai/v1"
export KLYRO_API_KEY="gsk_..."
export KLYRO_MODEL="openai/gpt-oss-20b"

# One-shot
node dist/index.js chat "Explain TypeScript in 2 sentences"

# Interactive
node dist/index.js chat
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success / complete |
| 1 | Unexpected failure (last-resort handler) |
| 2 | Usage / config error, policy refusal to commit, unknown command or option |
| 3 | Config invalid / not found |
| 4 | Provider error (auth, rate-limit, timeout) |
| 5 | No final answer from provider |
| 7 | Stopped: max steps, cost/time limit, or stuck |
| 8 | Verification failed (or `--require-verify` unsatisfied) |
| 130 | Aborted (Ctrl+C / Esc×2 / /cancel / SIGINT) |

## Environment

| Variable | Scope |
|---|---|
| `KLYRO_BASE_URL`, `KLYRO_API_KEY`, `KLYRO_MODEL`, `KLYRO_PROVIDER` | Provider selection |
| `KLYRO_CONFIG` / `--config` | Config file override |
| `KLYRO_YES` / `--yes` | **Commit only** — auto-approves `klyro commit` prompts; nothing else reads it |
| `KLYRO_NO_UPDATE_CHECK=1` | Disables the 24h update check |
| `KLYRO_ALLOW_MAIN_PUSH=1` | Per-risk escape for protected-branch push |
| `KLYRO_TRUST_PROJECT_HOOKS=1` | Per-shell opt-in to run repo-authored `.klyro/hooks.json` commands without pinning them via `klyro hooks trust` |
| `KLYRO_CREDENTIALS_INSECURE_OK=1` | Warn (don't refuse) on group-readable credentials |
| `KLYRO_LSP=0` | Force language tools off |
| `KLYRO_SYMBOLS=0` | Force `find_symbol` off |
| `KLYRO_WORKER=0` | Disable subprocess isolation for subagents |
| `KLYRO_SESSIONS_DIR`, `KLYRO_UPDATE_CACHE`, `KLYRO_CREDENTIALS_FILE` | Relocatable state (tests + power users) |

## New in recent releases

- `klyro run --bare` — deterministic runs: skips MCP, hooks, memory/KLYRO.md/context, persistence
- `klyro hooks trust` — project `.klyro/hooks.json` commands run only after explicit review: the file is hash-pinned in `~/.klyro/trusted-hooks.json` and any edit re-locks it (a cloned repo can no longer execute code just because you ran `klyro` in it)
- `klyro mcp trust <name>` / `mcp prompts [server]` / `mcp add <name> <https-url>` — remote MCP + prompt trust
- `klyro agents lint` — validate `.klyro/agents/*.md` (ids, tool names)
- `klyro init` — scan-seeded `KLYRO.md` + `.mcp.json` (never overwrites)
- `klyro update --apply` — opt-in self-apply of the verified update
- `klyro eval --judge-model <id>` — model-graded rubric scoring
- Hooks: `matcher` scoping, stdin JSON, `sessionStart`/`sessionEnd`/`stop` events, JSON verdicts
- Custom agents (`.klyro/agents/*.md`), custom commands (`.klyro/commands/*.md`), vim mode (`/vim`), `@`-file completion
- Credentials prefer the OS keychain (macOS Keychain, Linux libsecret), 0600 file fallback
- Headless JSON ends with exactly one stable `kind:result` envelope (parse the LAST line)

## Documentation

Progress: Klyro is **complete through Level 10** ("Klyro 1.0" milestone) of the
20-level plan; see [`docs/STATUS.md`](docs/STATUS.md) for the audited
level-by-level grading.

| Doc | Purpose |
|---|---|
| [`docs/STATUS.md`](docs/STATUS.md) | **Status (authoritative)** — release state + plan level progress |
| [`plan.md`](plan.md) | **Roadmap** — 20-level / 100-sub-level plan from bare CLI to super-harness |
| [`PRD.md`](PRD.md) | Product vision and requirements |
| [`READ.md`](READ.md) | Full build documentation / architecture walkthrough |
| [`review.md`](review.md) | Point-in-time repository review (1.0.9) |
| [`comparison.md`](comparison.md) | Architectural audit vs Claude Code (36 rounds) |
| [`commands.md`](commands.md) | CLI + slash-command reference |
| [`TUI_DESIGN.md`](TUI_DESIGN.md) | TUI design notes (layout, scroll model) |

## Code structure

```
src/
├── index.ts        # commander entry — tui/run/chat/eval/session/mcp/agents/commit/audit/...
├── agent/          # runtime loop, orchestrator, adapters, worktree, tasks
├── cli/            # run/repl/config/doctor/hooks/eval/slash/...
├── tools/          # 34 built-ins: fs/search/shell/git/verify/plan/web (+ registry)
├── policy/         # engine, path-guard, approval, secret-redactor
├── context/        # project-map, repo-map, tokenizer, compaction, memory, trust
├── verification/   # registry, parsers, repair loop, baseline, scoped
├── mcp/            # client (stdio/SSE/HTTP), trust, serve, OAuth
├── persistence/    # JSON session store, hash-chained audit
├── checkpoints/    # snapshots, undo/rewind
├── events/ trace/ renderers/  # event bus, JSONL traces, terminal/JSON output
├── tui/            # Ink app (transcript, approval, diff, scroll, markdown)
├── eval/           # scripted harness, tasks, judge
└── chat.ts / repl.ts  # legacy one-shot chat + legacy REPL
```

## License

MIT
