# Klyro — Cline-Style Terminal TUI Implementation

Purpose: Build Klyro's terminal UI like Cline's current CLI TUI: native terminal rendering with OpenTUI, React components, a scrollable transcript, keyboard-driven interaction, streaming output, tool activity, and a fixed input area.

Important: This is TUI / terminal only. No browser, HTML, CSS, DOM, or web UI.

The reference describes Cline's TUI as OpenTUI-based and identifies ChatMessageList as the core transcript component.

## 1. Technology

Use:

- TypeScript
- Node.js
- React
- OpenTUI
- @opentui/react

Architecture:

```
Klyro CLI
   │
   ▼
OpenTUI
   │
   ▼
React TUI
   │
   ├── ChatView
   ├── ChatMessageList
   ├── ChatEntryView
   ├── PromptInput
   ├── StatusBar
   ├── PermissionDialog
   └── ActivityView
```

Do not create a browser application.

## 2. Main TUI Layout

The main chat screen should be:

```
┌──────────────────────────────────────────────────────────────┐
│ KLYRO                                      ~/project          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  You                                                         │
│  Add authentication to the application                      │
│                                                              │
│  Klyro                                                       │
│  I'll inspect the project first.                             │
│                                                              │
│  ✓ Read 14 files                                             │
│  ✓ Searched src/                                             │
│  ✓ Modified 4 files                                         │
│                                                              │
│  Running tests...                                            │
│  ✓ 27 tests passed                                           │
│                                                              │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ › Message Klyro...                                           │
├──────────────────────────────────────────────────────────────┤
│ enter send · shift+enter newline                 $0.03  8%    │
└──────────────────────────────────────────────────────────────┘
```

The important layout is:

```
Header
   ↓
ChatMessageList   ← flexible / scrollable
   ↓
PromptInput       ← fixed
   ↓
StatusBar         ← fixed
```

## 3. ChatView

File:

```
apps/cli/src/tui/views/chat-view.tsx
```

Use a column layout:

```tsx
<box
  flexDirection="column"
  width="100%"
  height="100%"
>
  <Header />

  <ChatMessageList
    ref={transcriptScrollRef}
    entries={entries}
    isStreaming={isStreaming}
  />

  <PromptInput />

  <StatusBar />
</box>
```

The transcript gets:

```
flexGrow={1}
```

The input does not belong inside the transcript.

## 4. ChatMessageList

File:

```
apps/cli/src/tui/components/chat-message-list.tsx
```

This is the core TUI component.

```tsx
<scrollbox
  ref={scrollboxRef}
  flexGrow={1}
  stickyScroll
  stickyStart="bottom"
>
  <box
    flexDirection="column"
    paddingX={1}
    paddingY={1}
    gap={1}
  >
    {entries.map((entry) => (
      <ChatEntryView
        key={entry.id}
        entry={entry}
      />
    ))}

    {isStreaming && (
      <box flexDirection="row" gap={1}>
        <spinner name="dots" />

        <text fg="gray">
          Thinking... (esc to cancel)
        </text>
      </box>
    )}
  </box>
</scrollbox>
```

Cline uses this same fundamental pattern: OpenTUI's native scrollbox, flexGrow={1}, stickyScroll, and stickyStart="bottom".

## 5. Transcript Entries

Do not render raw agent events directly.

Use a clean transcript model:

```ts
type TranscriptEntry =
  | UserEntry
  | AssistantEntry
  | ActivityEntry
  | PlanEntry
  | PermissionEntry
  | ErrorEntry;
```

Example:

```ts
type UserEntry = {
  id: string;
  kind: "user";
  text: string;
};

type AssistantEntry = {
  id: string;
  kind: "assistant";
  text: string;
  streaming?: boolean;
};

type ActivityEntry = {
  id: string;
  kind: "activity";
  title: string;
  status: "running" | "success" | "failed";
  details?: ActivityDetail[];
};
```

## 6. ChatEntryView

File:

```
apps/cli/src/tui/components/chat-entry-view.tsx
```

Responsibilities:

```
TranscriptEntry
      ↓
ChatEntryView
      ↓
OpenTUI components
```

Examples:

```
User
> Add authentication
```

```
Assistant
• Klyro

I'll inspect the project first.
```

```
Activity
✓ Read 14 files
```

```
Running activity
◌ Running tests...
```

```
Failure
✗ Tests failed
```

## 7. Activity Aggregation

