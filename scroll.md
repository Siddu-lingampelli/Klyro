Klyro — Complete TUI Scroll Implementation

Goal: Build a professional coding-agent transcript viewport with reliable sticky-bottom scrolling, manual scrolling, streaming, mouse/keyboard input, terminal resize handling, activity aggregation, long-session performance, and PTY testing.

This is based on the supplied Cline/OpenTUI research, which identifies ScrollBox/sticky-bottom behavior, viewport-oriented rendering, keyboard/mouse interaction, and PTY-based testing as key parts of the TUI architecture.

1. Architecture

Do not implement scrolling directly inside the agent or message components.

Agent Runtime
      │
      ▼
  Event Stream
      │
      ▼
Event Normalizer
      │
      ├───────────────┐
      ▼               ▼
Conversation       Activity
Reducer            Aggregator
      │               │
      └───────┬───────┘
              ▼
       Transcript State
              │
              ▼
         TUI Renderer
              │
              ▼
         Layout Engine
              │
              ▼
      Content Measurement
              │
              ▼
       Scroll Controller
              │
              ▼
       ScrollBox Adapter
              │
              ▼
      Terminal Renderer
Critical rule
The agent does NOT control the viewport.

The user controls the viewport.

Automatic scrolling is allowed only while
the user is following the bottom.
2. TUI Layout

The input must remain outside the transcript scroll area.

┌─────────────────────────────────────────────────────────────┐
│ KLYRO · model · ~/project                                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    TRANSCRIPT                               │
│                                                             │
│ You                                                         │
│ Add authentication.                                        │
│                                                             │
│ Klyro                                                       │
│ I'll inspect the repository first.                         │
│                                                             │
│ ✓ Read 14 files                                             │
│ ✓ Searched 38 files                                         │
│ ⟳ Running tests...                                          │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ › Message Klyro...                                          │
├─────────────────────────────────────────────────────────────┤
│ enter send · shift+enter newline                $0.03 · 8% │
└─────────────────────────────────────────────────────────────┘

Architecture:

Root
├── Header
├── TranscriptViewport
│   └── ScrollBox
├── Input
└── StatusBar

Never:

ScrollBox
├── messages
├── input
└── status

Otherwise the input itself becomes part of the scrollable content.

3. Scroll State

Create a dedicated scroll state.

export interface ScrollState {
  offsetY: number;

  viewportHeight: number;
  contentHeight: number;
  maxOffsetY: number;

  isAtTop: boolean;
  isAtBottom: boolean;

  sticky: boolean;
  userScrolled: boolean;

  lastScrollDirection: "up" | "down" | null;

  distanceFromBottom: number;

  lastUserInteractionAt: number | null;
}

Do not rely on:

const [shouldScroll, setShouldScroll] = useState(true);

That is too simplistic for a coding-agent UI.

4. Scroll Controller

Recommended:

packages/cli/src/tui/scroll/
├── scroll-controller.ts
├── scroll-state.ts
├── scroll-events.ts
├── scroll-adapter.ts
└── __tests__/
    └── scroll-controller.test.ts

Interface:

export interface ScrollController {
  getState(): ScrollState;

  scrollBy(delta: number): void;
  scrollTo(offset: number): void;

  scrollToTop(): void;
  scrollToBottom(): void;

  updateViewport(height: number): void;
  updateContentHeight(height: number): void;

  onUserScroll(delta: number): void;

  enableSticky(): void;
  disableSticky(): void;

  maybeFollowBottom(): void;
}
5. Scroll Math

The fundamental equation:

maxOffsetY = Math.max(
  0,
  contentHeight - viewportHeight,
);

Offset must always satisfy:

0 <= offsetY <= maxOffsetY

Implementation:

function clampOffset(
  offset: number,
  maxOffset: number,
): number {
  return Math.max(
    0,
    Math.min(offset, maxOffset),
  );
}

Distance from bottom:

distanceFromBottom =
  maxOffsetY - offsetY;
6. Bottom Detection

Do not use:

offsetY === maxOffsetY;

Use an epsilon:

const BOTTOM_EPSILON = 1;

const isAtBottom =
  Math.abs(maxOffsetY - offsetY)
  <= BOTTOM_EPSILON;

