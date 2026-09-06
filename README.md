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
