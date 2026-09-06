# Klyro Terminal UI Design

> Single source of truth for everything Klyro draws in a terminal. Every sub-level that ships UI (1.4 → 20.5) implements against this document. If a component is not specified here, it does not ship until it is.
>
> Style: **professional, minimal, monochrome + one accent.** Tool activity is **grouped and collapsed** (`Read 3 files`, `Ran 2 commands`, `Edited 1 file`) and expands on demand — the model used by Claude Code, Codex and OpenCode. The transcript reads like a narrative, not a log.

File: `docs/design/ui.md`

---

## 0. Scope & reference

### 0.1 Reference frame

```
KLYRO  v0.1.14                                       │  /help   /config   /clear   /exit
opus-5[1m]  ·  API Usage Billing
A:\claude code\Agent  ·  main

> check the current directory and analyze it

  │ ● Klyro
  │   Thinking...
  │
  │   ▸ Listed A:\claude code\Agent                                            24ms
  │   ▸ Read package.json                                                      12ms
  │
  │   This is a Node.js/TypeScript project — a Klyro AI coding harness with a
  │   modular structure: CLI, core, tools, and providers. Let me explore src to
  │   understand the codebase layout.
  │
  │   ▸ Read 6 files                                                           41ms
  │   ▸ Searched 2 patterns                                                    88ms
  │
  │   The codebase is organised as a pnpm workspace …

────────────────────────────────────────────────────────────────────────────────────────
> Message @code-review…
────────────────────────────────────────────────────────────────────────────────────────
shift+tab to cycle  ·  ↑↓ for history  ·  ctrl+o expand                auto mode on ●
```

Same transcript with the second group expanded (`Ctrl+O`):

```
  │   ▾ Read 6 files                                                           41ms
  │     └ src/index.ts                                                    58 lines
  │     └ src/cli/index.ts                                               142 lines
  │     └ src/core/agent.ts                                              310 lines
  │     └ src/core/events.ts                                              88 lines
  │     └ src/tools/registry.ts                                          121 lines
  │     └ src/providers/anthropic.ts                                     204 lines
  │   ▾ Searched 2 patterns                                                    88ms
  │     └ grep "export function" src/                                12 matches · 4 files
  │     └ glob "src/**/*.test.ts"                                              9 files
```

### 0.2 In scope
- REPL rendering: header, transcript, live region, input, status line.
- Activity groups and expanded tool cards for every tool in the plan.
- All overlays, pickers, menus, gates reached via slash commands or events.
- Headless (`-p`) text output; `--json` / `stream-json` parity.
- Degradation: non-TTY, `NO_COLOR`, narrow widths, Windows Terminal, conhost, mintty, tmux, VS Code, SSH.
- Keyboard and (optional) mouse model.
- Event → component mapping.

### 0.3 Out of scope
- L20 web dashboard (`docs/design/dashboard.md`).
- VS Code extension views (10.4; separate doc).

### 0.4 Renderer independence
The Ink-vs-custom decision is deferred to 10.4. This document specifies **regions, frames, and text**, never widgets. Either renderer must produce byte-identical output for the snapshot suite in `cli/ui/__snapshots__`.

---

## 1. Principles

1. **One accent.** Orange marks *Klyro's voice only*: wordmark, prompt chevron, agent bullet and name, the active item, the mode dot. Semantic colors (green/red/amber) color a single glyph or a short status word — never fills, never long text.
2. **Text is the interface.** No boxes, borders, banners, or panels. Structure comes from indentation, one vertical guide `│`, and whitespace.
3. **Group, then collapse.** Consecutive tool calls form an *activity group*. A group renders as one line per verb (`Read 3 files`). Detail is one keypress away, never in your face.
4. **Scrollback is sacred.** Committed lines are written once and never redrawn. Only the *live window* (current turn) and the *pinned* area (input + status) repaint.
5. **Right column = metadata.** Durations, counts, costs sit right-aligned in dim text. Content owns the left two-thirds.
6. **Everything visible is an event.** No component renders from state that is not derivable from the `KlyroEvent` stream. `--json` and the terminal show the same facts.
7. **Never trap the user.** Every blocking state shows its escape key. `Esc` always backs out. The terminal is always restored on exit.
8. **Degrade, don't break.** Every component defines its narrow, non-TTY and no-color form.

---

## 2. Visual language

### 2.1 Color tokens

Klyro never paints a background (except inside the full-screen diff viewer). Tokens are foreground only and inherit the terminal background.

| Token | Role | Dark | 256 | 16-color | Light |
|---|---|---|---|---|---|
| `accent` | Wordmark, `>` chevron, `●` agent bullet + name, mode dot, selected row | `#E8843C` | 209 | yellow bold | `#C25E12` |
| `fg` | Primary: user input, headings, tool verbs, file names, key labels | `#E6E6E6` | 254 | white | `#1A1A1A` |
| `fg.soft` | Secondary: assistant prose, tool output, list items, header labels | `#B3B3B3` | 249 | white | `#3D3D3D` |
| `fg.dim` | Tertiary: hints, placeholders, durations, `Thinking...`, notices | `#6F6F6F` | 243 | bright black | `#8A8A8A` |
| `guide` | `│ ├ └ ─` structure, rules, empty meter cells | `#3A3A3A` | 237 | bright black | `#D0D0D0` |
| `ok` | `✓`, `passed`, diff `+` | `#6BBF6B` | 71 | green | `#2E8B2E` |
| `err` | `✗`, `failed`, diff `-`, fatal `✖` | `#E06C6C` | 167 | red | `#C0392B` |
| `warn` | `!`, `↻`, approaching limits, stale, flaky | `#D9A441` | 179 | yellow | `#B7791F` |
| `info` | Rare: URLs, compaction `·` | `#6FA8DC` | 74 | blue | `#2B6CB0` |
| `diff.add.bg` | Added line background, diff viewer only | `#12250F` | 22 | none | `#E6F4E6` |
| `diff.del.bg` | Removed line background, diff viewer only | `#2A1212` | 52 | none | `#F9E6E6` |

Rules:
- `accent` on ≤ 5 % of on-screen characters.
- `ok/err/warn` on a glyph plus at most 12 following characters.
- **Bold** only for: wordmark, group verbs, tool/file names in expanded cards, headings, selected picker row, key names in menus.
- No italics. Underline only for URLs (OSC 8 where supported).
- Themes: `dark` (default), `light`, `mono`. `NO_COLOR` ⇒ `mono`.

### 2.2 Glyph set

Only these glyphs are used; each has an ASCII fallback for `TERM=dumb`, non-UTF-8 locales, or `--ascii`.

| Purpose | Glyph | Fallback |
|---|---|---|
| Prompt / user marker | `>` | `>` |
| Agent bullet | `●` | `*` |
| Group collapsed / expanded | `▸ ▾` | `> v` |
| Guide, branch, end, rule | `│ ├ └ ─` | `\| \| \` -` |
| Tree inside tool output | `├── └──` | `\|-- \`--` |
| Success / failure / warning / repair | `✓ ✗ ! ↻` | `ok x ! ~` |
| Todo pending / active / done / plan | `○ ● ✓ ◇` | `[ ] [>] [x] #` |
| Mode accept-edits / plan / auto | `◐ ○ ●` | `e p a` |
| Spinner | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | `\|/-\` |
| Edits badge | `✎` | `~` |
| Separator / ellipsis | `· …` | `- ...` |
| Meter filled / empty | `▰ ▱` | `# -` |
| Continuation (wrapped code) | `↪` | `\` |
| Diff | `+ -` | `+ -` |

`supportsUnicode()` = not `TERM=dumb` ∧ (UTF-8 locale ∨ Windows Terminal ∨ VS Code ∨ `CI`) ∧ not mintty-without-UTF-8. Cached per session; printed by `klyro doctor`.

### 2.3 Layout grid

All indentation is in cells from column 0. `W` = terminal columns.

```
col:  0 2 4 6 8
      > user text                              user turn: chevron col 0, text col 2
        │ ● Klyro                              guide col 2, bullet col 4, name col 6
        │   assistant prose                    prose col 4, wraps at W-2
        │   ▸ Read 3 files              41ms   group line: marker col 4, verb col 6, meta → W-2
        │     └ src/a.ts            58 lines   expanded item: └ col 6, content col 8
        │       output…                        item output col 8
