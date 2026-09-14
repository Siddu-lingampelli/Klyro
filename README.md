# Klyro

Minimal streaming CLI for any OpenAI-compatible LLM endpoint. **Foundation piece** of the Klyro harness project.

## What works today

- Streams from `https://<host>/v1/chat/completions`
- HTTPS-only (with localhost exemption for local LLMs)
- Per-request timeout
- Interactive REPL with multi-turn history
- Bounded error reads
- Strict TypeScript, zero dependencies beyond `commander`

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
| `KLYRO_CREDENTIALS_INSECURE_OK=1` | Warn (don't refuse) on group-readable credentials |
| `KLYRO_LSP=0` | Force language tools off |
| `KLYRO_SYMBOLS=0` | Force `find_symbol` off |
| `KLYRO_WORKER=0` | Disable subprocess isolation for subagents |
| `KLYRO_SESSIONS_DIR`, `KLYRO_UPDATE_CACHE`, `KLYRO_CREDENTIALS_FILE` | Relocatable state (tests + power users) |

## New in recent releases

- `klyro run --bare` — deterministic runs: skips MCP, hooks, memory/KLYRO.md/context, persistence
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

| Doc | Purpose |
|---|---|
| [`docs/done.md`](docs/done.md) | **Status** — what's built, what's verified, what isn't |
| [`docs/plan.md`](docs/plan.md) | **Roadmap** — 20-level plan from bare CLI to super-harness |
| [`docs/PRD.md`](docs/PRD.md) | (authoritative) product vision |
| [`docs/HarnessFlow.md`](docs/HarnessFlow.md) | (authoritative) system flow |
| [`docs/MVP.md`](docs/MVP.md) | (authoritative) MVP scope |

## Code structure

```
src/
├── index.ts   # commander entry — two commands (chat, REPL)
├── chat.ts    # single-turn streaming chat (251 LOC)
└── repl.ts    # multi-turn REPL (168 LOC)
```

## License

MIT