This avoids small layout/measurement discrepancies.

7. Sticky-Bottom State Machine
             ┌──────────────┐
             │    STICKY    │
             │  at bottom   │
             └──────┬───────┘
                    │
              user scrolls ↑
                    │
                    ▼
             ┌──────────────┐
             │   DETACHED   │
             │ reading old  │
             │    output    │
             └──────┬───────┘
                    │
              user scrolls ↓
                    │
                    ▼
             reaches bottom
                    │
                    ▼
             ┌──────────────┐
             │    STICKY    │
             └──────────────┘
8. User Scroll

User scroll and programmatic scroll must be separate.

function onUserScroll(delta: number) {
  const nextOffset = clampOffset(
    state.offsetY + delta,
    state.maxOffsetY,
  );

  state.offsetY = nextOffset;

  state.userScrolled = true;

  state.lastScrollDirection =
    delta < 0
      ? "up"
      : delta > 0
        ? "down"
        : null;

  state.distanceFromBottom =
    state.maxOffsetY - state.offsetY;

  state.isAtBottom =
    state.distanceFromBottom <= BOTTOM_EPSILON;

  if (state.isAtBottom) {
    state.sticky = true;
  } else {
    state.sticky = false;
  }
}
9. Content Growth

This is the most important algorithm.

User at bottom
content = 1000
viewport = 100
max = 900
offset = 900
sticky = true

New content:

content = 1100
max = 1000

Expected:

offset = 1000

The viewport follows the agent.

Detached user
content = 1000
viewport = 100
max = 900
offset = 700
sticky = false

New content:

content = 1100
max = 1000

Expected:

offset = 700

Never jump to 1000.

The user is reading history.

10. Content-Height Update
function updateContentHeight(nextHeight: number) {
  const wasAtBottom = state.isAtBottom;

  state.contentHeight =
    Math.max(0, nextHeight);

  state.maxOffsetY =
    Math.max(
      0,
      state.contentHeight -
        state.viewportHeight,
    );

  if (state.sticky && wasAtBottom) {
    state.offsetY = state.maxOffsetY;
  } else {
    state.offsetY = clampOffset(
      state.offsetY,
      state.maxOffsetY,
    );
  }

  state.distanceFromBottom =
    state.maxOffsetY - state.offsetY;

  state.isAtBottom =
    state.distanceFromBottom <=
    BOTTOM_EPSILON;
}
11. scrollToBottom()
function scrollToBottom() {
  state.offsetY = state.maxOffsetY;

  state.isAtBottom = true;
  state.sticky = true;
  state.userScrolled = false;

  state.distanceFromBottom = 0;
}

This is the explicit "I want to follow the current output" operation.

12. scrollToTop()
function scrollToTop() {
  state.offsetY = 0;

  state.isAtTop = true;
  state.isAtBottom =
    state.maxOffsetY === 0;

  state.sticky = false;
  state.userScrolled = true;

  state.distanceFromBottom =
    state.maxOffsetY;
}
13. Keyboard Scrolling

Support:

Key	Action
↑	line up
↓	line down
PageUp	page up
PageDown	page down
Home	top
End	bottom
Ctrl+Home	transcript top
Ctrl+End	transcript bottom

Constants:

const LINE_SCROLL = 1;

const PAGE_SCROLL_RATIO = 0.85;

Page size:

const pageSize = Math.max(
  1,
  Math.floor(
    viewportHeight *
      PAGE_SCROLL_RATIO,
  ),
);
14. Mouse Wheel

Normalize terminal-specific wheel input before passing it to the controller.

function onWheel(deltaY: number) {
  scrollController.onUserScroll(
    normalizeWheelDelta(deltaY),
  );
}

Example:

function normalizeWheelDelta(
  delta: number,
): number {
  const magnitude =
    Math.max(1, Math.abs(delta));

  return (
    Math.sign(delta) * magnitude
  );
}

Tune the actual scale using real terminals.

15. Mouse + Sticky Behavior

Mouse wheel up:

wheel ↑
 ↓
offset decreases
 ↓
not at bottom
 ↓
sticky = false

Mouse wheel down:

wheel ↓
 ↓
offset increases
 ↓