```

- Right metadata is right-aligned to `W-2`. Content is hard-wrapped at `W-2`; truncation only where a component says so.
- Sub-agent nesting adds 4 cells per depth with its own guide (§15).
- Vertical rhythm: one blank line between turns; one blank line between prose and a group; never two consecutive blank lines.
- Rules span `W`, `guide`-colored.

### 2.4 Breakpoints

| W | Behavior |
|---|---|
| ≥ 120 | Reference layout; header quick links shown. |
| 90–119 | Quick links dropped. |
| 60–89 | Right metadata moves inline: `▸ Read 3 files · 41ms`. Status drops hints, keeps cost/ctx/mode. Pickers single-column. |
| < 60 | Linear mode (§19.4). |

Resize repaints live window + pinned only.

---

## 3. Screen anatomy & rendering model

```
┌ scrollback (committed once) ─────────────────────────────────────────┐
│ header · previous turns                                              │
├ live window (repaintable; the current assistant turn, ≤ liveRows) ───┤
│ streaming prose tail · running/collapsible groups · plan checklist   │
│ · verification panel · activity block · pickers · viewers            │
├ pinned (always last rows) ───────────────────────────────────────────┤
│ ────────── rule                                                      │
│ > input (1..N rows)                                                  │
│ ────────── rule                                                      │
│ status line                                                          │
└──────────────────────────────────────────────────────────────────────┘
```

**Live window.** The current assistant turn is repaintable while it runs. Its max height is `ui.liveRows` (default 24, tmux 12). When the turn grows past that, its **oldest lines commit to scrollback** and become immutable; the tail stays live. When the turn ends, the whole turn commits. Pickers and viewers temporarily claim the live window (max `rows − 6`).

**Expansion window.** `Ctrl+O` and mouse toggles apply to groups inside the live window. Groups already committed cannot be redrawn; use `/expand` (§5.3.5), which prints the expanded detail as a new committed block. This is the only honest way to do "click to expand" on top of real scrollback.

**Frame coalescing.** Events are batched for 33 ms (≈30 fps). A repaint never rewrites more than live + pinned rows. Snapshot test: 1k-line stream, ≤ 1 pinned repaint per frame, zero scrollback rewrites.

**Cursor** is parked on the input line except in pickers/menus (hidden).

---

## 4. Header

Printed once at session start, after `/clear`, and after `/resume`.

```
KLYRO  v0.1.14                                       │  /help   /config   /clear   /exit
opus-5[1m]  ·  API Usage Billing
A:\claude code\Agent  ·  main
```

| Row | Content |
|---|---|
| 1 | `KLYRO` (accent bold) `v{version}` (fg.soft). Right: `│` (guide) + `/help /config /clear /exit` (fg.soft), 3-space gaps, right-aligned to `W-2`; hidden when W < 120. Static text. |
| 2 | `{alias}[{ctx}]  ·  {provider} {authLabel}` (fg.soft). `ctx` short form `200k` / `1m`. `authLabel` ∈ `API Usage Billing`, `OAuth`, `env key`, `local`. |
| 3 | cwd as the OS prints it, `~` collapsed on POSIX (fg.soft) `  ·  {branch}` (fg.dim) when in git. |
| 4 (optional, ≤ 2 rows) | Notices, fg.dim, prefixed `!` (warn) or `·`: update available, resumed session, sandbox tier, managed settings, MCP error. Overflow → `/status`. |

```
! update available: v0.1.15  ·  klyro update
· resumed "jest → vitest migration"  ·  12 turns  ·  $0.84  ·  3 files changed externally (/diff)
· sandbox: os  ·  network: allowlist
```

Non-TTY / `-p`: no header.

---

## 5. Transcript

### 5.1 User turn

```
> check the current directory and analyze it
```
- `>` accent bold, text `fg`. Multiline continues at col 2 with no marker.
- Attachments follow, fg.dim:
  ```
  > explain this
    @src/auth/login.ts (L12–40)
    [image 1024×768 · clipboard]
    !git status → 14 lines
  ```
- Slash commands echo as typed (`> /diff`); output follows at assistant indentation **without** the `● Klyro` header.

### 5.2 Assistant turn

```
  │ ● Klyro
  │   Thinking...
  │
  │   prose
  │
  │   ▸ Read 3 files                                                            41ms
  │
  │   more prose
```
- Guide `│` at col 2 spans from the bullet row to the last row of the turn, drawn as lines commit.
- Header `● Klyro` (accent). Sub-agents replace the name (§15). If role/model differs from default: `● reviewer  ·  opus` (fg.dim suffix).
- **Thinking**: collapsed to `Thinking...` (fg.dim); `Thinking... 4s` while streaming. With `--show-thinking` / `/thinking on`, text streams in fg.dim at col 4 and collapses to `Thinking... (312 tokens)` when the first non-thinking block arrives, unless `thinking.keep=true`.
- **Prose**: markdown → terminal (§5.8), `fg.soft`.
- **Interrupted**: `  │   [interrupted]` (fg.dim), partial text kept.
- **Cancelled during tools**: `  │   [cancelled by user]`; model not re-invoked.

### 5.3 Activity groups

**Definition.** A group = the maximal run of tool calls in one assistant turn not interrupted by prose (thinking does not break a group). Parallel batches belong to one group.

#### 5.3.1 Verb table

Calls inside a group are bucketed by verb, rendered one line per verb in first-occurrence order.

| Tools | Singular (1 item, fits) | Plural | Right column |
|---|---|---|---|
| `read_file` | `Read package.json` | `Read 3 files` | total ms |
| `list_dir` | `Listed src/` | `Listed 2 directories` | total ms |
| `grep` `glob` `find_files` | `Searched "authenticate"` | `Searched 3 patterns` | total ms |
| `shell` (foreground) | `Ran npm test` | `Ran 2 commands` | total time; `✗` if any non-zero exit |
| `shell` (background) | `Started npm run dev  ·  j_3` | always one line each | `background` |
| `edit_file` `multi_edit` `apply_patch` `write_file` (existing) | `Edited src/a.ts` | `Edited 3 files` | `+a −d · ms` |
| `write_file` (new) | `Created src/slug.ts` | `Created 2 files` | `+a · ms` |
| `git_*` | `Checked git status` | `Checked git (status, diff)` | ms |
| `web_fetch` | `Fetched docs.pnpm.io` | `Fetched 3 pages` | total time |
| `web_search` | `Searched web "vitest config"` | `Searched web 2 queries` | total time |
| `repo_map` `imports_of` `importers_of` `recent_changes` `find_symbol` `references` `outline` `diagnostics` `goto_definition` | `Mapped repo` / `Traced imports of src/a.ts` / `Found symbol slugify` | `Analyzed 3 symbols` | ms |
| `expand_result` | `Expanded r_8f2a` | `Expanded 2 results` | ms |
| `bash_output` `kill_shell` | `Checked j_3` / `Stopped j_3` | `Checked 2 jobs` | ms |
| `memory_write` | `Noted session-notes.md` | — | `+n lines` |
| `artifact_read` `artifact_write` | `Read artifact api-schema` / `Wrote artifact api-schema` | `… N artifacts` | ms |
| MCP tools | `Called github:create_issue` | `Called 3 github tools` | ms |
| `task` | **never bucketed** — one line per agent, §15.1 | | |
| `todo_write` `ask_user` `plan` | **not shown as group lines** — render as checklist / gate | | |

- Singular form uses the primary argument (path relative to cwd, command truncated to 48 cells, pattern quoted). If the singular text would exceed `W-2-16`, fall back to the count form.
- Two-item read/edit lists may be inlined when they fit: `Read package.json, tsconfig.json`.
- Plural is used for ≥ 3 items, or ≥ 2 when they don't fit.

#### 5.3.2 States

**Running** (spinner replaces marker; counts update live)
```
  │   ⠋ Reading 3 files                                                       0.4s
  │   ⠋ Running npm test                                                     12.4s
  │       ✓ src/auth/login.test.ts (14 tests) 812ms
