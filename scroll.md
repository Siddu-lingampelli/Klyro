# Klyro — Correct Terminal TUI Scroll Implementation

> STATUS (shipped): the OpenTUI `<scrollbox stickyScroll>` design below was
> NOT adopted — `package.json` has no `@opentui/react`. The shipped TUI
> renders with Ink and implements the same four-command vocabulary
> (`messages_half_page_up/down/first/last`) on a measured anchor viewport:
> `src/tui/scroll-model.ts` (anchor reducer), `src/tui/measure.ts`
> (display-line measurement), `src/tui/transcript-commands.ts` (bindings),
> `src/tui/mouse.ts` (wheel tap). Read this doc as the behavior spec, the
> `src/tui/` modules as the implementation.

**Goal:** Implement terminal scrolling like Cline using OpenTUI's native scrollbox.  
Do not build a custom scroll engine or custom scroll math.

## 1. Core Architecture

```
User
 │
 ├── PageUp / Ctrl+U
 ├── PageDown / Ctrl+D
 ├── Ctrl+Home
 └── Ctrl+End
        │
        ▼
Root Keyboard Handler
        │
        ▼
Transcript Keybind Handler
        │
        ▼
TranscriptScrollHandle
        │
        ▼
ChatMessageList
        │
        ▼
OpenTUI <scrollbox>
```

The scrollbox is responsible for the actual terminal scrolling.

## 2. ChatMessageList

File:

```
apps/cli/src/tui/components/chat-message-list.tsx
```

Use OpenTUI's native scrollbox.

```tsx
import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useCallback,
} from "react";

type TranscriptCommand =
  | "messages_half_page_up"
  | "messages_half_page_down"
  | "messages_first"
  | "messages_last";

export type TranscriptScrollHandle = {
  runTranscriptCommand: (command: TranscriptCommand) => void;
};

type ChatMessageListProps = {
  entries: ChatEntry[];
  isStreaming: boolean;
};

export const ChatMessageList = forwardRef<
  TranscriptScrollHandle,
  ChatMessageListProps
>(function ChatMessageList(
  { entries, isStreaming },
  ref,
) {
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

  useImperativeHandle(
    ref,
    () => ({
      runTranscriptCommand,
    }),
    [runTranscriptCommand],
  );

  return (
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
  );
});
```

## 3. Why These Three Properties Matter

```tsx
<scrollbox
  flexGrow={1}
  stickyScroll
  stickyStart="bottom"
>
```

### `flexGrow={1}`

The scrollbox occupies the available terminal height.

```
┌─────────────────────────────┐
│ Header                      │
├─────────────────────────────┤
│                             │
│       SCROLLBOX              │
│                             │
│       messages...            │
│                             │
├─────────────────────────────┤
│ Input                       │
└─────────────────────────────┘
```

### `stickyScroll`

Allows the transcript to scroll when its content becomes larger than the viewport.

### `stickyStart="bottom"`

Keeps the conversation at the bottom while new content arrives.

This is what gives the normal AI-chat behavior:

```
New response
     ↓
Transcript grows
     ↓
Scrollbox follows bottom
```

## 4. Scroll Commands

Only four commands are required initially.

```ts
type TranscriptCommand =
  | "messages_half_page_up"
  | "messages_half_page_down"
  | "messages_first"
  | "messages_last";
```

Implementation:

```ts
switch (command) {
  case "messages_half_page_up":
    scrollbox.scrollBy(-scrollbox.height / 4);
    break;

  case "messages_half_page_down":
    scrollbox.scrollBy(scrollbox.height / 4);
    break;

  case "messages_first":
    scrollbox.scrollTo(0);
    break;

  case "messages_last":
    scrollbox.scrollTo(scrollbox.scrollHeight);
    break;
}
```

Do not implement your own:

```
offsetY
maxOffsetY
clamp()
distanceFromBottom
scroll physics
viewport math
```

OpenTUI handles that.

## 5. Keyboard Bindings

File:

```
apps/cli/src/tui/hooks/transcript-keybinds.ts
```

```ts
export type TranscriptKeybind =
  | "messages_half_page_up"
  | "messages_half_page_down"
  | "messages_first"
  | "messages_last";

export function getTranscriptCommand(
  key: KeyEvent,
): TranscriptKeybind | undefined {
  if (key.name === "pageup") {
    return "messages_half_page_up";
  }

  if (key.name === "pagedown") {
    return "messages_half_page_down";
  }

  if (key.ctrl && key.name === "u") {
    return "messages_half_page_up";
  }

  if (key.ctrl && key.name === "d") {
    return "messages_half_page_down";
  }

  if (key.ctrl && key.name === "home") {
    return "messages_first";
  }

  if (key.ctrl && key.name === "end") {
    return "messages_last";
  }

  return undefined;
}
```

Required behavior:

| Key | Action |
|-----|--------|
| PageUp | Scroll up |
| Ctrl+U | Scroll up |
| PageDown | Scroll down |
| Ctrl+D | Scroll down |
| Ctrl+Home | Top |
| Ctrl+End | Bottom |

## 6. Root Keyboard Handler