reaches maxOffset
 ↓
isAtBottom = true
 ↓
sticky = true
16. New Activity Indicator

When detached:

                    ↓ New activity

or:

                    ↓ 12 new events

Only display it when:

const showIndicator =
  !scrollState.isAtBottom &&
  pendingActivityCount > 0;

Selecting it:

scrollController.scrollToBottom();

which automatically restores sticky mode.

17. Streaming Responses
Wrong
onToken(() => {
  scrollToBottom();
});

This causes:

fighting with user scrolling
jitter
excessive scroll operations
excessive layout work
inability to read older output
Correct
model token
   ↓
assistant message update
   ↓
layout
   ↓
content height
   ↓
scroll controller
   ↓
sticky?
 ┌───────┴───────┐
 YES             NO
  ↓               ↓
bottom         preserve
18. Streaming Batching

Do not force a terminal layout/scroll for every token.

Instead:

token 1
token 2
token 3
token 4
   ↓
batched update
   ↓
layout
   ↓
scroll correction
   ↓
render

Conceptually:

let updateScheduled = false;

function requestTranscriptUpdate() {
  if (updateScheduled) {
    return;
  }

  updateScheduled = true;

  queueMicrotask(() => {
    updateScheduled = false;

    updateTranscriptLayout();
    scrollController.maybeFollowBottom();
  });
}

If the renderer exposes a frame scheduler, prefer frame scheduling.

19. maybeFollowBottom()
function maybeFollowBottom() {
  if (!state.sticky) {
    return;
  }

  state.offsetY = state.maxOffsetY;
  state.isAtBottom = true;
  state.distanceFromBottom = 0;
}

Only perform an actual renderer scroll if the offset changed.

20. User Intent Has Priority

This is critical.

If these occur together:

agent token
user scroll up
agent token

the second token must not pull the user back down.

Priority:

1. Explicit user scroll
2. Explicit scroll-to-bottom
3. Modal interaction
4. Layout correction
5. Streaming auto-follow

Automatic behavior must never override user intent.

21. Terminal Resize

Resize flow:

terminal resize
      ↓
root dimensions
      ↓
layout
      ↓
terminal width changes
      ↓
text wrapping changes
      ↓
message heights change
      ↓
content height changes
      ↓
ScrollController
22. Resize While Sticky

If:

sticky = true

then after resize:

offsetY =
  newMaxOffsetY;

The user remains at the bottom.

23. Resize While Detached

If:

sticky = false

do not automatically jump to bottom.

At minimum:

offsetY = clampOffset(
  offsetY,
  newMaxOffsetY,
);

For maximum quality, implement anchor preservation.

24. Anchor Preservation

Numeric offsets are not always sufficient.

Example:

User is viewing:

Message 42
Message 43  ← visible anchor
Message 44

Then terminal width changes.

Message 42 becomes taller because of wrapping.

If only the numeric offset is preserved, the visible content jumps.

Use:

interface ScrollAnchor {
  itemId: string;
  relativeOffset: number;
}

Before layout:

visible item = message-43
relative row = 6

After layout:

find message-43
restore it at row 6

This is especially useful for:

terminal resize
markdown reflow
expanded activities
collapsed activities
content above the viewport changing size
25. Transcript Model

Do not render every raw event.

Use:

type ConversationItem =
  | UserMessage
  | AssistantMessage
  | ActivityGroup
  | Plan
  | PermissionRequest
  | ErrorMessage;
26. Activity Groups
interface ActivityGroup {
  id: string;

  kind:
    | "read"
    | "search"
    | "command"
    | "edit"
    | "verification"
    | "git"
    | "planning"
    | "subagent"
    | "mcp";

  count: number;

  status:
    | "running"
    | "completed"
    | "failed";

  durationMs?: number;

  expanded: boolean;

  items: ActivityItem[];
}
27. Activity Aggregation

Instead of:

tool.started
stdout
stdout
stdout
stdout
tool.finished

render:

⟳ Running tests...

then:

✓ Ran tests · 27 passed

Expansion:

▼ Ran 5 commands

    $ pnpm test
    $ pnpm build
    $ pnpm lint
    $ pnpm typecheck
    $ git diff --check