```
Running uses the present participle (`Reading`, `Searching`, `Running`, `Editing`, `Fetching`, `Calling`). For `shell`, the last output line shows beneath (§5.6).

**Collapsed (default after completion)**
```
  │   ▸ Read 3 files                                                           41ms
  │   ▸ Searched 2 patterns                                                    88ms
  │   ▸ Ran npm test                                                           4.1s
```

**Expanded**
```
  │   ▾ Read 3 files                                                           41ms
  │     └ package.json                                                    42 lines
  │     └ tsconfig.json                                                   18 lines
  │     └ src/index.ts                                                    58 lines
  │   ▾ Ran npm test                                                           4.1s
  │       > vitest run
  │       ✓ src/auth/login.test.ts (14 tests) 812ms
  │       ✓ src/utils/slug.test.ts (6 tests) 40ms
  │       Test Files  2 passed (2)
  │       [tail · 6 of 41 lines · full: ~/.klyro/tool-output/t_91.txt]
```
Expanded items use the per-tool card format (§5.4).

**Partial failure** — a verb line containing an error, denial, block, or timeout is **never** collapsed; it renders expanded with the failing item first and the right column marked:
```
  │   ▸ Read 2 files                                                           20ms
  │   ▾ Edited src/auth/login.ts                                             ✗ 9ms
  │     └ src/auth/login.ts                                             not found
  │       old_string not found. Closest match L44–47 (similarity 0.82):
  │         │  return authenticate(user, opts);
  │       Re-read the file and retry.
```
Status words in the right column: `✗` (err), `denied`, `blocked`, `cancelled`, `timeout` (fg.dim).

**Denied / blocked**
```
  │   ▾ Edited .env                                                          denied
  │     └ .env                                              permissions.deny rule
  │   ▾ Ran rm -rf /                                                        blocked
  │     └ denylist: destructive filesystem command · not approvable outside --yolo
```

**Cancelled**
```
  │   ▾ Ran npm test                                                  cancelled 4.1s
  │   [cancelled by user]
```

**Approved calls** (default mode) carry the decision in expanded form only: `└ src/a.ts   approved · once`.

#### 5.3.3 Edits and diffs

`Edited`/`Created` lines show `+a −d`. Diffs appear:
- inline under the line when `ui.showDiffs=auto` (default) **and** the diff was not already shown in an approval menu **and** ≤ 40 changed lines;
- always when expanded;
- never when `ui.showDiffs=never`.

```
  │   ▾ Edited src/utils/slug.ts                                       +6 −1 · 14ms
  │       @@ -12,4 +12,9 @@
  │        export function slugify(input: string) {
  │       -  return input.toLowerCase().replace(/\s+/g, "-");
  │       +  return input
  │       +    .normalize("NFKD")
  │       +    .replace(/[\u0300-\u036f]/g, "")
  │       +    .toLowerCase()
  │       +    .trim()
  │       +    .replace(/\s+/g, "-");
  │        }
```
Large diffs collapse to `+142 −38 · /diff src/big.ts`. See §5.5 for diff rules.

#### 5.3.4 Group ids

Every group has an id `g{n}` per session. It is shown in the right column of the **first** verb line only when expanded (`g12`, fg.dim, before the duration), in `/expand`, and in traces. Collapsed lines don't show ids.

#### 5.3.5 Expansion controls

| Control | Effect |
|---|---|
| `Ctrl+O` | Toggle the **most recent** group in the live window. |
| `Ctrl+O` `Ctrl+O` (within 1 s) | Toggle **all** groups in the live window and set the session default (`expanded`/`collapsed`). |
| Mouse click on a `▸`/`▾` line | Toggle that group (only when `ui.mouse=true`, §20.2). |
| `/expand` | Picker of groups in the session (`g14  Read 6 files · Searched 2 patterns   turn 7   2m ago`); selecting prints the expanded group as a new committed block headed `── g14 · turn 7 ───`. `/expand g14` skips the picker. `/expand last` = most recent. |
| `ui.tools = collapsed \| expanded` | Persistent default. |
| `--verbose` | Session default `expanded`. |

Expanded is sticky for the specific group for the rest of its live life; a re-collapsed group stays collapsed when it commits.

#### 5.3.6 Group boundaries — edge cases
- Thinking blocks between calls do **not** split a group.
- A `task` call always starts and ends its own line (§15.1) but remains within the surrounding group's vertical block (no blank line).
- A `todo_write` between calls does not split the group; the checklist re-renders in the live window.
- A failing verification (`shell` run by the verifier) is not a group — it's the verification panel (§12).
- Slash-command tool calls (`/init`, `/commit`) group like any other calls.

### 5.4 Expanded tool cards (per-tool item format)

Item grammar: `└ {primary}` at col 6, right column summary, optional detail lines at col 8.

| Tool | Item line | Detail (expanded) |
|---|---|---|
| `read_file` | `└ {path}` · `{n} lines` / `{n} lines · from L{off}` / `image {w}×{h}` / `unchanged since turn N` | none (content is for the model) |
| `list_dir` | `└ {path}` · `{n} entries` | tree with `├── └──`, ≤ 20 entries then `└── … +{n} more` |
| `grep` | `└ grep "{pattern}" {path}` · `{m} matches · {f} files` | `file:line  text` ≤ 12 rows, `… +n more` |
| `glob` / `find_files` | `└ glob "{pattern}"` · `{n} files` | ≤ 12 paths |
| `shell` | `└ {command}` · `exit {code}` / `{time}` | `> {command}` then head 4 + tail 8 lines; footer `[tail · x of y lines · full: path]` |
| `edit_file` etc. | `└ {path}` · `+a −d` (`· CRLF→LF` if EOL changed) | unified diff |
| `write_file` | `└ {path}` · `created · +n` / `overwritten · +a −d` | diff vs previous if overwritten |
| `git_*` | `└ git {sub}` · `{n} lines` | structured output ≤ 12 rows |
| `web_fetch` | `└ {url}` · `{kb}kb · cached?` | title line |
| `web_search` | `└ "{query}"` · `{n} results` | `title — host` ≤ 5 |
| MCP | `└ {server}:{tool} {firstArg}` · `{ms}` | pretty `key: value` of result ≤ 12 rows |
| `expand_result` | `└ {id}` · `{n} lines` | — |
| `memory_write` | `└ session-notes.md` · `+n lines` | the appended lines |

Universal footers (fg.dim):
- `[truncated · {shown} of {total} lines · expand_result {id}]`
- `[full: ~/.klyro/tool-output/{id}.txt]`
- `[stored {id}]` for large results kept on disk (L8).

Duration format: `{n}ms` under 1 s, `{s.t}s` under 60 s, `{m}m{ss}s` beyond.

### 5.5 Diff rules

- Unified, 3 lines of context. `+` `ok`, `-` `err`, context `fg.soft`, hunk header `fg.dim`.
- Backgrounds (`diff.*.bg`) only in the full-screen viewer (§16.9).
- Tabs → 2 spaces. CRLF invisible (badge in the item line only).
- Binary: `binary file changed ({size})`.
- Renames: `renamed from {old}`.

### 5.6 Shell live output

While a foreground `shell` runs, the running line shows the **last non-empty output line** beneath it (fg.soft, truncated to width). `Ctrl+O` shows the last 8 lines. On completion the item collapses per §5.3. `Ctrl+B` moves a running command to the background (`Started … · j_n`).

Background shells:
```
  │   ▸ Started npm run dev  ·  j_3                                       background
