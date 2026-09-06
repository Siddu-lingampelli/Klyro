# Terminal UI Design — Claude Code-like TUI

> **Theme:** White background, Klyro Orange (#FF6B1A) accents. Dark mode mirrors with deep gray + same orange.
> **Stack suggestion:** Rust + Ratatui (or Go + Bubble Tea). React/Ink works too.
> **Goal:** Faithful Claude Code terminal experience — file explorer, sessions, sub-agents, chat scroll, expand/collapse, command palette.

---

## 1. High-Level Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▌ claude-code │ main │ ◉ 3 sessions │ ⌘ palette  │ ? help   │ ●●● ●●  │ ⊞ ▢│ ← TOP BAR
├────────────┬─────────────────────────────────────────────┬──────────────────┤
│            │                                             │                  │
│  SIDEBAR   │             CHAT / WORKSPACE                │   INSPECTOR      │
│  (left)    │             (center)                        │   (right)        │
│            │                                             │                  │
│  Sessions  │  · scrollable messages                      │  · tool calls    │
│  Files     │  · tool output                             │  · diff viewer   │
│  Agents    │  · code blocks w/ expand                    │  · agent tree    │
│  MCP       │  · thinking blocks (collapsible)            │  · file preview  │
│  Hooks     │                                             │                  │
│            │                                             │                  │
├────────────┴─────────────────────────────────────────────┴──────────────────┤
│ > Type a message…                                          ⏎ send  ⇧⏎ newline │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Three columns, full terminal height, bottom prompt bar.**

Column widths:
- Sidebar: 28 cols (collapsible to 0)
- Inspector: 36 cols (collapsible)
- Center: flex

Toggle keys: `⌘B` sidebar, `⌘I` inspector.

---

## 2. Color Tokens

### Light mode (default — white & orange)

```
--bg            #FFFFFF       panel
--bg-elevated   #FAF7F2       slightly warm cream
--bg-subtle     #F5F0E8       hover, selected row
--fg            #1A1A1A       primary text
--fg-muted      #6B6B6B       secondary
--fg-dim        #9A9A9A       tertiary, hints

--orange        #FF6B1A       brand primary, accents, focus rings
--orange-hot    #FF8A3D       hover state
--orange-deep   #CC4F0A       pressed
--orange-soft   #FFF1E6       selection bg, badges

--border        #E8E0D2       panel dividers
--border-strong #1A1A1A       active panel

--success       #2E7D32        green check
--warning       #C77700        amber
--danger        #C62828        red
--info          #FF6B1A        same as brand

--code-bg       #FAF7F2        inline code, code blocks
--code-border   #E8E0D2
```

### Dark mode (mirror)

```
--bg            #1A1A1A
--bg-elevated   #232323
--bg-subtle     #2C2C2C
--fg            #F5F5F5
--fg-muted      #A0A0A0
--fg-dim        #707070

--orange        #FF8A3D       (lifted for contrast)
--orange-hot    #FFA566
--orange-deep   #E07020
--orange-soft   #3A2418       (soft on dark)

--border        #333333
--border-strong #FF8A3D

--code-bg       #1F1F1F
--code-border   #333333
```

**Convention:** Orange is the only saturated color in the chrome. Status colors (green/red/amber) appear only inside content. This keeps the brand loud but content readable.

---

## 3. Top Bar

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▌ claude-code │ main │ ◉ 3 sessions │ ⌘ palette  │ ? help   │ ●●● ●●  │ ⊞ ▢│
└──────────────────────────────────────────────────────────────────────────────┘
```

Elements left → right:

| Element | Width | Content |
|---|---|---|
| Logo | 12 | `▌ claude-code` (orange bar + dim text) |
| Branch | auto | `│ main │` — git branch, dim |
| Session count | auto | `│ ◉ 3 sessions │` — orange dot if active |
| Palette hint | auto | `│ ⌘ palette` |
| Help hint | auto | `│ ? help` |
| Model status | flex | `●●● ●●` — dots showing context window fill (orange → filled, dim → empty) |
| Layout toggles | 6 | `⊞ ▢` — current layout mode |

**Context dots:** Split the context window into 5 segments. Each dot fills with orange as the segment fills. Last dot pulses when >90%.

---

## 4. Left Sidebar — Navigator

```
┌────────────┐
│ ▾ Sessions │  ← collapsible header
│   ◉ Build… │
│   ○ Refac… │
│   ○ Fix b… │
│            │
│ ▸ Files    │  ← collapsed
│ ▸ Agents   │
│ ▸ MCP      │
│ ▸ Hooks    │
│            │
│ [+ new]    │  ← orange action
└────────────┘
```

### 4.1 Sessions panel

Each row:
```
◉ Build auth flow     2m  ← active session (orange dot)
○ Refactor parser    12m
○ Fix bug #42        1h
```

- `◉` orange filled = active
- `○` dim outline = paused
- Hover: bg-subtle
- Selected: orange-soft bg + orange left border 2px
- Right-aligned timestamp, dim

### 4.2 Files panel

```
▾ Files
  📁 src/
    📄 main.rs     1.2k
    📄 lib.rs      890
  📁 tests/
  📄 Cargo.toml
  ─────────────
  📄 README.md
```

- File tree, indent 2 per level
- `▾` / `▸` for expand
- File icon (📄📁) dim
- File size right-aligned, fg-dim
- Modified files: orange dot to the right
- `Enter` to open in inspector
- `Space` to expand/collapse

### 4.3 Agents panel (sub-agents)

```
▾ Agents
  ◉ main           running
  ├ ◉ explorer     done     1.2s
  ├ ◯ researcher   waiting
  └ ◯ verifier     idle
```

- Tree showing the agent hierarchy
- Status badges: `running` (orange pulse), `done` (green), `waiting` (amber), `idle` (dim), `error` (red)
- Click an agent to see its messages in the inspector

### 4.4 MCP / Hooks panels

Simple lists with connection status dots.

---

## 5. Center — Chat / Workspace

```
┌─────────────────────────────────────────────┐
│                                             │
│  ╭─ You ─────────────────────────────────╮ │
│  │ Add a /health endpoint that returns   │ │
│  │ JSON status                            │ │
│  ╰────────────────────────────────────────╯ │
│                                             │
│  ╭─ Claude ─────────────────── ◯ thinking ╮ │
│  │                                          │ │
│  │ I'll create the endpoint and register   │ │
│  │ it in the router.                        │ │
│  │                                          │ │
│  │ ▾ Tool call: edit_file                  │ │
│  │   src/routes.rs                         │ │
│  │   + 12 / - 3                            │ │
│  │   [expand ▾]                            │ │
│  │                                          │ │
│  │ ▾ Done (1.2s)                          │ │
│  ╰──────────────────────────────────────────╯ │
│                                             │
│  ╭─ You ──────────────────── resume ──╮    │
│  │ Continue.                              │    │
│  ╰─────────────────────────────────────────╯ │
│                                             │
└─────────────────────────────────────────────┘
```

### 5.1 Message bubbles

Two roles, distinct but minimal:

**User bubble:**
- Right-aligned or full-width? **Full-width** (easier to read in terminal)
- Border: 1px solid `--border`, no fill
- Header: `You` in fg-muted, 11px
- Body: fg primary

**Assistant bubble:**
- Border: 1px solid `--orange-soft`
- Left edge: 2px solid `--orange` (brand accent)
- Header: `Claude` + model name (small, dim) + status icon
- Body: full markdown — headings, lists, inline code with `--code-bg`

### 5.2 Thinking blocks (collapsible)

```
╭─ Claude ──────────────── ◯ thinking 0.8s ─╮
│ ▾ Thinking                                │
│   The user wants a health endpoint...    │
│   I'll add it under /health and make it   │
│   return { status: "ok", uptime }         │
│ ▸ collapsed by default — click to expand  │
╰──────────────────────────────────────────╯
```

- Animated `◯` spinner while thinking (orange dots cycling)
- Default collapsed after thinking finishes
- Shows duration when collapsed: `thought 0.8s`

### 5.3 Tool calls

```
│ ▾ Tool call · edit_file              0.3s │
│   📄 src/routes.rs                          │
│   ┌────────────────────────────────────┐    │
│   │ +  pub async fn health() -> Json {  │    │
│   │      Json(json!({"status":"ok"}))  │    │
│   │ +  }                                 │    │
│   │                                     │    │
│   │ -  // TODO                          │    │
│   └────────────────────────────────────┘    │
│   +12 / -3                                  │
```

- Header: tool name (orange) · file · duration
- Body: diff with `+` green and `-` red on bg-subtle
- Status icon right: ✓ green, ✗ red, ⏳ orange spinner, ⊘ dim (skipped)

### 5.4 Code blocks

```
┌─ python ────────────────────── ⧉ copy ─┐
│ def hello():                            │
│     print("world")                      │
└─────────────────────────────────────────┘
```

- Filename label top-left if language known
- `⧉ copy` button top-right, hover orange
- Line numbers in fg-dim, gutter 4 chars wide
- No background fill — let terminal theme show through; use border to delimit
- Horizontal scroll for long lines (shift+arrow)

### 5.5 Streaming

When assistant is generating:
- Border pulses (orange → orange-hot → orange, 1.2s loop)
- A trailing `▌` cursor blinks at end of last token
- Tool calls appear inline as they fire, with live spinners
- Auto-scroll to bottom unless user has scrolled up — then show "↓ new messages" pill

---

## 6. Right Inspector

Three modes, switchable with `⌘1` `⌘2` `⌘3` or tabs:

### 6.1 Tool calls mode

```
┌─ Inspector · Tools ────────┐
│ ✓ edit_file   src/routes.rs│
│   +12 / -3     0.3s         │
│ ─────────────────────────  │
│ ✓ read_file   Cargo.toml   │
│   890 bytes    0.1s        │
│ ─────────────────────────  │
│ ⏳ bash       cargo test   │
│   running...    2.1s       │
└────────────────────────────┘
```

Chronological list of every tool call in the current session. Click to jump to it in the chat.

### 6.2 Diff mode

```
┌─ Inspector · Diff ─────────────┐
│ src/routes.rs     +12 / -3    │
├────────────────────────────────┤
│ @@ -10,3 +10,14 @@             │
│  fn router() {                 │
│ -    // TODO                   │
│ -    route("/")                │
│ +    route("/")                │
│ +    route("/health")          │
│ +    route("/api")             │
│  }                             │
│                                │
│ [✓ Accept] [✗ Reject] [≪ Prev] │
│              [Next ≫]         │
└────────────────────────────────┘
```

Full-file diff with syntax highlight. Approve/reject buttons at the bottom.

### 6.3 Agent tree mode

```
┌─ Inspector · Agents ───────┐
│ ◉ main                     │
│  ├─ ✓ explorer   1.2s      │
│  │   ↳ 3 tool calls        │
│  ├─ ◯ researcher  waiting  │
│  │   ↳ delegated: parse    │
│  └─ ◯ verifier    idle     │
│                             │
│ Click any to filter chat ↗ │
└─────────────────────────────┘
```

Live agent hierarchy. Clicking a node filters the chat to only show messages from that agent's perspective.

---

## 7. Bottom Prompt Bar

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▌ Add a /health endpoint…                                  ⏎ send ⇧⏎ nl  / │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Single-line input with auto-grow (max 8 lines, then scrolls)
- Left orange bar when focused
- Placeholder: dim
- Right hints: `⏎ send` `⇧⏎ newline` `/` commands
- Slash menu pops above when `/` typed:

```
│ /help       Show all commands             │
│ /clear      Clear current session          │
│ /compact    Compress context               │
│ /model      Switch model            ◀──   │
│ /resume     Resume a session               │
│ /agents     Manage sub-agents              │
```

- `Tab` autocomplete
- `↑` / `↓` history (per session)
- `Ctrl+R` history search

---

## 8. Command Palette

`⌘K` (or `Ctrl+K`):

```
┌────────────────────────────────────────┐
│ 🔍 Type a command…                     │
├────────────────────────────────────────┤
│ > New session                          │
│   Switch session                   ◀   │
│   Toggle sidebar                       │
│   Toggle inspector                     │
│   Change model                         │
│   Open file…                           │
│   Run slash command…                   │
│   Toggle theme                         │
└────────────────────────────────────────┘
```

- Floating modal, centered, 60% width
- Fuzzy filter as you type
- `↵` run, `esc` close
- Recently used at top

---

## 9. Modal Dialogs

### Permission prompt

```
┌─ Allow Bash command? ────────────────┐
│                                      │
│   $ rm -rf node_modules              │
│                                      │
│   This will delete 247 files.        │
│                                      │
│   [ Allow ]  [ Allow always ]  [✗]   │
└──────────────────────────────────────┘
```

### Plan approval

```
┌─ Plan ────────────────────────────────┐
│ 1. Add /health route                  │
│ 2. Register in router                 │
│ 3. Add test                           │
│                                       │
│ Estimated: 3 file changes             │
│                                       │
│ [✓ Approve]  [✗ Reject]  [✎ Edit]    │
└───────────────────────────────────────┘
```

Modals: centered, 70% width, border-strong, soft drop shadow drawn with box chars. Buttons: orange outline for primary, dim for secondary.

---

## 10. Status & Notifications

### Bottom-right toast (transient)

```
                                    ┌─ ✓ File saved ────────┐
                                    └───────────────────────┘
```

- Slides up from bottom-right
- Auto-dismiss 3s
- Types: `info` (orange), `success` (green), `warning` (amber), `error` (red)

### Context window indicator (top bar)

The `●●● ●●` in the top bar:
- 5 dots, each = 20% of context
- Empty dot: fg-dim
- Half-full: orange-soft
- Full: orange
- Near-full (last dot): pulse animation

### Spinner states

| State | Glyph | Color |
|---|---|---|
| Thinking | ◌◍◌◍ cycling | orange |
| Tool running | ⏳ rotating | orange |
| Awaiting permission | ⏸ static | amber |
| Done | ✓ | green |
| Error | ✗ | red |

---

## 11. Keyboard Map

```
Navigation
  ⌘B                toggle sidebar
  ⌘I                toggle inspector
  ⌘1/2/3            inspector tabs (tools / diff / agents)
  ⌘K                command palette
  ?                  help overlay
  Esc                close modal / cancel

Chat
  ⏎                  send
  ⇧⏎                 newline
  ↑ / ↓              history (when empty) / cursor (when typing)
  ⌘↑ / ⌘↓            scroll chat
  ⌥ click            open link / expand tool

Selection
  ⇧ click             range select
  ⌘C / ⌘X            copy / cut
  ⌘A                 select all

Session
  ⌘N                 new session
  ⌘R                 resume session
  ⌘.                 interrupt current run
  ⌘⇧S                save & name session
```

---

## 12. Render Loop & State

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Events     │───▶│  Reducer     │───▶│    State     │
│  (keys,      │    │  (pure fn)   │    │  (immutable) │
│   resize,    │    │              │    │              │
│   stream)    │    │              │    │              │
└──────────────┘    └──────────────┘    └──────┬───────┘
                                                │
                                                ▼
                                       ┌──────────────┐
                                       │     View     │
                                       │  (pure fn)   │
                                       │  state→tree  │
                                       └──────┬───────┘
                                              │
                                              ▼
                                       ┌──────────────┐
                                       │   Diff &     │
                                       │   Paint      │
                                       │  (ratatui)   │
                                       └──────────────┘
```

- **State:** `AppState { sidebar, inspector, chat, prompt, modals, theme, agents }`
- **Events:** key, mouse, resize, stream-token, stream-tool, stream-end, agent-spawn, agent-done, toast
- **View:** pure `state -> VNode`, diff against last frame
- **Render:** ratatui buffers → terminal

**Frame budget:** 16ms (60fps). Streaming tokens → repaint only the active message, not the whole screen.

---

## 13. Animation Specs

All animations are subtle, ≤ 200ms, easing: `ease-out`.

| Element | Animation |
|---|---|
| Sidebar toggle | slide 180ms |
| Modal open | scale 0.95 → 1.0 + fade 120ms |
| Toast | slide-up 160ms, slide-down 120ms on dismiss |
| Spinner | 100ms per frame |
| Context dot pulse | 1.2s loop |
| Thinking cursor | blink 1s |
| Button hover | bg color transition 80ms |

Respect `prefers-reduced-motion` from the terminal — most terminals don't expose it, so use a config flag.

---

## 14. Responsive Behavior

| Width | Behavior |
|---|---|
| ≥ 120 cols | full 3-column layout |
| 80–119 cols | collapse inspector to icon strip |
| 60–79 cols | collapse sidebar, inspector becomes overlay |
| < 60 cols | single column, full-screen chat, modals full-screen |

Height: minimum 24 rows. Below that, show a "terminal too small" message.

---

## 15. File Structure (suggested)

```
src/
  main.rs
  app/
    state.rs          AppState
    events.rs         Event enum
    reducer.rs        state transitions
  ui/
    layout.rs         3-column grid
    topbar.rs
    sidebar/
      mod.rs
      sessions.rs
      files.rs
      agents.rs
    chat/
      mod.rs
      message.rs
      tool_call.rs
      code_block.rs
      markdown.rs
    inspector/
      mod.rs
      tools.rs
      diff.rs
      agent_tree.rs
    prompt.rs
    palette.rs
    modal.rs
    toast.rs
  theme/
    tokens.rs         color constants
    light.rs
    dark.rs
  input/
    keys.rs           keymap
    mouse.rs
  render/
    diff.rs           frame diffing
    buffer.rs
```

---

## 16. Implementation Tips

1. **Start with the chat scroll.** It's the heart. Get virtualized scrolling working — only render visible messages + a buffer above/below. For 10k messages this is essential.
2. **Theme tokens first.** Define every color as a token before writing any view code. Swap light/dark = one constant change.
3. **Markdown rendering** is its own subsystem. Use `pulldown-cmark` (Rust) or `marked` (JS). Handle streaming markdown by re-parsing on each token chunk (debounce to 50ms).
4. **Syntax highlighting** for code blocks: `syntect` (Rust) or `shiki` (JS). Cache by `(lang, source_hash)`.
5. **Diff rendering:** for tool calls, prefer showing only the changed region with `@@` context, not the full file.
6. **Mouse support:** enable with `EnableMouseCellMotion`/`EnableMouseAllMotion`. Many terminals send mouse events, but be sure left/right click work and scroll wheel maps to chat scroll when over the chat region.
7. **Resilience:** render must never panic. Wrap every view in a `catch_unwind`. A bad markdown token shouldn't kill the app.
8. **Test in iTerm2, Kitty, WezTerm, Alacritty, and Windows Terminal.** Color rendering differs — use 24-bit true color (`\x1b[38;2;R;G;Bm`) which all modern terminals support.

---

## 17. Visual Style Rules

- **No emojis as primary UI** — they're noisy. Use them only as file-type indicators or status icons.
- **No background fills on body text** — terminal backgrounds are noisy; keep text bare.
- **Borders are the visual language.** Use `─` `│` `┌` `┐` `└` `┘` `╭` `╮` `╰` `╯` `▾` `▸` `▌` `▏` consistently.
- **Orange is rare.** A panel border + a left accent bar + a button. That's it per screen.
- **Whitespace is content.** Don't fill empty space with rules. Let it breathe.
- **Numbers and timestamps always dim.** They're reference, not focus.

---

## 18. Mouse Interaction Map

```
┌────────────────────────────────────────┐
│ TOP BAR    │ click logo → home         │
│            │ click branch → git panel │
├────────────┼───────────────────────────│
│ SIDEBAR    │ click row → select       │
│            │ click ▸ → expand         │
│            │ click ● → active toggle  │
│            │ right-click → menu       │
├────────────┼───────────────────────────│
│ CHAT       │ click bubble → focus     │
│            │ click tool → expand      │
│            │ scroll → chat scroll     │
│            │ select text → copy       │
├────────────┼───────────────────────────│
│ INSPECTOR  │ click item → jump        │
│            │ click ✓/✗ → approve/rej  │
├────────────┴───────────────────────────│
│ PROMPT    │ click → focus             │
└────────────────────────────────────────┘
```

Scroll wheel over chat scrolls chat. Scroll wheel over sidebar scrolls sidebar. They don't fight.

---

## 19. Empty States

### No sessions yet

```
┌────────────────────────────────────────┐
│                                        │
│         ◌ No sessions yet              │
│                                        │
│   Start a new conversation to begin.   │
│                                        │
│       [ + New session ]                │
│                                        │
│   Tip: ⌘N to start, ⌘K for commands   │
│                                        │
└────────────────────────────────────────┘
```

### Empty chat (mid-session)

```
│   Ask me anything about this codebase. │
│                                        │
│   ▸ "explain the auth flow"            │
│   ▸ "find the bug in parser.rs"        │
│   ▸ "add a /health endpoint"           │
```

Suggestions in `--orange-soft` boxes, click to send.

---

## 20. Accessibility

- All colors meet WCAG AA contrast against their background (orange on white = 4.5:1, orange on dark = 5:1).
- Don't rely on color alone — every status has an icon (✓ ✗ ⏳ ◌).
- Full keyboard control — no mouse required.
- Focus ring: 2px orange outline on the active panel.
- Screen reader: pipe terminal text to a TTS-friendly mode (`--tts` flag) that reads message roles and content linearly.

---

## 21. Theming

Users can override any token. Settings file:

```
~/.config/claude-code/theme.toml

[light]
bg = "#FFFFFF"
orange = "#FF6B1A"

[dark]
bg = "#1A1A1A"
orange = "#FF8A3D"
```

Hot-reload with `⌘⇧T`.

---

## Summary

This UI is **chat-first, chrome-minimal, orange-accented**. The brand color appears at exactly three places per screen: an active left border on the assistant message, the active selection in the sidebar, and one CTA button. Everything else is white/cream/dark gray with crisp 1px borders. The result feels like Claude Code: technical, fast, no-nonsense — but warm where it matters.

**Build order:**
1. Theme tokens + color system
2. Layout grid (3-column)
3. Chat scroll + message rendering
4. Prompt bar + slash menu
5. Sidebar (sessions + files)
6. Inspector (tools/diff/agents)
7. Command palette
8. Modals & toasts
9. Streaming polish
10. Theme toggle + final QA