File:

```
apps/cli/src/tui/hooks/use-root-keyboard.ts
```

The root keyboard handler should delegate transcript scrolling.

```ts
const command = getTranscriptCommand(key);

if (command) {
  transcriptScrollRef.current?.runTranscriptCommand(command);
  return;
}
```

Flow:

```
Keyboard
   ↓
useRootKeyboard
   ↓
getTranscriptCommand()
   ↓
TranscriptScrollHandle
   ↓
ChatMessageList
   ↓
scrollbox.scrollBy()
scrollbox.scrollTo()
```

## 7. Automatic Scroll on New User Message

When the user sends a new prompt, the transcript should move to the bottom.

Use a scroll key/version rather than coupling the scroll directly to every render.

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

  const timeout = setTimeout(scrollToBottom, 0);

  return () => {
    clearTimeout(timeout);
  };
}, [userSubmissionScrollKey]);
```

The purpose of the repeated calls is simple:

```
React update
    ↓
OpenTUI layout
    ↓
content height changes
    ↓
scroll to bottom
```

The delayed calls allow the layout to settle.

## 8. Streaming Responses

Do not do this:

```ts
useEffect(() => {
  scrollbox.scrollTo(scrollbox.scrollHeight);
}, [everyToken]);
```

That is unnecessary and can cause excessive work.

Instead:

```
Model stream
    ↓
streaming content changes
    ↓
transcript updates
    ↓
OpenTUI recalculates layout
    ↓
stickyScroll keeps bottom visible
```

The OpenTUI scrollbox handles the scrolling behavior.

## 9. User Scrolls Up During Streaming

This behavior is important.

If the user is reading older content:

```
┌────────────────────────────┐
│ old message                │
│ old tool output            │
│ old response               │
│                            │
│        USER SCROLLS UP ↑   │
└────────────────────────────┘
```

The UI should allow the user to remain there instead of fighting them.

The desired behavior is:

```
At bottom
   ↓
Agent streams
   ↓
Auto-follow bottom
```

But:

```
User scrolls up
   ↓
User is reading history
   ↓
Do NOT force-scroll them back down
```

When the user returns to the bottom:

```
User reaches bottom
   ↓
sticky behavior resumes
```

This behavior should come primarily from OpenTUI's stickyScroll behavior rather than a custom scrolling implementation.

## 10. Chat Layout

The transcript should be the flexible middle section.

```tsx
<box flexDirection="column" width="100%" height="100%">
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

Important:

```
Header
  ↓
Scrollbox  ← flexGrow=1
  ↓
Input
  ↓
Status
```

The input should not be inside the scrollbox.

## 11. Input Must Be Isolated

Do not create this:

```tsx
<scrollbox>
  messages
  input
</scrollbox>
```

Instead:

```tsx
<box flexDirection="column">
  <scrollbox flexGrow={1}>
    messages
  </scrollbox>

  <PromptInput />
</box>
```

Therefore:

```
Scroll keys
    ↓
Transcript

Typing
    ↓
PromptInput
```

The user's partially typed message must never become part of the transcript.

## 12. Streaming Activity

Tool activity should also appear inside the transcript.

Example:

```
You
> Add authentication

Klyro
  Analyzing repository...

  ✓ Read 14 files
  ✓ Searched src/
  ✓ Modified 4 files

  Running tests...

  ✓ 27 tests passed

  Authentication implemented.
```

All of this lives inside:

```tsx
<scrollbox>
  <box flexDirection="column">
    ...
  </box>
</scrollbox>
```

## 13. Activity Should Be Aggregated

Do not render every internal event permanently.

Bad:

```
queued: f
queued: f
queued: df
queued: df
tool started
tool input
tool output
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
✓ Tests passed
```

The scrollbox should only render the final UI representation.

Architecture:

```
Agent
  ↓
Events
  ↓
Activity Aggregator
  ↓
Transcript Entries
  ↓
ChatMessageList
  ↓
OpenTUI ScrollBox
```

## 14. Long Transcript

Do not build custom virtualization for the first implementation.

Start with:

```tsx
<scrollbox>
  <box flexDirection="column">
    {entries.map(...)}
  </box>
</scrollbox>
```

This matches the simple Cline approach.

Later, if profiling shows that extremely large sessions become slow, optimize the transcript rendering.

Do not prematurely build a custom virtual scrolling system.

## 15. Scrollbar

Do not build a custom scrollbar initially.

Use OpenTUI's scrollbox capabilities.

The first implementation only needs:

```
PageUp
PageDown
Ctrl+U
Ctrl+D
Ctrl+Home
Ctrl+End
Mouse wheel
Sticky bottom
```

If OpenTUI provides scrollbar configuration, expose it later through the TUI configuration layer.

## 16. Mouse Scrolling

Mouse scrolling should be handled by OpenTUI.

Do not implement terminal mouse escape sequences yourself unless OpenTUI requires a specific integration.