```
Expanded: `└ output: /jobs j_3 · stop: kill_shell j_3 · port 5173 detected`.

### 5.7 End-of-turn summary

Last line of any turn that mutated files, fg.dim:
```
  │   ✎ 3 files (+41 −7)  ·  src/utils/slug.ts  src/utils/slug.test.ts  README.md
```
Overflow → `… +2 more (/diff)`. With verification (L6+): `· ✓ tests 1.8s` / `· ✗ tests 2 failed`.

### 5.8 Markdown rendering

| Markdown | Terminal |
|---|---|
| Headings | Bold `fg`; H1 uppercase; blank line before; no rules; never accent |
| Paragraph | `fg.soft`, wrapped at `W-2` − indent |
| `**bold**` | `fg` bold |
| `` `code` `` | `fg`, no background |
| Fenced code | +2 indent; language label right-aligned fg.dim; highlight: keywords `fg` bold, strings `fg.soft`, comments `fg.dim`; long lines wrap with `↪` |
| Lists | literal `-`/`1.`; +2 per level; depth ≤ 4 |
| Tables | space-aligned; header bold; `─` underline in `guide`; `key: value` rows when W < 80 |
| Links | `text (url)`; OSC 8 when supported |
| Blockquote | `│ ` prefix in `guide` |
| HR | 40 × `─` in `guide` |
| Images | `[image: alt]` |

Streaming holds back an unterminated fence/table/list item until closed or a blank line arrives; latency budget ≤ 100 ms.

---

## 6. Input line

```
────────────────────────────────────────────────────────────────────────────────────────
> Message @code-review…
────────────────────────────────────────────────────────────────────────────────────────
```

### 6.1 Prompt
- `>` accent bold at col 0, text at col 2. cwd and branch live in the header/status, not the prompt.
- Placeholder (fg.dim), chosen once per session from: `Message Klyro…`, `Message @file to attach…`, `Type / for commands…`, `! runs a shell command…`, `Message @{agent}…` (when custom agents exist). Never changes while typing.

### 6.2 Multiline
- `Shift+Enter` (Windows Terminal, Kitty, iTerm2, WezTerm, VS Code via `/terminal-setup`), trailing `\`, or bracketed paste with newlines.
- Continuation rows indent 2, no glyph. Input grows to `rows/3`, then scrolls internally.
- Pastes ≥ 10 lines fold to `[pasted 50 lines]` (fg.dim); full text is sent. `Ctrl+G` opens `$EDITOR` to view/edit.

### 6.3 `/` completion popup (§16.1 frame)
```
  /commit        create a commit from current changes
  /compact       summarize conversation to free context
  /config        view or change settings
  /context       show what is using the context window
  /cost          show session usage and cost
  ↑↓ move · tab/enter select · esc close                                  5 of 31
```
Prefix, then fuzzy. Custom commands show namespace (`/project:deploy`); MCP prompts `/mcp:github:summarize-pr`.

### 6.4 `@` finder
```
  src/auth/login.ts                                                        2m ago
  src/auth/login.test.ts
  src/auth/session.ts
  src/auth/                                                                   dir
  @code-review                                                              agent
  ↑↓ move · tab attach · enter reference · esc close                  5 of 1,204
```
Git-tracked + `.klyroignore`-filtered; recent files first. `Tab` attaches contents; `Enter` inserts a reference. Kinds in the right column: `dir`, `agent`, `command`, `mcp resource`, `image`. Absolute paths and drag-drop paste are accepted literally.

### 6.5 `!` shell passthrough
`!cmd` runs immediately (no model), renders as a single `▸ Ran cmd` group under `> !cmd` with no `● Klyro` header, and attaches the output to the next message.

### 6.6 Queued input during streaming
```
> Message Klyro…
  queued: also add a test for the empty string case                    esc to drop
```
≤ 3 queued, fg.dim, sent in order after the turn. Input is disabled during approval / `ask_user` (the menu replaces it).

### 6.7 History
`↑/↓` on first/last row walks per-project history. `Ctrl+R` reverse search in the popup frame: `(reverse-i-search) 'vitest'`.

### 6.8 Echo mode
No provider configured → messages echo back under `● echo` with `no provider configured · /login or set ANTHROPIC_API_KEY`.

---

## 7. Status line

```
shift+tab to cycle  ·  ↑↓ for history  ·  ctrl+o expand                 $0.04 · 6% ctx · auto mode on ●
```

**Left** (fg.dim), ≤ 3 hints, state-driven:

| State | Hints |
|---|---|
| idle, empty | `shift+tab to cycle` · `↑↓ for history` · `/ for commands` |
| idle, typing | `enter to send` · `shift+enter newline` · `@ to attach` |
| streaming | `ctrl+c to stop` · `enter to queue` · `ctrl+o expand` |
| tools running | `esc to cancel` · `ctrl+o expand` · `ctrl+b background` (shell) |
| task loop | `ctrl+c to steer` · `ctrl+o expand` · `/todos` |
| paused (steer) | `enter to resume` · `esc to stop task` |
| compacting | `compacting context…` |
| approval / picker | (empty — hints move into the component) |

**Right**: `{cost} · {ctx} · {jobs} · {mode}`, fg.dim except mode glyph.
- `cost` `$0.043`, hidden until > 0.
- `ctx` `12.4k ctx · 6%` (W ≥ 90) or `6% ctx`; percentage `warn` at 60–84 %, `err` ≥ 85 %.
- `jobs` `2 jobs`, `err` if any died.
- `mode` (§8): `auto mode on ●` (accent), `accept edits ◐`, `plan mode ○`; default shows nothing.
- Transient replacements: `retrying (2/5) · 4s` (warn); notifications (§18) for 4 s; L14 job progress `j_12 · 41% · eta 1h30m`.

Non-TTY: no status line.

---

## 8. Permission modes

`Shift+Tab` cycles `default → accept-edits → plan → default`. **auto** is flag/settings only (`--yolo`); cycling is disabled in auto with hint `auto set by flag`. Each change commits one notice:

```
  · mode: accept-edits — file edits run without asking; shell still prompts
