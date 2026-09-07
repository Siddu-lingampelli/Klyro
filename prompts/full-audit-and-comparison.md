# Full Audit + Architecture Review + Claude Code Comparison

You are conducting a **full architectural audit and a 1:1 comparison against Claude Code (CC)** on a CLI agent harness written in TypeScript (this codebase). You must verify everything on the user's side against actual file:line references, treat every claim on the CC side as behaviorally grounded (not assumed), and cover every architectural dimension the codebase has.

## Operating mode

1. **Verified-Code-Klyro** — for any claim about the local codebase, give a specific file:line. If you cannot find the file, do not invent — say "not verified, candidate location: <file>". Never fabricate file paths.
2. **Grounded-Behavior-CC** — for any claim about CC, ground it in CC's documented behavior, observable terminal output, or release notes. If you cannot ground it, mark as `Inferred-Design-CC` or omit.
3. **Inferred-Design-CC** — for design inferences that are not directly stated. Defensible but not verified.
4. **No "design-by-omission"** — do not invent features the user did not ask about. If something is absent in the codebase, say "absent" with the searched paths.
5. **Honesty first** — if a comparison is a wash, say "same shape, different emphasis", not "Klyro leads." If CC leads, say so.

## Inputs

- Local codebase: the project at the user's working directory.
- Reference target: Claude Code (the Anthropic CLI), observable via docs, /help, release notes, terminal behavior, and reverse engineering of public binaries if needed.
- Build/test state: read `package.json` and run the test suite to know the current green count and known flakes.
- Git state: the most recent commits to know where HEAD is.

## Phases (do all of them, in order)

### Phase 0 — Reconnaissance (5-10 minutes of work)

Produce a one-page report:
- Project name, version, entry point, build status (`tsc` exit code), test pass count.
- File tree at depth 2 (`src/`, `tests/`, `docs/`, `scripts/`).
- All registered tools (read the tool registry).
- All slash commands (read the slash parser).
- The agent loop's outer structure (read the runtime).
- The streaming provider adapter (read the adapter).
- The policy engine and the gates it runs.
- The terminal state machine.
- Any pre-existing audit or comparison artifact in the repo (search for `audit*.md`, `comparison*.md`, `plan.md`).

### Phase 1 — Self-Audit (8-12 dimensions, each one a round)

For each dimension below, deliver a single self-contained treatment of the codebase. Each treatment should be ~1-3 pages and follow this template:

```
# Round N — <Dimension Name>

## The contract being compared / audited

<what the dimension covers, in 2-3 sentences>

## The verified state on the local side

<every claim marked [Verified-Code-Klyro] with file:line, or [Verified-Absent] with search path>

## The CC side (or the reference side)

<[Grounded-Behavior-CC] / [Inferred-Design-CC] claims>

## Side-by-side

<table>

## The genuine divergences

<numbered list of structural differences>

## The takeaway

<2-4 sentence summary>
```

The dimensions to cover (treat as a checklist — at least these, more if you find more):

1. **The core turn** — one step in the agent loop, model → tool_use → tool_result → repeat
2. **Provider streaming** — SSE framing, event taxonomy, error semantics, retryable classification
3. **Tool catalog** — every tool, its input shape, its output shape, its risk class
4. **Permission policy tree** — gates, precedence, default verdict, escape clauses
5. **Context/budget scheduling** — hard ceiling, drop vs summarize, tripwires, observability
6. **Interrupt & abort** — signal threading, terminal status, child-process handling, audit trail
7. **Event bus & observability** — typed events, trace file, bus dispatch, replayability
8. **Error taxonomy & recovery** — error codes, retryability, structured payloads, redactor
9. **Session lifecycle** — checkpoint, resume, ids, persistence, isolation
10. **Verification sub-loop** — verify gate, failure classification, repair bounded by `maxRepairs`
11. **Token / cost accounting** — estimate, accumulate, surface
12. **Secret hygiene** — `.env` handling, redactor, straddle buffer, log scrubbing
13. **Output rendering** — markdown, syntax highlighting, themes, streaming correctness
14. **Keyboard / keymap** — every binding, mode-conditional, paste handling, input queue
15. **CWD / sandbox** — path-guard, realpath, symlink defense, OS-level sandbox
16. **Update / self-upgrade** — registry check, cache TTL, auto-install, signature
17. **Telemetry semantics** — in-process self-context vs product analytics, opt-in granularity
18. **Bootstrap / first-run** — project memory, repo map, level-6 context

Add more rounds if you find additional dimensions. Each round must be self-contained, end with a one-line takeaway, and reference the next round.

### Phase 2 — Cross-cutting audit (post-round)

After the per-dimension rounds, run a cross-cutting audit:
- **Risk register** — top 10 structural risks in the codebase, each with severity, file:line, recommended fix.
- **HIGH-severity findings** — the 3-5 most pressing issues that need fixing before any public release.
- **Known flakes** — any tests that are intermittent, with their nature (timing, IO, etc.).
- **Documentation gaps** — areas where the code's behavior is non-obvious and needs a docstring.
- **Performance hotspots** — any obvious N² or memory-leak issues, with file:line.

### Phase 3 — Capstone synthesis

After all per-dimension rounds and the cross-cutting audit, deliver **one capstone round** that:
- Names the 12 most load-bearing architectural dimensions in order.
- Identifies the 4 deepest structural asymmetries.
- Lists the 7 highest-leverage moves for the local codebase.
- Lists the 7 highest-leverage moves for CC (inverted, hypothetical).
- Closes with a single paragraph distilling the architectural difference.

### Phase 4 — Consolidated artifact

After the capstone, write a single file `<project>/comparison.md` that contains:
- Header explaining the marks [Verified-Code-Klyro], [Grounded-Behavior-CC], [Inferred-Design-CC].
- All rounds verbatim, in order.
- The risk register.
- A "where the verbatim text lives" section if any rounds were reconstructed from a summary.

If the comparison.md already exists, replace it. Back up the prior version to `comparison.md.bak` first.

## Hard rules

- **Do not repeat a sub-topic already covered** — if a round is already in the conversation, do not re-deliver it; refer to it by number and continue.
- **Do not invent a sub-topic** — if the catalog is exhausted after the capstone, stop. Do not produce more rounds.
- **Be honest about what you cannot verify** — if a file is not found, if a function is not present, say so. Never make up file paths.
- **Keep each round self-contained** — assume the reader has not seen the prior round. Tables, file:line, takeaways.
- **Stop at the capstone** — the final round is the synthesis, not another topic.

## Length budget per round

- ~1-3 pages of text.
- ~1 side-by-side table.
- 4-7 numbered divergences.
- 2-4 sentence takeaway.
- ~6-12 file:line references on the local side.
- ~6-12 grounded or inferred references on the CC side.

## Tempo

- Do not stop to ask the user to confirm the plan. They have already read it.
- Do not run `npm install` or `npm test` unless the build status is unknown. The `tsc` and test state from prior turns is usually good enough.
- Do not push to a remote. Do not cut a release. Do not run a benchmark.
- Do read the actual files you cite. Do not cite by memory.