The agent may internally generate hundreds of events.

Do not display all of them.

Bad:

```
tool started
queued: f
queued: f
tool input
tool output
queued: df
tool finished
tool started
...
```

Instead:

```
✓ Read 14 files
✓ Searched 38 files
✓ Ran 5 commands
✓ Modified 6 files
```

Architecture:

```
Agent Events
     │
     ▼
Activity Aggregator
     │
     ▼
TranscriptEntry[]
     │
     ▼
ChatMessageList
```

Raw events can remain available internally.

## 8. Scrolling

Do not create a custom scrolling engine.

Use OpenTUI:

```tsx
<scrollbox
  ref={scrollboxRef}
  flexGrow={1}
  stickyScroll
  stickyStart="bottom"
>
```

The source specifically describes Cline as using OpenTUI's native scrollbox rather than a custom virtual list.

## 9. Transcript Scroll Handle

Expose scrolling through a React ref.

```ts
export type TranscriptCommand =
  | "messages_half_page_up"
  | "messages_half_page_down"
  | "messages_first"
  | "messages_last";

export type TranscriptScrollHandle = {
  runTranscriptCommand(
    command: TranscriptCommand,
  ): void;
};
```

Implementation:

```ts
const scrollboxRef = useRef<any>(null);

const runTranscriptCommand = useCallback(
  (command: TranscriptCommand) => {
    const scrollbox = scrollboxRef.current;

    if (!scrollbox) {
      return;
    }

    switch (command) {
      case "messages_half_page_up":
        scrollbox.scrollBy(-scrollbox.height / 4);
        return;

      case "messages_half_page_down":
        scrollbox.scrollBy(scrollbox.height / 4);
        return;

      case "messages_first":
        scrollbox.scrollTo(0);
        return;

      case "messages_last":
        scrollbox.scrollTo(scrollbox.scrollHeight);
        return;
    }
  },
  [],
);
```

This is the same four-command abstraction described in the Cline implementation.

## 10. useImperativeHandle

Expose the handle to the parent:

```ts
useImperativeHandle(
  ref,
  () => ({
    runTranscriptCommand,
  }),
  [runTranscriptCommand],
);
```

Parent:

```ts
const transcriptScrollRef =
  useRef<TranscriptScrollHandle | null>(null);
```

Then:

```tsx
<ChatMessageList
  ref={transcriptScrollRef}
  entries={entries}
  isStreaming={isStreaming}
/>
```

## 11. Keyboard Controls

File:

```
apps/cli/src/tui/hooks/transcript-keybinds.ts
```

Default:

```
PageUp       → messages_half_page_up
Ctrl+U       → messages_half_page_up

PageDown     → messages_half_page_down
Ctrl+D       → messages_half_page_down

Ctrl+Home    → messages_first
Ctrl+End     → messages_last
```

These are the documented Cline-style mappings.

## 12. Root Keyboard

File:

```
apps/cli/src/tui/hooks/use-root-keyboard.ts
```

Flow:

```
Keyboard
   ↓
useRootKeyboard
   ↓
matchTranscriptKeybind()
   ↓
TranscriptCommand
   ↓
transcriptScrollRef
   ↓
ChatMessageList
   ↓
OpenTUI ScrollBox
```

Implementation:

```ts
useKeyboard((key) => {
  const command = matchTranscriptKeybind(key);

  if (!command) {
    return;
  }

  key.preventDefault();

  transcriptScrollRef.current
    ?.runTranscriptCommand(command);
});
```

## 13. Auto Scroll

When a new user message is submitted:

```
User presses Enter
       ↓
Add user message
       ↓
userSubmissionScrollKey++
       ↓
scrollToBottom()
```

Use:

```ts
useEffect(() => {
  if (!userSubmissionScrollKey) {
    return;
  }

  const scrollToBottom = () => {
    const scrollbox = scrollboxRef.current;

    if (!scrollbox) {
      return;
    }

    scrollbox.scrollTo(scrollbox.scrollHeight);
  };

  scrollToBottom();

  queueMicrotask(scrollToBottom);

  const timeout = setTimeout(
    scrollToBottom,
    0,
  );

  return () => {
    clearTimeout(timeout);
  };
}, [userSubmissionScrollKey]);
```

The source describes this immediate + microtask + timeout pattern as a way to allow React/OpenTUI layout to settle.

## 14. Streaming

Streaming should look like:

```
Model
 ↓
delta
 ↓
Assistant transcript entry
 ↓
TUI updates
 ↓
OpenTUI layout
 ↓
stickyScroll
 ↓
bottom remains visible
```

Do not call:

```
scrollToBottom();
```

for every individual token.

Use the scrollbox's sticky behavior.

## 15. User Scroll During Streaming

Normal behavior:

```
At bottom
   ↓
Agent streams
   ↓
Follow new content
```

But:

```
User scrolls up
   ↓
User reads previous output
   ↓
Don't fight the user
```

When the user returns to the bottom:

```
Bottom reached
   ↓
Auto-follow resumes
```

The provided Cline research describes this as smart auto-pin behavior: being at the bottom allows new content to follow; scrolling away releases the auto-pin.

## 16. Streaming Performance

Do not force React to rebuild the entire application for every token.

Use a streaming entry:

```ts
{
  id: "assistant-1",
  kind: "assistant",
  text: "...",
  streaming: true
}
```

Update only the active streaming entry.

The Cline research specifically notes imperative mutation/appending of session.entries during streaming to avoid React re-renders for every delta.

## 17. Prompt Input

File:

```
apps/cli/src/tui/components/prompt-input.tsx
```

Keep it outside the scrollbox:

```
┌──────────────────────────────────────────┐
│ transcript                               │
│                                          │
│ messages                                 │
│                                          │
│ messages                                 │
├──────────────────────────────────────────┤
│ › Type your message...                   │
├──────────────────────────────────────────┤
│ enter send · shift+enter newline         │
└──────────────────────────────────────────┘
```

The transcript scrolls.

The input remains fixed.

## 18. Input Behavior

Required:

```
Enter
    → submit

Shift+Enter
    → newline

Esc
    → cancel streaming / close active interaction

Ctrl+C
    → cancel current operation / exit when appropriate
```

Typing must never modify the transcript.

## 19. Header

Keep it small.

Example:

```
KLYRO v0.1.0
claude-sonnet · ~/projects/my-app
```

or:

```
KLYRO
~/projects/my-app
```

Do not create an IDE-style sidebar.

## 20. Status Bar

Bottom:

```
────────────────────────────────────────────────────────
enter send · shift+enter newline       $0.03 · 8% ctx
```

Possible information:

- model
- tokens
- cost
- context %
- git branch
- streaming state

Keep it compact.

## 21. Permission UI

When Klyro needs permission:

```
┌──────────────────────────────────────────────────────┐
│ Permission required                                  │
│                                                      │
│ Run: pnpm test                                       │
│                                                      │
│ [y] Allow   [a] Always   [n] Deny   [e] Explain     │
└──────────────────────────────────────────────────────┘
```

The permission dialog should temporarily capture keyboard input.

After closing:

```
Permission dialog
       ↓
restore transcript/input focus
```

## 22. Tool Activity

Default:

```
✓ Read 14 files
✓ Searched 38 files
✓ Ran 5 commands
✓ Modified 6 files
```

Expandable:

```
▼ Ran 5 commands

  $ pnpm test
  $ pnpm build
  $ git diff --check
  $ pnpm lint
  $ pnpm typecheck
```

This keeps the TUI clean without losing information.

## 23. Markdown Rendering

Assistant responses should support terminal Markdown:

```
# Authentication

I've implemented the authentication flow.

## Changes

• Added auth service
• Added login endpoint
• Added middleware
```

Support:

- headings
- bold
- italic
- lists
- code
- code blocks
- links
- tables where practical

Everything must render for the terminal.

No HTML.

## 24. Code Blocks

Example:

```
┌────────────────────────────────────────────┐
│ const user = await auth.login(credentials) │
│                                            │
│ return createSession(user);                │
└────────────────────────────────────────────┘
```

Use terminal syntax highlighting if OpenTUI's available components support it.

## 25. Diff UI

When files are modified:

```
✓ src/auth/service.ts

  + export async function login(...)
  +   ...
  - old implementation
```

Default view should be compact.

Allow detailed diff inspection separately.

## 26. Plan UI

Example:

```
◇ Plan

  1. Add authentication service
  2. Add login endpoint
  3. Add session middleware
  4. Add tests
```

As work progresses:

```
◇ Plan

  ✓ 1. Add authentication service
  ✓ 2. Add login endpoint
  ◌ 3. Add session middleware
  ○ 4. Add tests
```

## 27. Agent Activity