```

| Mode | Status | Surfaced as |
|---|---|---|
| default | — | approval menu for non-allowed mutating tools |
| accept-edits | `accept edits ◐` | edits auto-approved |
| plan | `plan mode ○` | writes render `blocked · plan mode`; `/plan` gate available |
| auto | `auto mode on ●` | no approvals; denylist enforced |

---

## 9. Approval menu & `ask_user`

Rendered in the **pinned** area replacing the input; cursor hidden.

```
────────────────────────────────────────────────────────────────────────────────────────
  edit_file src/auth/login.ts                                                    +6 −1
  @@ -12,4 +12,9 @@
   export function slugify(input: string) {
  -  return input.toLowerCase().replace(/\s+/g, "-");
  +  return input
  +    .normalize("NFKD")
  …  (+4 more lines · e to view)

  Allow this edit?
  [y] once   [a] session   [A] always   [n] deny   [e] view   [?] why
────────────────────────────────────────────────────────────────────────────────────────
```

- Line 1: bold tool name + primary arg, right column counts.
- Preview ≤ 8 lines: diff / exact command / URL / MCP args as `key: value`.
- Question by class: `Allow this edit?` `Run this command?` `Fetch this URL?` `Allow github:create_issue?` `This repair changes test assertions. Allow?`
- Keys bold `fg`, labels fg.soft. `[A]` writes a rule and commits `· added permissions.allow: edit_file(src/**)`.
- `[n]` → `deny reason (optional, enter to skip):` on the input row; reason is sent to the model and shown in the expanded item (`denied · "use session.ts"`).
- `[?]` prints `why: path outside permissions.allow · mode default`.
- `Esc` = deny without reason.
- Parallel batch: `1 of 3` after the question; `[a]` applies to remaining identical tools in the batch.
- Hook decisions render as `· hook pre-tool-use: allowed by scripts/policy.sh` (no menu).
- Headless without `--auto-answer`: emit `permission.request`, exit 7.

`ask_user` uses the same frame:
```
  Which package manager should I use?
> pnpm  (detected lockfile)
  npm
  yarn
  other…
  ↑↓ move · enter select · esc cancel
```
Free-text questions show the question above a normal input row.

---

## 10. Streaming, interruption, Ctrl+C

| Event | Live | Committed |
|---|---|---|
| request sent | `  │   ⠋` on the prose row | — |
| thinking delta | `Thinking... 4s` | — |
| first text delta | spinner → text tail | head lines as completed |
| `Ctrl+C` while streaming | live cleared | `  │   [interrupted]` |
| `Esc` during tools | running lines → `cancelled` | `  │   [cancelled by user]` |
| provider retry | status right `retrying (2/5) · 4s` | — |
| provider error | — | error block (§17.1) |
| idle-stream timeout | — | `✗ stream idle 120s · retrying` then error |

Budgets: prompt usable ≤ 300 ms after `Ctrl+C`; process tree dead ≤ 1 s.

**`Ctrl+C` by state (single source of truth):**

| State | Ctrl+C |
|---|---|
| idle, empty input | hint `press ctrl+c again to exit`; second within 1.5 s → exit 0 |
| idle, text typed | clear input |
| streaming (no task loop) | abort stream |
| tools running (no task loop) | abort tools → `[cancelled by user]` |
| task loop running (L5+) | **pause + steer** (§11.4); second within 1.5 s aborts task |
| picker / menu | close (= Esc) |
| headless | exit 130, trace flushed |

---

## 11. Task loop (L5)

### 11.1 Phase rules
On `phase.changed`, one line at col 4:
```
  │   ── exploring ───────────────────────────────────────────────────────────────
```
`──` + phase word (fg.dim) + `─` to `W-2` (guide). Phases: `understanding exploring planning implementing verifying`. Terminal phases render as completion lines (§11.5).

### 11.2 Plan checklist (`todo_write`)
Live block; updates in place; commits once when the task ends.
```
  │   ◇ Plan                                                                    3/5
  │   ✓ Read failing test and locate login handler
  │   ✓ Reproduce failure locally
  │   ● Fix token expiry comparison in session.ts
  │   ○ Run auth test suite
  │   ○ Update CHANGELOG
```
`◇ Plan` bold; `✓` ok, `●` accent (exactly one), `○` fg.dim; done items fg.dim. ≤ 8 visible, then `… +3 more (/todos)`.

### 11.3 Plan mode gate
Plan renders as markdown, then:
```
  Approve this plan?
  [y] implement   [e] edit in $EDITOR   [n] revise   [s] save only
```
Saved to `.klyro/plans/{ts}-{slug}.md` → `· plan saved: .klyro/plans/…`.

### 11.4 Activity block & steering
When a phase has produced > 2 groups, the live tail collapses to a 4-row activity block:
```
  │   ⠋ implementing  ·  turn 14  ·  $0.62  ·  2m41s
  │   ▸ Edited 2 files                                                     +9 −3
  │   ▸ Ran npx vitest run src/auth                                          3.2s
  │   ⠋ Reading src/auth/session.test.ts
```
Row 1 fg.dim (spinner `fg`); rows 2–4 the last three verb lines.

**Steer** (first `Ctrl+C` during a task):
```
────────────────────────────────────────────────────────────────────────────────────────
  paused after read_file src/auth/session.test.ts  ·  turn 14
> steer: focus on the expiry bug only, skip CHANGELOG
────────────────────────────────────────────────────────────────────────────────────────
enter to resume with instruction  ·  enter (empty) to resume  ·  esc to stop task
```
Commits `  · steer: focus on the expiry bug only…` (fg.dim).

### 11.5 Stuck, limits, completion
```
  │   ! same edit to src/auth/session.ts 8 times · consider a different approach
```
Limits:
```
  │   ✗ stopped: cost limit $2.00 reached (spent $2.01)
  │
  │   Summary so far: … (≤ 10 lines)
  │   ✎ 2 files (+18 −4) · verification not run
```
Exit 7 in headless. At ≥ 80 % of a limit the status right shows `$1.62 / $2.00` (warn).

Completion lines (replace the phase rule):
```
  │   ✓ done  ·  14 turns  ·  $0.71  ·  3m12s
  │   ! blocked  ·  needs: DATABASE_URL to run integration tests
```

---

## 12. Verification (L6)

Live during `verifying`; committed at phase end.
```
  │   verify
  │   ✓ typecheck                                                              1.2s
  │   ✗ tests                                                        3 failed · 4.8s
  │       src/auth/session.test.ts:41  expected 401, received 200
  │       src/auth/session.test.ts:57  expected token to be expired
  │       src/auth/login.test.ts:12    …
  │   ↻ repair 1/3
```
- Verifier names `fg`; skipped: `· lint   skipped (not configured)`.
- ≤ 3 failures `file:line  message`, then `… +4 more`.
- Badges: `pre-existing`, `flaky · rerun`, `env`.
- `↻ repair n/m` (warn); repair edits follow as groups. Guarded repairs open the approval gate.
- First run: `· baseline: 2 tests already failing at HEAD (ignored)`.
- Completion contract: `· verification required before finishing · running verify`; with `--require-verify`, `✗ done without passing verification`, exit 8.
- `/verify` renders the panel without a `● Klyro` header.

---

## 13. Context (L8)

### 13.1 `/context`
```
  context  61%  ▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱  122.4k / 200k        compact at 80% ▏
                                                            reserve 16k output

  system prompt                                          4.2k    2%
  tools                                                  6.8k    3%
  project map + KLYRO.md                                 1.9k    1%
  summary (2 compactions)                                3.1k    2%
  messages                                              98.7k   49%
    largest  read_file src/generated/schema.ts (t12)    14.2k
             shell npm test (t31)                        9.8k
             expand_result r_9c1 (t40)                   6.1k
  reminders / notes                                      1.1k    1%
  reserved for output                                   16.0k    8%
```
20-cell bar: filled `fg.soft`, `warn` past 60 %, `err` past 85 %; empty `guide`.

### 13.2 Compaction
Status left `compacting context…`; on completion:
```
  · compacted  ·  98.7k → 31.2k tokens  ·  kept last 12 messages  ·  summary mentions 7 files
```
Fallback: `· compacted (elision only) · summary rejected: missing src/auth/session.ts`.

### 13.3 Cached / stored results
`└ package.json   unchanged since turn 3`; footer `[stored r_8f2a]`. Reminders and memory injections are trace-only (`--debug` shows them).

---

## 14. Sessions (L9)

### 14.1 Picker (`-r`, `/resume`, `/sessions`)
```
  sessions  ·  ~/code/klyro

> jest → vitest migration                 12 turns   $0.84    main        2h ago
  add slugify utility                      6 turns   $0.21    main        yesterday
  investigate flaky auth test             41 turns   $2.10    fix/auth    3d ago
  (untitled)                               1 turn    $0.00    main        5d ago

  ↑↓ move · enter resume · f fork · d delete · / filter · esc              4 of 27
```

### 14.2 Resume banner (header row 4 + notices)
```
  · 3 files changed since this session: src/auth/session.ts  package.json  … (/diff)
  · background job j_2 (npm run dev) was running · now marked dead
  · last tool call read_file was interrupted · marked [interrupted]
```
In-progress todos → gate `Continue "Fix token expiry"? [Y/n]`.

### 14.3 Lock
```
  ! session is active in another terminal (pid 41022)
  [r] read-only   [f] fork   [q] quit
```

---

## 15. Agents & parallel runs (L10–L14)

### 15.1 Sub-agent line (inside a group)
Running:
```
  │   ⠋ Delegating to explorer  ·  "map the auth module"                       42s
  │       ▸ Read 14 files · Searched 3 patterns                              $0.04
```
Done, collapsed:
```
  │   ▸ Delegated to explorer  ·  "map the auth module"        $0.04 · 18 tools · 51s
  │       6 files, entry src/auth/index.ts, tests in src/auth/__tests__
```
Second row = first line of the structured report (fg.soft). Expanded (`Ctrl+O`): the child's own transcript nested 4 cells with its guide, its groups collapsed by default, then the full report as `key: value` lines.

### 15.2 Agent tree (`/agents` during a run; live for L11–12)
```
  │   run r_7b1  ·  4 agents  ·  $0.91  ·  3m02s
  │   ├─ ✓ explorer      map auth module                       $0.04   51s
  │   ├─ ● implementer   add refresh token flow                 $0.62   2m10s   wt/impl-1
  │   │    ▸ Edited src/auth/refresh.ts                                    +48
  │   ├─ ● tester        write refresh token tests              $0.19   1m40s   wt/test-1
  │   └─ ○ reviewer      waiting on implementer, tester
```
Glyphs `✓ ● ○ ✗ !`; role bold, brief fg.soft, cost/elapsed/workspace fg.dim; running agents show their latest verb line one level deeper.

### 15.3 DAG (`--plan-only`, `/workflow`)
```
  workflow  explore→implement→verify  ·  because: class medium · 6 files touched

  1  explore    auth module           reads src/auth/**            haiku    ≤ $0.10
  2  implement  refresh flow          writes src/auth/refresh.ts   opus     ≤ $1.00   after 1
  3  test       refresh tests         writes src/auth/*.test.ts    sonnet   ≤ $0.40   after 1
  4  verify     full suite            —                            —        —         after 2,3
  5  review     diff > 300 lines      reads *                      opus     ≤ $0.30   after 4
```
Adaptations commit as `· workflow: added reviewer (diff 412 lines > 300)`.

### 15.4 Merge (12.5)
```
  │   merge  wt/impl-1 + wt/test-1 → klyro/r_7b1/integration
  │   ✓ src/auth/refresh.ts
  │   ✓ src/auth/refresh.test.ts
  │   ✗ src/auth/index.ts                                              conflict · merger
  │   ▸ Delegated to merger  ·  "resolve index.ts exports"                $0.08 · 22s
  │   ✓ verify on integration  ·  tests 1.9s  ·  typecheck 1.1s
```
Unresolved → gate `Resolve conflict in src/auth/index.ts? [e] $EDITOR  [t] theirs  [o] ours  [s] stop`.

### 15.5 Jobs (L14)
```
  jobs

> j_12  ● running   migrate REST→gRPC (phase 2/5)     turn 214   $8.40   1h12m   ckpt 5m ago
  j_11  ○ queued    update deps                        —          —       —
  j_9   ! input     add billing webhooks               turn 88    $3.10   paused  needs answer
  j_8   ✓ done      fix flaky auth test                turn 31    $1.02   22m

  ↑↓ move · enter attach · a answer · p pause · c cancel · l logs · esc
```
Attach shows `· attached to job j_12 · ctrl+d to detach` in header row 4.

---

## 16. Pickers, panels, viewers

### 16.1 Popup frame
Optional title (fg.dim) · rows · footer hints (fg.dim) with `{n} of {total}` right-aligned. Lives in the live window above the input rule. Selected row `>` at col 0 + `accent`. Filter-as-you-type. `Esc` closes. No borders.

### 16.2 `/model`
```
  model  ·  current: sonnet

> sonnet   claude-sonnet-4-5          200k    $3 / $15    thinking · vision
  opus     claude-opus-4-1            200k    $15 / $75   thinking · vision
  haiku    claude-haiku-4-5           200k    $1 / $5     vision
  gpt      gpt-5                      400k    $2 / $10    reasoning · vision
  local    qwen2.5-coder:32b (ollama)  32k    free        —

  ↑↓ move · enter select · r set role… · esc                                5 of 5
```
`r` → roles `main small explorer reviewer` (L15).

### 16.3 `/permissions`
```
  permissions  ·  mode: default

  allow   read_file  grep  glob  list_dir  git_*            built-in
  allow   edit_file(src/**)                                  settings.local.json
  ask     shell                                              default
  deny    write_file(.env*)  read_file(.env*)                settings.json
  dirs    ~/code/klyro  /tmp/klyro-*                         cwd · --add-dir

  e edit settings · a add rule · d remove · esc
```

### 16.4 `/mcp` `/hooks` `/agents` (list) `/lsp`
`name · status · detail · source` rows in the popup frame:
```
  mcp servers

  github        ✓ connected   12 tools · 3 prompts · oauth        project
  filesystem    ✓ connected   6 tools                              user
  postgres      ✗ error       connection refused · retry 8s        project
  klyro-server  · disabled                                         local

  ↑↓ move · enter tools · t test · r reconnect · esc
```

### 16.5 `/cost`
```
  cost  ·  session 2h14m

  turns                      41
  input tokens           412.8k   $1.24
  cache read             318.1k   $0.10    77% of input
  cache write             41.2k   $0.15
  output tokens           38.4k   $0.58
  total                            $2.07

  by model     sonnet $1.81 · haiku $0.26
  by agent     main $1.62 · explorer $0.26 · reviewer $0.19
  ttft p50 / p95          640ms / 2.1s
```

### 16.6 `/status`
`label   value` lines: version, model, provider/auth, mode, sandbox, network, session id, cwd/branch, MCP count, hooks, jobs, daemon, managed-settings source, update status.

### 16.7 Print panels
`/todos` `/plan` `/memory` `/project` `/workflow` `/context` `/verify` print to scrollback in their component formats.

### 16.8 `/diff` list
```
  changes since checkpoint 0  ·  3 files  +41 −7

> M src/utils/slug.ts                    +6  −1
  A src/utils/slug.test.ts              +33  −0
  M README.md                            +2  −6

  ↑↓ move · enter view · u undo file · U undo all · esc                     3 of 3
```

### 16.9 Full-screen diff viewer
Claims the live window up to `rows − 6`. Header: path · `+a −d` · `{hunk}/{total}`. Body: unified diff with `diff.*.bg` backgrounds and fg.dim line-number gutter. Footer: `j/k scroll · n/p hunk · ] next file · u undo · e $EDITOR · q close`. Never uses the alternate screen.

### 16.10 `/undo`, `/rewind` (`Esc Esc`)
```
  rewind to

> turn 14   Edited src/auth/session.ts                 2 min ago
  turn 12   Ran npx vitest run                          4 min ago
  turn 9    Edited src/auth/login.ts                    7 min ago
  turn 0    session start                              22 min ago

  ↑↓ move · enter rewind files + conversation · f files only · esc
```
Commits `── rewound to turn 12 · 2 files restored ─────`. `/undo` commits `· undone: src/utils/slug.ts (restored to turn 12)`.

### 16.11 `/expand`
```
  expand

> g14   Read 6 files · Searched 2 patterns              turn 7    41ms     2m ago
  g13   Listed A:\claude code\Agent · Read package.json turn 7    36ms     2m ago
  g12   Ran npm test                                    turn 5    4.1s     6m ago

  ↑↓ move · enter print expanded · esc                                     3 of 14
```

### 16.12 `/init` `/commit` `/pr` `/review`
Model-driven turns. `/commit` ends with a gate showing message + `--stat`: `[y] commit  [e] edit  [n] cancel`. `/pr` shows title/body then `[y] create  [e] edit  [n] cancel`. Secret hit: `✗ commit blocked: possible secret in .env.example:3 (AWS key)`.

### 16.13 One-line confirmations
`· exported: ./klyro-session-2025-01-14.md` · `· copied last response (1,204 chars)` · `· forked → session s_91` · `· renamed: "auth refresh flow"`.

---

## 17. Errors, warnings, notices

### 17.1 Recoverable error (inside a turn)
```
  │   ✗ provider error: 529 overloaded after 5 retries
  │     hint: try again shortly, or /model haiku
  │     run with --debug for details
```

### 17.2 Fatal (stderr, process exits)
```
✖ config invalid: .klyro/settings.json → permissions.allow[2]
  expected: string matching tool or tool(glob)
  received: 42
  fix: quote the rule, e.g. "shell(npm *)"
  exit 3
```
`--json`: `{"type":"error","code":"CONFIG_INVALID","exitCode":3,…}` only. No stack traces without `--debug`.

### 17.3 Warnings
`! text` (warn glyph, fg.dim text) where they occur: mintty raw-mode fallback, file changed on disk, model lacks vision, flaky test, approaching limit, dead job.

### 17.4 Notices
`· text` (guide dot, fg.dim): mode change, compaction, plan saved, hook fired (`hooks.verbose`), routing (`· routed to haiku · class trivial · 0.91`), workflow adaptation, policy applied.

### 17.5 `klyro doctor`
```
klyro doctor

✓ node 22.3.0 (>= 20)
✓ pnpm 9.1.0
✓ ~/.klyro writable
✓ config valid  (3 files · 1 local override)
✗ ripgrep not found
    fix: brew install ripgrep  ·  grep falls back to slower built-in search
! terminal: mintty  ·  raw mode unavailable  ·  use Windows Terminal for full UI
✓ git 2.45.1  ·  repo detected  ·  branch main
✓ provider anthropic  ·  key from env  ·  reachable (412ms)
· proxy: none
· unicode: yes  ·  truecolor: yes  ·  hyperlinks: yes  ·  mouse: available

2 issues · exit 1
```

### 17.6 First run
```
KLYRO  v0.1.14

Created ~/.klyro

Klyro can send anonymous usage statistics (command names, error codes — never code or prompts).
Enable telemetry?  [y] yes  [N] no

· telemetry off  ·  klyro config set telemetry true to change
· next: klyro login  or  export ANTHROPIC_API_KEY=…
```

### 17.7 Update notice
Header row 4 only, once per 24 h; never interrupts input.

---

## 18. Notifications

| Channel | Behavior |
|---|---|
| Status flash | right block shows `● needs your input` (accent) / `✓ task done` for 4 s |
| Bell | `\a` once if `notifications.bell` |
| OS | `osascript` / `notify-send` / PowerShell toast if `notifications.os`; body ≤ 80 chars, never code |
| Title bar | OSC 0/2 `klyro · {status} · {project}`; restored on exit; off in tmux unless `set-titles on` |

Notifications never write to scrollback.

---

## 19. Degradation

### 19.1 Non-TTY (piped, CI, `-p` without `--json`)
No header, status, live window, spinners, or color (unless `FORCE_COLOR`). Groups print **collapsed, once, on completion** with inline meta: `▸ Read 3 files (41ms)`; failures print expanded. Long tools log `… Running npm test 20s` every 10 s. Final answer printed last, unadorned. `--verbose` prints groups expanded.

### 19.2 `--json` / `stream-json`
Zero decoration; one `KlyroEvent` per line + final `result`. Byte-equal to the trace file (3.1 exit). `--output-format json` = final result only. Errors → single `error` event on stdout.

### 19.3 `NO_COLOR` / `TERM=dumb` / `--no-color`
`mono` theme; structure via glyphs (ASCII under `TERM=dumb`); selection by `>` only.

### 19.4 Linear mode (W < 60, `--linear`, mintty fallback)
No live window: every event commits immediately. Groups still collapse per verb (one line each, meta inline); expansion via `/expand` only. Guides replaced by indentation. Approval menus print as questions with a `[y/a/A/n/e/?]` prompt; pickers become numbered lists with `choose 1-N:`.

### 19.5 Platform matrix

| Terminal | Notes |
|---|---|
| Windows Terminal | Full UI; ConPTY resize; `Shift+Enter`; mouse available |
| conhost (PowerShell / cmd) | Full UI; Unicode fallback unless code page 65001; no hyperlinks |
| Git Bash / mintty | Raw mode may fail → linear mode + warning; bracketed paste if enabled |
| VS Code terminal | Full UI; `Shift+Enter` via `/terminal-setup` |
| tmux / screen | Full UI; `liveRows` 12; titles off unless enabled; mouse only if `mouse on` |
| iTerm2 / Kitty / WezTerm / Alacritty / GNOME | Full UI |
| SSH | Host terminal rules; OS notifications off |

Renderer audit (10.4) runs the reference session through each profile as snapshots.

---

## 20. Keyboard & mouse

### 20.1 Keyboard (complete; additions land here first)

| Key | Context | Action |
|---|---|---|
| `Enter` | input | send / queue while streaming |
| `Shift+Enter`, `\`+`Enter` | input | newline |
| `Tab` | `/` or `@` popup | accept / attach |
| `Shift+Tab` | non-modal | cycle permission mode |
| `↑ ↓` | input edge rows / popups | history / move |
| `← → Home End Alt+←/→ Ctrl+A/E` | input | cursor |
| `Ctrl+W/U/K` | input | delete word / to start / to end |
| `Ctrl+R` | input | reverse history search |
| `Ctrl+L` | any | clear screen, reprint header (conversation kept) |
| `Ctrl+C` | see §10 | interrupt / steer / clear / exit |
| `Ctrl+D` | empty input | exit; attached job → detach |
| `Esc` | popup / menu | close / deny / cancel |
| `Esc` | tools running | cancel tools |
| `Esc Esc` | idle | rewind picker |
| `Ctrl+O` | any | toggle most recent group; twice = all groups + session default |
| `Ctrl+B` | shell running | move to background |
| `Ctrl+G` | input | edit input in `$EDITOR` |
| `Ctrl+V` / `Cmd+V` | input | paste (image detection) |
| `Ctrl+Z` | POSIX | suspend; `fg` restores UI |
| `y a A n e ?` | approval | per §9 |
| `j k n p ] u e q` | diff viewer | per §16.9 |
| `/` | popup | filter |
| `Esc` / `i` / `:` | vim mode (10.4) | normal / insert / command; `/help vim` |

`/help keys` prints this table.

### 20.2 Mouse (`ui.mouse`, default `false`)
Off by default because SGR mouse tracking breaks native text selection. When on:
- click a `▸`/`▾` line → toggle that group (live window only; committed lines print a `/expand g{n}` hint in the status line for 4 s);
- click a picker row → select; double-click → confirm;
- wheel → scroll diff viewer / pickers; elsewhere passes to the terminal;
- `Shift`+drag → native selection (terminal handles it).

`/mouse on|off` toggles per session. Auto-disabled in tmux without `mouse on`.

---

## 21. Event → component mapping

| Event | Effect |
|---|---|
| `session.start` / `session.resume` | header / header + resume banner |
| `user.message` | user turn |
| `assistant.start` | `● Klyro` row |
| `assistant.thinking.delta` | thinking line |
| `assistant.text.delta` | prose (closes the open group) |
| `assistant.end` | end-of-turn summary; commit turn |
| `assistant.interrupted` | `[interrupted]` |
| `tool.call` | open/extend group; running verb line |
| `tool.output.delta` | shell last line |
| `tool.result` | verb line update; item in expanded view; auto-expand on error |
| `tool.cancelled` | `cancelled`; `[cancelled by user]` |
| `tool.truncated` / `tool.stored` | item footers |
| `permission.request` / `.decision` / `.rule.added` | approval menu / item status / notice |
| `permission.mode.changed` | status + notice |
| `ask_user.request` / `.answer` | question gate |
| `provider.retry` / `provider.error` | status `retrying` / error block |
| `usage` | status cost/ctx; `/cost` |
| `phase.changed` | phase rule; activity block |
| `todo.updated` | plan checklist |
| `plan.created` / `plan.approved` | plan gate |
| `agent.stuck` / `agent.steer` | `!` line / steer prompt + notice |
| `limit.reached` | stopped block |
| `task.done` / `task.blocked` | completion line |
| `verify.start` / `verify.result` / `repair.attempt` | verification panel |
| `context.usage` / `.compacting` / `.compacted` / `.reminder` | ctx meter / status hint / notice / none |
| `checkpoint.created` / `.restored` | none / `── rewound` rule |
| `subagent.start` / `.delta` / `.end` | delegation line + nested transcript |
| `run.planned` / `run.node.*` / `run.merge.*` | DAG / agent tree / merge panel |
| `workflow.planned` / `.adapted` | `/workflow` / notice |
| `job.*` | `/jobs`; status jobs/progress |
| `hook.fired` / `hook.blocked` | notice / blocked item |
| `mcp.status` | `/mcp`; header row 4 on error |
| `route.decision` | notice (L15) |
| `policy.applied` / `policy.guard` | notice / `!` warning (L17) |
| `experience.injected` | none (trace) |
| `notification` | §18 |
| `error` (fatal) | fatal block, exit |

---

## 22. Component inventory by sub-level

| Sub-level | Ships |
|---|---|
| 1.2 | `--help` layout (usage / commands / flags, dim descriptions); "did you mean" |
| 1.4 | input line (§6.1–6.2, 6.7, 6.8), `/` popup, `Ctrl+C` idle rows, `Ctrl+L`, header rows 1–3 |
| 1.5 | markdown (§5.8), spinner, status skeleton, error/fatal/warning (§17.1–17.3), doctor, first run, `NO_COLOR`/dumb |
| 2.1–2.2 | header row 2, `/model`, retry status |
| 2.3 | attachments, image badges |
| 2.4 | assistant turn, thinking, streaming states, queued input, `/copy /export` |
| 2.5 | status cost/ctx, `/cost`, non-TTY + JSON rules |
| 3.1 | event mapping enforced; `--json` parity |
| 3.2 | **activity groups** (§5.3) for `Read`/`Created`/`Edited`, expanded cards (§5.4), `Ctrl+O`, `/expand`, `ui.tools` |
| 3.3 | `Ran`/`Started` verbs, shell live line, blocked state, `Ctrl+B` |
| 3.4 | approval menu, modes + `Shift+Tab`, `/permissions` |
| 3.5 | parallel batches within groups, cancellation, inline diffs (§5.3.3), `ui.showDiffs` |
| 4.1–4.2 | edit failure item format, EOL badge |
| 4.3 | `Listed`/`Searched`/`Checked git` verbs, background jobs, `/jobs` v1 |
| 4.4 | `@` finder, `!` passthrough, `/init /memory` |
| 4.5 | rendering model (§3), end-of-turn summary, `/diff` list + viewer, `/undo /rewind`, breakpoints, platform matrix, mouse option |
| 5.1 | phase rules, limit block |
| 5.2 | stuck warning, steer |
| 5.3 | plan checklist, plan gate, `ask_user` |
| 5.5 | activity block, completion lines |
| 6.x | verification panel, repair rows, guard gate, `/verify` |
| 7.x | analysis verbs (`Mapped`, `Traced`, `Found symbol`), `/project`, `/lsp` |
| 8.x | ctx meter, `/context`, compaction notice, unchanged-read item, `Expanded` verb |
| 9.x | sessions picker, resume banner, lock, `/fork /rename` |
| 10.1 | `Called` verb, `/mcp`, header MCP errors |
| 10.2 | `/hooks`, hook notices, command namespaces, `Delegated` line + nested transcript, `/agents` |
| 10.3 | `Fetched`/`Searched web` verbs, `/commit /pr /review` gates, secret block |
| 10.4 | full keyboard + mouse model, themes, vim, notifications, `/status`, renderer audit, Ink-vs-custom decision |
| 11.x | agent tree, report rendering, scope-denied items |
| 12.x | DAG, worktree column, merge panel, artifact verbs |
| 13.x | sandbox/network header notice, sandbox-blocked status, `klyro audit` tables |
| 14.x | `/jobs` full, attach/detach, progress in status |
| 15.x | `/model` roles, routing notices, `klyro stats` |
| 16.x | `/workflow`, adaptation notices |
| 17.x | policy guard warnings, `klyro optimize review` list (`[a] apply [s] skip`) |
| 18.x | `klyro experience` list, promotion confirmation |
| 19.x | none in REPL (CI bot output is markdown) |
| 20.x | `--remote` header note, dashboard-approval notice |

---

## 23. Budgets

| Budget | Value | Test |
|---|---|---|
| First paint (header + input) | ≤ 80 ms | e2e timer |
| Key echo | ≤ 16 ms | synthetic keypress |
| Token → screen | ≤ 100 ms incl. markdown hold-back | mock provider |
| Group line update (count/duration) | ≤ 1 repaint per frame | frame snapshot |
| Repaint scope | live + pinned only, ≤ 30 fps | 1k-line stream test |
| `Ctrl+O` toggle → repaint | ≤ 50 ms for a 200-item group | fixture |
| Abort → usable prompt | ≤ 300 ms | e2e |
| `@` finder open, 50k files | ≤ 150 ms (prebuilt index) | fixture repo |
| Renderer memory | O(live window); scrollback not retained | heap snapshot |
| Screen reader | `--linear --ascii --no-color` yields sequential text; no color-only meaning | manual + snapshot |
| Contrast | `fg.dim` ≥ 4.5:1 on near-black; light theme verified | table review |

---

## 24. Don'ts

- No boxes, frames, double rules, banners, or emoji.
- No colored backgrounds outside the diff viewer.
- No accent on anything that isn't Klyro's voice or the current selection.
- No alternate screen buffer; no redraw of committed scrollback.
- No raw tool logs by default — groups collapse; failures are the only auto-expansion.
- No progress bars except the context meter in `/context`.
- No `…` truncation unless the component says so; wrap by default.
- No `process.stdout.write` outside `cli/ui` (lint rule from 3.1).
- No UI-only state: if it's not in the event stream, it's not on screen.
- No mouse tracking unless the user opts in.

---

## Appendix — Reference session (snapshot fixture `ui/reference.txt`)

```
KLYRO  v0.1.14                                       │  /help   /config   /clear   /exit
sonnet[200k]  ·  anthropic env key
~/code/klyro  ·  main

> add a slugify helper with tests

  │ ● Klyro
  │   Thinking...
  │
  │   ── exploring ───────────────────────────────────────────────────────────────
  │   ▸ Searched "export function" src/utils                                   31ms
  │   ▸ Read src/utils/index.ts                                                 9ms
  │
  │   ── implementing ────────────────────────────────────────────────────────────
  │   ◇ Plan                                                                    3/3
  │   ✓ Create src/utils/slug.ts
  │   ✓ Add src/utils/slug.test.ts
  │   ✓ Export from index and run tests
  │
  │   ▸ Created 2 files                                                    +51 · 8ms
  │   ▾ Edited src/utils/index.ts                                        +1 −0 · 6ms
  │       @@ -20,3 +20,4 @@
  │        export * from "./format";
  │       +export * from "./slug";
  │
  │   ── verifying ───────────────────────────────────────────────────────────────
  │   verify
  │   ✓ typecheck                                                              1.1s
  │   ✓ tests  src/utils                                          6 passed · 0.9s
  │
  │   Added `slugify(input)` in src/utils/slug.ts with NFKD normalization,
  │   exported from the utils index, and covered by six tests including
  │   unicode and empty input.
  │
  │   ✎ 3 files (+52 −0)  ·  src/utils/slug.ts  src/utils/slug.test.ts  src/utils/index.ts
  │   ✓ done  ·  7 turns  ·  $0.09  ·  48s

────────────────────────────────────────────────────────────────────────────────────────
> Message Klyro…
────────────────────────────────────────────────────────────────────────────────────────
shift+tab to cycle  ·  ↑↓ for history  ·  ctrl+o expand                $0.09 · 9% ctx
```