28. Expansion + Scroll

If user is at bottom:

expand activity
 ↓
content grows
 ↓
remain at bottom

If user is detached:

expand activity
 ↓
content grows
 ↓
do not jump

Use anchor preservation if the changed item is above the viewport.

29. Raw Tool Output

Keep raw output internally:

tool input
stdout
stderr
metadata
timing

But don't permanently create a transcript node for every chunk.

Use:

raw events
 ↓
activity aggregation
 ↓
summary

Large raw output should be truncated and only displayed on demand.

30. Long Sessions

A session might generate:

100,000 raw events

but the visible transcript should remain much smaller:

User messages
Assistant messages
Plans
Activity groups
Errors
Permissions

Architecture:

100,000 raw events
       ↓
Event Normalizer
       ↓
Activity Aggregator
       ↓
~500 meaningful UI items
       ↓
ScrollBox

This is one of the most important defenses against the messy:

queued: f
queued: f
queued: df
policy...
Thinking...
Ran npm...

problem.

31. Viewport Rendering

The supplied Cline research reports viewport culling in the OpenTUI ScrollBox.

For Klyro, verify the actual renderer implementation before treating this as a guaranteed virtualization mechanism.

Your implementation research must determine:

Does culling mean:

[ ] not painted
[ ] not rendered
[ ] not laid out
[ ] not mounted
[ ] not parsed
[ ] not syntax-highlighted

These are different things.

If the selected renderer does not provide sufficient optimization, introduce Klyro-level transcript windowing.

32. Transcript Windowing

For extremely large conversations:

interface TranscriptWindow {
  firstVisibleIndex: number;
  lastVisibleIndex: number;

  overscanBefore: number;
  overscanAfter: number;
}

Conceptually:

       overscan
┌─────────────────┐
│ message         │
│ message         │
├─────────────────┤
│ VISIBLE         │
│ message         │
│ message         │
│ message         │
├─────────────────┤
│ message         │
│ message         │
└─────────────────┘
       overscan

Do not build complex virtualization before profiling.

33. Scroll Adapter

Keep the scroll controller independent of OpenTUI.

export interface ScrollViewportAdapter {
  getViewportHeight(): number;
  getContentHeight(): number;
  getScrollOffset(): number;

  setScrollOffset(
    offset: number,
  ): void;

  scrollBy(delta: number): void;
}

Architecture:

ScrollController
       ↓
ScrollViewportAdapter
       ↓
OpenTUI ScrollBox

This lets Klyro change renderer later.

34. OpenTUI Integration

If OpenTUI is selected:

<ScrollBox
  stickyScroll
  stickyStart="bottom"
>
  <Transcript />
</ScrollBox>

The supplied research describes Cline's chat transcript as being centered around a ScrollBox, with sticky-bottom behavior and keyboard/mouse scrolling.

But Klyro should still own:

ScrollState
ScrollController
Activity Aggregation
Transcript State
User Intent

The renderer should not become the source of truth for agent semantics.

35. Event Model

Agent events:

type KlyroEvent =
  | {
      type: "assistant.delta";
      messageId: string;
      text: string;
    }
  | {
      type: "tool.started";
      toolId: string;
      toolName: string;
    }
  | {
      type: "tool.finished";
      toolId: string;
      status: "success" | "failed";
    }
  | {
      type: "file.changed";
      path: string;
    }
  | {
      type: "verification.started";
    }
  | {
      type: "verification.finished";
      success: boolean;
    };
36. UI Scroll Events
type UIEvent =
  | {
      type: "scroll";
      source: "keyboard" | "mouse";
      deltaY: number;
    }
  | {
      type: "scroll.toBottom";
    }
  | {
      type: "scroll.toTop";
    }
  | {
      type: "terminal.resize";
      width: number;
      height: number;
    };

Agent events and scroll events must remain conceptually separate.