> Current behavior (copy/paste fix): terminal mouse *reporting* is OFF by
> default so native text selection (copy) and right-click paste keep working
> — button reporting routes those gestures to the app, which cannot honor
> them. Set `KLYRO_MOUSE=1` to opt into wheel scrolling (±3 lines); keyboard
> scrolling (PgUp/PgDn, Ctrl+U/D) always works. Bracketed paste (keyboard
> paste) is independent of this flag and always on.

Desired behavior:

```
Mouse wheel ↑
      ↓
OpenTUI
      ↓
ScrollBox
      ↓
Transcript moves up
```

and:

```
Mouse wheel ↓
      ↓
OpenTUI
      ↓
ScrollBox
      ↓
Transcript moves down
```

## 17. Terminal Resize

The scrollbox must live inside a flexible layout:

```tsx
<box
  flexDirection="column"
  width="100%"
  height="100%"
>
  <Header />

  <scrollbox
    flexGrow={1}
    stickyScroll
    stickyStart="bottom"
  >
    ...
  </scrollbox>

  <PromptInput />

  <StatusBar />
</box>
```

When the terminal changes:

```
Terminal resize
      ↓
OpenTUI layout recalculation
      ↓
Scrollbox viewport changes
      ↓
Transcript reflows
```

Do not implement manual terminal-height calculations unless OpenTUI requires them.

## 18. Complete Scroll Flow

### User scrolling

```
PageUp
   ↓
useRootKeyboard
   ↓
transcript-keybinds
   ↓
messages_half_page_up
   ↓
TranscriptScrollHandle
   ↓
scrollbox.scrollBy(-height / 4)
```

### Bottom

```
Ctrl+End
   ↓
messages_last
   ↓
scrollbox.scrollTo(scrollHeight)
```

### Top

```
Ctrl+Home
   ↓
messages_first
   ↓
scrollbox.scrollTo(0)
```

### New message

```
User submits
   ↓
userSubmissionScrollKey++
   ↓
scrollToBottom()
   ↓
scrollbox.scrollTo(scrollHeight)
```

### Streaming

```
Model stream
   ↓
Transcript updates
   ↓
OpenTUI layout
   ↓
stickyScroll
   ↓
bottom stays visible
```

## 19. Files

Keep the implementation small:

```
apps/cli/src/tui/
│
├── components/
│   ├── chat-message-list.tsx
│   ├── chat-entry-view.tsx
│   ├── prompt-input.tsx
│   └── status-bar.tsx
│
├── hooks/
│   ├── use-root-keyboard.ts
│   ├── use-prompt-input-controller.ts
│   └── transcript-keybinds.ts
│
└── views/
    └── chat-view.tsx
```

No:

```
scroll-engine.ts
scroll-math.ts
scroll-state-machine.ts
scroll-physics.ts
virtual-scroll-engine.ts
```

for the initial implementation.

## 20. Final Klyro Scroll Architecture

```
                    ┌─────────────────────┐
                    │     Terminal        │
                    └──────────┬──────────┘
                               │
                         keyboard/mouse
                               │
                               ▼
                    ┌─────────────────────┐
                    │ useRootKeyboard     │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ transcript-keybinds │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ TranscriptScroll    │
                    │ Handle              │
                    └──────────┬──────────┘
                               │
                               ▼
              ┌────────────────────────────────┐
              │       ChatMessageList           │
              │                                │
              │  ┌──────────────────────────┐  │
              │  │       OpenTUI             │  │
              │  │       scrollbox           │  │
              │  │                          │  │
              │  │  stickyScroll             │  │
              │  │  stickyStart="bottom"     │  │
              │  │  flexGrow={1}             │  │
              │  │                          │  │
              │  │  ChatEntry               │  │
              │  │  ChatEntry               │  │
              │  │  Activity                │  │
              │  │  Assistant response      │  │
              │  │  Tool activity           │  │
              │  │  ...                     │  │
              │  └──────────────────────────┘  │
              └────────────────────────────────┘
```

## 21. Definition of Done

The Klyro scroll implementation is complete when:

- [ ] Uses OpenTUI native `<scrollbox>`
- [ ] `flexGrow={1}`
- [ ] `stickyScroll`
- [ ] `stickyStart="bottom"`
- [ ] PageUp works
- [ ] PageDown works
- [ ] Ctrl+U works
- [ ] Ctrl+D works
- [ ] Ctrl+Home goes to top
- [ ] Ctrl+End goes to bottom
- [ ] Mouse wheel scrolls
- [ ] New messages appear at bottom
- [ ] Streaming follows bottom
- [ ] User can scroll up during streaming
- [ ] Returning to bottom resumes following
- [ ] Terminal resize works
- [ ] Input remains outside scrollbox
- [ ] Transcript can contain tool/activity entries
- [ ] Long conversations remain usable
- [ ] No custom scroll engine
- [ ] No custom scroll math
- [ ] No browser/web scrolling APIs

## The rule

Klyro should let OpenTUI do the scrolling.

Klyro only needs to control the scrollbox through:

```
scrollbox.scrollBy(...)
scrollbox.scrollTo(...)
```

and expose those operations through:

```
TranscriptScrollHandle
```

while:

```
stickyScroll
stickyStart="bottom"
```

handles normal automatic terminal chat scrolling.