The UI should feel like an agent working:

```
• Klyro

Analyzing repository...

✓ Read 14 files
✓ Searched src/
✓ Found authentication-related code

◇ Plan

  1. Create auth service
  2. Add login endpoint
  3. Add middleware

✓ Modified 4 files

Running tests...

✓ 27 passed

Done.
```

Not:

```
tool_call
tool_call
tool_call
tool_result
tool_result
JSON
JSON
JSON
```

## 28. TUI State

Keep UI state separate from agent state.

```
Agent Runtime
     │
     ▼
Events
     │
     ▼
TUI State Reducer
     │
     ▼
React
     │
     ▼
OpenTUI
```

Do not make the agent directly call:

```
console.log()
```

The agent emits events.

The TUI decides how to display them.

## 29. Event Model

Example:

```ts
type KlyroUIEvent =
  | {
      type: "user.message";
      text: string;
    }
  | {
      type: "assistant.delta";
      text: string;
    }
  | {
      type: "tool.started";
      tool: string;
    }
  | {
      type: "tool.finished";
      tool: string;
      success: boolean;
    }
  | {
      type: "permission.requested";
      tool: string;
    }
  | {
      type: "verification.started";
    }
  | {
      type: "verification.finished";
      success: boolean;
    };
```

## 30. Complete Architecture

```
                    KLYRO
                      │
                      ▼
               Agent Runtime
                      │
                      ▼
                Event Stream
                      │
                      ▼
             TUI Event Reducer
                      │
                      ▼
             Transcript State
                      │
          ┌───────────┴───────────┐
          │                       │
          ▼                       ▼
 ChatMessageList              PromptInput
          │
          ▼
     OpenTUI ScrollBox
          │
          ▼
       Terminal
```

## 31. File Structure

```
apps/cli/src/tui/
│
├── app.tsx
│
├── views/
│   ├── home-view.tsx
│   └── chat-view.tsx
│
├── components/
│   ├── header.tsx
│   ├── chat-message-list.tsx
│   ├── chat-entry-view.tsx
│   ├── prompt-input.tsx
│   ├── status-bar.tsx
│   ├── activity-view.tsx
│   ├── plan-view.tsx
│   ├── diff-view.tsx
│   ├── permission-dialog.tsx
│   └── markdown-view.tsx
│
├── hooks/
│   ├── use-root-keyboard.ts
│   ├── use-prompt-input.ts
│   └── transcript-keybinds.ts
│
├── state/
│   ├── tui-state.ts
│   └── tui-reducer.ts
│
└── types.ts
```

## 32. What NOT to Build

Do not initially build:

```
❌ Browser UI
❌ HTML/CSS
❌ Custom scrolling engine
❌ Custom scroll physics
❌ Custom viewport mathematics
❌ Custom terminal mouse parser
❌ Custom virtual list
❌ IDE-style sidebar
❌ Dashboard UI
❌ Huge permanent tool cards
❌ Raw event spam
```

Use OpenTUI for terminal rendering and scrolling.

## 33. Final UX

Klyro should ultimately feel like:

```
KLYRO v0.1.0
claude-sonnet · ~/projects/my-app

> Add authentication to this app

• Klyro

I'll inspect the project first.

  ✓ Read 14 files
  ✓ Searched src/
  ✓ Found auth-related files

◇ Plan

  1. Add authentication service
  2. Create login endpoint
  3. Add session middleware
  4. Add tests

  ✓ src/auth/service.ts
  ✓ src/api/login.ts
  ✓ src/middleware/auth.ts

  Running tests...

  ✓ 27 tests passed

Authentication has been implemented.

────────────────────────────────────────────────────────
› Message Klyro...
────────────────────────────────────────────────────────
enter send · shift+enter newline
```

The middle transcript scrolls, while the input and status stay fixed.

## 34. The Core Rule

The implementation should stay this simple:

```
                  TERMINAL
                     │
                     ▼
                   OpenTUI
                     │
          ┌──────────┴──────────┐
          │                     │
       ScrollBox            Keyboard
          │                     │
          │                     ▼
          │              TranscriptCommand
          │                     │
          └──────────────┬──────┘
                         ▼
                ChatMessageList
```

The actual scrolling is only:

```
scrollbox.scrollBy(...)
scrollbox.scrollTo(...)
```

with:

```tsx
<scrollbox
  flexGrow={1}
  stickyScroll
  stickyStart="bottom"
>
```