37. Reducer
function reduceScroll(
  state: ScrollState,
  event: UIEvent,
): ScrollState {
  switch (event.type) {
    case "scroll":
      return userScroll(
        state,
        event.deltaY,
      );

    case "scroll.toBottom":
      return {
        ...state,
        offsetY: state.maxOffsetY,
        isAtBottom: true,
        sticky: true,
        userScrolled: false,
        distanceFromBottom: 0,
      };

    case "scroll.toTop":
      return {
        ...state,
        offsetY: 0,
        isAtTop: true,
        isAtBottom:
          state.maxOffsetY === 0,
        sticky: false,
        userScrolled: true,
        distanceFromBottom:
          state.maxOffsetY,
      };

    default:
      return state;
  }
}
38. Input Isolation

Input state:

interface InputState {
  draft: string;

  cursor: number;

  selection?: {
    start: number;
    end: number;
  };

  autocomplete?: AutocompleteState;
}

Never allow:

draft
queued text
autocomplete
cursor state

to become transcript messages.

39. Permission Dialogs

When a permission prompt appears:

Transcript
     ↓
Permission Overlay

Do not destroy or reset scroll state.

After approval:

Permission closes
     ↓
restore transcript
     ↓
continue agent

If the user was detached, preserve that position.

40. Modal Scroll Isolation

If a modal has its own scrollable content:

Root
├── Transcript ScrollBox
└── Modal
    └── Modal ScrollBox

Mouse events must be routed to the active scroll context.

Do not allow modal scrolling to accidentally scroll the transcript underneath it.

41. Scrollbar

A scrollbar is optional but useful for long transcripts.

Example:

│
│
█
│
│

Keep it subtle.

If terminal width is too small:

hide scrollbar

rather than sacrificing useful transcript width.

42. Scrollbar Interaction

If mouse support is available:

click scrollbar
drag thumb

should update:

offsetY

Dragging upward:

sticky = false;

Dragging to bottom:

sticky = true;
43. Smooth Scrolling

Do not implement smooth animation initially.

For a coding CLI:

correctness > animation

Immediate scrolling is simpler and more reliable.

If smooth scrolling is added later, it must not interfere with:

streaming
resize
Ctrl+C
input
permission dialogs
44. Ctrl+C

Ctrl+C while streaming:

Ctrl+C
 ↓
abort model/tool
 ↓
finish current UI state
 ↓
preserve transcript
 ↓
stop streaming

Do not:

clear conversation
reset scroll

automatically.

45. Session Resume

On session resume:

load session
 ↓
restore transcript
 ↓
layout
 ↓
measure content
 ↓
scroll to bottom
 ↓
sticky=true

Default behavior should be bottom-of-session because the user is returning to the active conversation.

Viewport position does not need to be persisted initially.

46. /clear vs Terminal Clear

Keep these concepts separate.

terminal clear

means:

redraw terminal

while:

/clear

should have explicit conversation semantics.

Never accidentally delete session history because a screen-clear operation was triggered.

47. Performance
Never do this
onEveryToken(() => {
  setState(...);
  scrollToBottom();
  renderEverything();
});
Prefer
token batching
      ↓
incremental state
      ↓
layout
      ↓
single scroll correction
      ↓
render frame
48. Memoization

Completed messages should not rerender whenever the current streaming message changes.

Conceptually:

const Message = memo(
  function Message(props) {
    return ...;
  },
);

Only the active streaming message should update frequently.

Likewise:

completed activity

should not rerender because:

current command

is changing.

49. Streaming Message
interface AssistantMessage {
  id: string;
  content: string;
  streaming: boolean;
}

While:

streaming === true

updates can be frequent.

After:

streaming === false

the message becomes stable.

50. Content Height

Never estimate content height with:

text.length / terminalWidth

That fails for:

markdown
code
diffs
padding
nested components
wrapping
syntax highlighting
activity groups

Get actual layout measurements from the renderer/layout layer.

51. Layout Change Pipeline

Every dynamic content change follows:

state change
     ↓
layout
     ↓
new content dimensions
     ↓
ScrollController
     ↓
sticky OR preserve

This applies to:

assistant streaming
markdown
code
diffs
activity expansion
activity collapse
plans
todos
permissions
errors
52. Scroll Lock

Provide an internal mechanism:

scrollLock: boolean;

Useful during:

anchor restoration
controlled layout changes
modal transitions
viewport restoration

Always release it:

try {
  ...
} finally {
  scrollLock = false;
}

Never leave scrolling permanently locked because of an exception.

53. Debug Mode

During development, expose:

SCROLL DEBUG

offset:       821
viewport:      42
content:     1298
maxOffset:   1256
distance:     435
sticky:     false
atBottom:    false
atTop:       false

Enable with something like:

KLYRO_DEBUG_TUI=1

or:

/debug tui

Do not display this during normal use.

54. Scroll Invariants

At all times:

offsetY >= 0;
offsetY <= maxOffsetY;

maxOffsetY >= 0;

viewportHeight >= 0;
contentHeight >= 0;

distanceFromBottom >= 0;

And:

maxOffsetY =
  Math.max(
    0,
    contentHeight -
      viewportHeight,
  );

And:

distanceFromBottom =
  maxOffsetY - offsetY;

And:

isAtBottom =
  distanceFromBottom <=
  BOTTOM_EPSILON;
55. Critical Behavioral Tests
Test 1 — Streaming at bottom
content = 100
viewport = 20
offset = 80
sticky = true

content → 120

Expected:

offset = 100
sticky = true
Test 2 — Streaming while reading history
content = 100
viewport = 20
offset = 50
sticky = false

content → 120

Expected:

offset = 50
sticky = false
Test 3 — User reaches bottom
offset = 50
maxOffset = 100
sticky = false

user scrolls +50

Expected:

offset = 100
sticky = true
isAtBottom = true
Test 4 — User scrolls upward
offset = 100
sticky = true

user scrolls -20

Expected:

offset = 80
sticky = false
isAtBottom = false
Test 5 — Resize while sticky
sticky = true

Resize.

Expected:

offset = newMaxOffset
Test 6 — Resize while detached
sticky = false
offset = 50

Resize.

Expected:

do not jump to bottom
56. PTY Integration Tests

The supplied research describes Cline testing the actual terminal UI through PTY-based infrastructure rather than only testing abstract component state.

Klyro should eventually test:

Test Process
     ↓
PTY
     ↓
Klyro
     ↓
Real keyboard/mouse input
     ↓
Terminal rendering
     ↓
Terminal frame
     ↓
Assertions

Example:

start Klyro
 ↓
send prompt
 ↓
stream response
 ↓
assert bottom following
 ↓
scroll up
 ↓
continue streaming
 ↓
assert viewport remains stable
 ↓
scroll down
 ↓
assert sticky resumes
57. Long-Session Stress Test

Generate:

10,000+ events

Then test:

scroll top
scroll middle
scroll bottom
resize
stream
expand activity
collapse activity

Measure:

memory
CPU
input latency
scroll latency
render latency
streaming latency
resize latency

The Cline research specifically identifies viewport-oriented rendering as important for long agent sessions.

58. Race Condition Test

Simulate:

agent token
+
user scroll
+
terminal resize
+
activity completion

in the same period.

Expected:

explicit user scroll wins

Never allow:

agent token
 ↓
scroll bottom
 ↓
user scroll up
 ↓
next token
 ↓
scroll bottom

because the user becomes unable to read history.

59. Recommended Module Structure
packages/cli/src/tui/
│
├── app.tsx
│
├── transcript/
│   ├── transcript.tsx
│   ├── transcript-state.ts
│   ├── transcript-reducer.ts
│   ├── message.tsx
│   └── activity-group.tsx
│
├── scroll/
│   ├── scroll-controller.ts
│   ├── scroll-state.ts
│   ├── scroll-events.ts
│   ├── scroll-adapter.ts
│   └── __tests__/
│       └── scroll-controller.test.ts
│
├── activity/
│   ├── activity-aggregator.ts
│   └── activity-types.ts
│
├── input/
│   ├── input.tsx
│   └── input-state.ts
│
└── layout/
    └── dimensions.ts
60. Complete Runtime Flow
                    AGENT
                      │
                      ▼
                 Event Stream
                      │
                      ▼
               Event Normalizer
                      │
             ┌────────┴────────┐
             ▼                 ▼
       Conversation        Activity
          Reducer          Aggregator
             │                 │
             └────────┬────────┘
                      ▼
               Transcript State
                      │
                      ▼
                 TUI Renderer
                      │
                      ▼
                    Layout
                      │
                      ▼
              Content Measurement
                      │
                      ▼
               Scroll Controller
                      │
               ┌──────┴──────┐
               ▼             ▼
            STICKY        DETACHED
               │             │
               ▼             ▼
        Follow bottom    Preserve offset
61. Complete Streaming Flow
Model token
    ↓
assistant.delta
    ↓
Conversation reducer
    ↓
streaming message updated
    ↓
layout recalculation
    ↓
content height changed
    ↓
ScrollController
    ↓
sticky?
   / \
 YES  NO
  │    │
  ▼    ▼
bottom preserve
  │    │
  └─┬──┘
    ▼
render frame
62. Complete User-Scroll Flow
Agent streaming
      ↓
sticky = true
      ↓
User scrolls ↑
      ↓
onUserScroll(-delta)
      ↓
offset decreases
      ↓
isAtBottom = false
      ↓
sticky = false
      ↓
Agent continues streaming
      ↓
content grows
      ↓
offset remains stable

Then:

User scrolls ↓
      ↓
offset increases
      ↓
offset == maxOffset
      ↓
isAtBottom = true
      ↓
sticky = true
      ↓
future content follows bottom
63. Do Not Implement This
❌ Effect-based auto-scroll
useEffect(() => {
  scrollRef.current?.scrollToBottom();
}, [messages]);

Why:

messages changed
 ↓
always bottom

This destroys manual scrolling.

❌ Streaming-based scrolling
if (agentIsStreaming) {
  scrollToBottom();
}

Wrong.

Correct:

if (scrollState.sticky) {
  scrollToBottom();
}
❌ Timer-based scrolling
setInterval(
  scrollToBottom,
  100,
);

This fights user input.

❌ Raw event transcript
tool.stdout
tool.stdout
tool.stdout
tool.stdout
tool.stdout

Aggregate them.

64. Final Klyro UX

Normal:

KLYRO v0.x
model · ~/project
────────────────────────────────────────────────────────────

You
Add authentication.

Klyro
I'll inspect the authentication system first.

✓ Read 14 files
✓ Searched 38 files
⟳ Running tests...

The authentication flow is implemented...

✓ Modified 6 files
✓ 27 tests passed

────────────────────────────────────────────────────────────
› Message Klyro...
────────────────────────────────────────────────────────────
enter send · shift+enter newline                $0.03 · 8%

User scrolls upward:

────────────────────────────────────────────────────────────
│ older conversation
│
│ ✓ Read 14 files
│
│ previous response
│
│
│
│                                  ↓ New activity
────────────────────────────────────────────────────────────
› Message Klyro...

Agent continues working, but the viewport does not move.

User reaches bottom:

user scroll ↓
       ↓
bottom
       ↓
sticky = true
       ↓
future output follows
65. Definition of Done

The scroll system is complete only when:

[✓] Keyboard scrolling
[✓] Mouse scrolling
[✓] PageUp/PageDown
[✓] Home/End
[✓] Sticky-bottom behavior
[✓] Sticky disabled after manual scroll
[✓] Sticky restored at bottom
[✓] Streaming support
[✓] Activity aggregation
[✓] Expand/collapse support
[✓] Fixed input area
[✓] Terminal resize
[✓] Position preservation
[✓] Anchor preservation where needed
[✓] Scrollbar
[✓] New-activity indicator
[✓] Modal scroll isolation
[✓] Ctrl+C safety
[✓] Session resume
[✓] Long-session handling
[✓] Event batching
[✓] Message memoization
[✓] Renderer abstraction
[✓] Unit tests
[✓] Integration tests
[✓] PTY tests
[✓] Stress tests
66. The Most Important Rule

Everything ultimately comes down to:

if (scrollState.sticky) {
  followBottom();
} else {
  preserveUserPosition();
}

But sticky must represent actual user viewport intent, not merely:

agentIsStreaming

or:

messages.length changed

The professional behavior is:

             USER
              │
              ▼
       controls viewport
              │
       ┌──────┴──────┐
       ▼             ▼
    at bottom     scrolled up
       │             │
       ▼             ▼
   auto-follow    stay still
       │             │
       └──────┬──────┘
              ▼
        new content

That is the scroll implementation Klyro should build.