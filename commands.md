# Klyro — Complete Command Roadmap

A consolidated roadmap covering your commands, recommended additions, aliases, and missing capabilities.

**Important additions:** authentication, cancellation/retry, explicit context attachments, workspace trust, formatting/type-checking, tool inspection, resource budgets, audit logs, and backup/restore.

**Legend**

- **NEW** — recommended addition to your roadmap.
- `<argument>` — required argument.
- `[argument]` — optional argument.
- Aliases are listed separately and should share the same implementation.
- This is a **proposed Klyro interface**, not a verified command inventory for other products.

---

## 🟢 Priority 1 — Core / Build Now

These capabilities make Klyro a usable, reliable coding agent.

### Session & Conversation

| Command | Purpose |
|---|---|
| `/help [command]` | Show available commands or help for a specific command. |
| `/clear` | Clear active conversation context without deleting saved history or changing project files. |
| `/new [name]` | Start a separate session with a new session ID. |
| `/exit` | Exit cleanly and explain what happens to active tasks. |
| `/compact [focus]` | Summarize active context while preserving important instructions, decisions, and task state. |
| `/resume [session]` | Resume a saved session; show a picker when omitted. |
| `/sessions` | List, search, and switch sessions. |
| `/rename [name]` | Rename the current session. |
| `/fork [prompt]` | Create an independent session from the current conversation point. |
| `/branch [name]` | Create or switch a named conversation branch—not a Git branch. |
| `/export [file]` | Export the conversation to a supported local format, such as Markdown or JSON. |
| `/copy [n]` | Copy the latest assistant response or a response selected by index. |
| `/cancel` **NEW** | Request cancellation of the current foreground agent turn and its cancellable tools. |
| `/retry [step]` **NEW** | Retry a failed or interrupted step after checking permissions and possible prior side effects. |
| `/version` **NEW** | Show Klyro version, build information, and relevant runtime details. |

### Model, Provider & Authentication

| Command | Purpose |
|---|---|
| `/model [id]` | Show or switch the active model. |
| `/models [provider]` | List available models and supported capabilities. |
| `/provider [name]` | Show or switch the active provider. |
| `/effort [level]` | Set reasoning effort using `low`, `medium`, `high`, or `max`. |
| `/fast [state]` | Show or set fast mode using `on` or `off`, when supported. |
| `/login [provider]` **NEW** | Start the provider’s supported authentication or credential-configuration flow. |
| `/logout [provider]` **NEW** | Remove locally stored authentication for a provider; distinguish this from remote token revocation. |
| `/auth [action]` **NEW** | Inspect or test authentication without exposing credentials. |

### Project & Context

| Command | Purpose |
|---|---|
| `/init` | Analyze the repository and propose or create `KLYRO.md`; never silently overwrite existing instructions. |
| `/status` | Show session, model, provider, project, Git, permission, and execution status. |
| `/context` | Show context usage, limits, major contributors, and available headroom. |
| `/diff [target]` | Show the current Git diff or a selected file/change scope. |
| `/plan [task]` | Show the current plan; with a task, create or refine a plan without applying code changes. |
| `/todos` | Show actual autonomous task state: pending, running, blocked, completed, and failed. |
| `/memory [action]` | View or edit persistent memory with explicit session, project, or user scope. |
| `/add-dir <path>` | Add a working directory after validating its scope and trust settings. |
| `/cd <path>` | Change the active project directory and reload applicable project configuration. |
| `/attach <path-or-reference>` **NEW** | Attach a file, directory, image, or supported reference to conversation context. |
| `/detach <reference>` **NEW** | Remove an attached context reference without deleting the source. |
| `/files` **NEW** | Show attached files, additional directories, and active context sources. |
| `/search <query>` **NEW** | Search the repository; optionally select conversation or memory scope. |
| `/instructions [action]` **NEW** | Inspect instruction sources, precedence, and editable `KLYRO.md` files. |

### Permissions & Safety

| Command | Purpose |
|---|---|
| `/permissions [action]` | Inspect and manage allow, ask, and deny rules. |
| `/mode [name]` | Show or change Klyro’s permission-mode abstraction. |
| `/sandbox [policy]` | Inspect or select a sandbox policy supported by the host environment. |
| `/approve [request-id]` | Approve a specific pending action within existing policy limits; default to one-time approval. |
| `/deny [request-id]` | Explicitly deny a pending action. |
| `/trust [path]` **NEW** | Inspect, grant, or revoke workspace trust for instructions, configuration, and extensions. |

### Core Configuration

| Command | Purpose |
|---|---|
| `/config [action]` | View, edit, or reset configuration with explicit user/project/session scope. |

**Core aliases:** `/quit` → `/exit`; `/settings` → `/config`.

---

## 🟡 Priority 2 — Professional Klyro

These capabilities turn the CLI into a professional engineering harness.

### Developer Workflow

| Command | Purpose |
|---|---|
| `/review [target]` | Review current changes, files, commits, or another supported target. |
| `/code-review [options]` | Perform a deeper review with structured findings, severity, and supporting evidence. |
| `/security-review [target]` | Review security-sensitive code, configuration, dependencies, and changes. |
| `/simplify [target]` | Simplify or refactor code while preserving intended behavior. |
| `/verify [target]` | Run relevant build, test, and runtime checks; report evidence, failures, and skipped checks. |
| `/test [target]` | Run relevant tests or a selected suite. |
| `/lint [target]` | Run the project’s configured lint checks. |
| `/build [target]` | Run the configured project build. |
| `/run [command]` | Run an application target or an explicitly authorized command. |
| `/format [target]` **NEW** | Run the project’s configured formatter. |
| `/typecheck [target]` **NEW** | Run static type checking separately from linting and building. |
| `/coverage [target]` **NEW** | Run coverage checks and identify important untested changes. |
| `/commit [message]` **NEW** | Preview and create a Git commit from explicitly selected or staged changes. |
| `/pr [action]` **NEW** | View, create, update, or inspect checks for a pull/merge request through a configured integration. |

### Change Recovery

| Command | Purpose |
|---|---|
| `/undo [n]` | Undo recent Klyro-managed changes using the change journal or checkpoints. |
| `/redo [n]` | Reapply changes previously undone by Klyro. |
| `/rewind [checkpoint]` | Restore conversation state, code state, or both after previewing the affected scope. |
| `/checkpoint [action]` | Create or manage recoverable checkpoints; without arguments, create one. |

### Tool Activity & Output

| Command | Purpose |
|---|---|
| `/details [state]` | Toggle detailed tool-execution activity. |
| `/verbose [state]` | Toggle additional operational explanations and diagnostics—not private model reasoning. |
| `/raw [task-id]` | Show unformatted captured tool output; retain secret redaction by default. |
| `/activity` | Show what the agent is currently doing and which operation it is waiting on. |

**Example compact activity display:**

```text
✓ Read 14 files
✓ Ran 4 commands
✓ Modified 6 files
```

These counts must come from actual recorded operations. `/details` expands the summary into individual events.

### Tasks, Processes & Execution Controls

| Command | Purpose |
|---|---|
| `/tasks [filter]` | Show background jobs, subagent work, and their actual execution state. |
| `/ps [filter]` | Show Klyro-managed background processes and terminals. |
| `/stop [id]` | Stop a selected background task or process; without an ID, show a picker rather than stopping everything. |
| `/queue [action]` | Inspect, add, remove, or clear queued prompts and actions. |
| `/background [task]` | Start a task in the background or offer supported backgrounding options for current work. |
| `/pause [task-id]` **NEW** | Pause supported work at a safe boundary. |
| `/continue [task-id]` | Continue paused or interrupted work in the current session. |

### MCP & Tool Management

| Command | Purpose |
|---|---|
| `/mcp [action]` | Inspect and manage MCP servers, connections, authentication, and exposed tools. |
| `/tools [action]` **NEW** | Inspect built-in and external tools, their capabilities, availability, and permission requirements. |

#### MCP Subcommands

| Command | Purpose |
|---|---|
| `/mcp list` | List configured servers. |
| `/mcp status [name]` | Show connection and health status. |
| `/mcp add <name>` | Add a server through a validated configuration flow. |
| `/mcp remove <name>` | Remove a server configuration. |
| `/mcp enable <name>` | Enable a configured server. |
| `/mcp disable <name>` | Disable a server and prevent new calls. |
| `/mcp reconnect <name>` | Re-establish a server connection. |
| `/mcp auth <name>` | Configure or refresh supported server authentication. |
| `/mcp tools [name]` | List tools exposed by one or all servers. |
| `/mcp logs [name]` | Inspect redacted server and connection logs. |

### Agents & Subagents

| Command | Purpose |
|---|---|
| `/agents [action]` | List, create, inspect, and manage agent definitions. |
| `/agent [name]` | Show or switch the active agent. |
| `/subagents [action]` | Inspect and manage spawned subagents. |
| `/subtask <task>` | Delegate a bounded task to a subagent with explicit scope and permissions. |

**Shared commands:** agents use the same `/tasks`, `/background`, `/pause`, `/continue`, and `/stop` systems. Do not implement competing task registries.

### Interface & Advanced Configuration

| Command | Purpose |
|---|---|
| `/editor [target]` | Open the prompt, a file, or supported content in the configured external editor. |
| `/keymap [action]` | Inspect or configure keyboard shortcuts. |
| `/vim [state]` | Show or toggle Vim-style input mode. |
| `/theme [name]` | Show, preview, or select a theme. |
| `/statusline [action]` | Configure status-bar fields and presentation. |
| `/profile [name]` **NEW** | Manage named combinations of provider, model, effort, and other settings. |
| `/reload [scope]` **NEW** | Reload configuration, instructions, or tool definitions without restarting the session. |

### Diagnostics & Maintenance

| Command | Purpose |
|---|---|
| `/doctor` | Run actionable environment, configuration, authentication, and integration health checks. |
| `/debug [action]` | Inspect or toggle debugging facilities and effective configuration. |
| `/diagnostics [file]` | Generate a redacted diagnostic report for local inspection or deliberate sharing. |
| `/logs [target]` | View or follow application, session, tool, or provider logs. |
| `/audit [filter]` **NEW** | Inspect recorded approvals, denials, tool calls, configuration changes, and other security-relevant events. |
| `/update [version]` **NEW** | Check for or install updates through the supported installation method. |

### Usage, Cost & Resource Controls

| Command | Purpose |
|---|---|
| `/usage [scope]` | Show token, request, tool, and execution usage by session, project, or provider. |
| `/cost [scope]` | Show estimated costs and distinguish them from provider-reported billed costs. |
| `/budget [action]` **NEW** | Configure token or spending budgets and their warning/enforcement behavior. |
| `/limits [action]` **NEW** | Configure runtime, iteration, tool-call, and concurrency limits. |

**Recommendation:** ship usage visibility and resource controls before unattended autonomous execution—not after cloud features.

---

## 🔴 Priority 3 — Advanced / Future Klyro

These belong after the local harness, permissions, recovery, and task systems are reliable.

### Advanced Session Management

| Command | Purpose |
|---|---|
| `/archive [session]` | Hide a session from the active list without deleting it. |
| `/delete [session]` | Permanently delete selected session data after explicit confirmation. |
| `/recap [scope]` | Summarize progress, decisions, unresolved questions, and next steps without replacing context. |
| `/history [query]` | Browse or search durable conversation and command history. |

`/sessions`, `/resume`, `/rename`, `/branch`, and `/fork` remain Priority 1; they do not need duplicate roadmap entries here.

### Autonomous Execution

| Command | Purpose |
|---|---|
| `/goal [task]` | Define or inspect a persistent objective with acceptance criteria and execution limits. |
| `/loop [task]` | Run a bounded repeat/check/improve loop with explicit stopping conditions. |
| `/schedule [action]` | Manage scheduled tasks with visible timing, permissions, budgets, and cancellation controls. |
| `/notifications [action]` **NEW** | Configure completion, failure, approval-needed, and budget notifications. |

### Remote, Cloud & Workspace Isolation

| Command | Purpose |
|---|---|
| `/remote [action]` | Manage connections to remote execution environments. |
| `/remote-control [action]` | Start, inspect, or stop authenticated remote control of a Klyro session. |
| `/handoff [destination]` **NEW** | Transfer supported session/task state between execution environments. |
| `/cloud [action]` | Submit and manage cloud-executed jobs. |
| `/cloud-environment [action]` | Manage cloud execution environments and their configuration. |
| `/local` | Select local execution without silently cancelling existing remote jobs. |
| `/worktree [action]` | Create, list, switch, and safely remove Git worktrees for isolated work. |

**Naming recommendation:** use `/handoff` as Klyro’s canonical command. `/teleport` can be an optional compatibility alias.

### Import, Backup & Recovery

| Command | Purpose |
|---|---|
| `/import [source]` | Preview and import supported sessions or configuration, reporting unsupported fields. |
| `/backup [file]` **NEW** | Back up selected sessions, memory, and configuration; exclude credentials by default. |
| `/restore <file>` **NEW** | Preview and restore a backup with explicit merge/overwrite behavior. |

#### Import Sources

| Command | Purpose |
|---|---|
| `/import session <file>` | Import a supported Klyro session export. |
| `/import claude [path]` | Migrate supported Claude-related configuration or session data. |
| `/import codex [path]` | Migrate supported Codex-related configuration or session data. |
| `/import opencode [path]` | Migrate supported OpenCode-related configuration or session data. |
| `/import gemini [path]` | Migrate supported Gemini-related configuration or session data. |

Imports should be **format-validated and previewed**. Imported instructions, hooks, plugins, and credentials must not become trusted or active automatically.

### Extensibility & Integrations

| Command | Purpose |
|---|---|
| `/plugins [action]` | Discover, install, inspect, update, enable, disable, and remove plugins. |
| `/skills [action]` | Manage and explicitly invoke reusable skills or workflow packages. |
| `/hooks [action]` | Manage lifecycle hooks with visible execution and permission requirements. |
| `/commands [action]` **NEW** | Manage custom user/project slash commands and their definitions. |
| `/apps [action]` | Manage supported external application integrations. |
| `/ide [action]` | Connect, inspect, or disconnect IDE integrations. |
| `/ide-context [action]` | Inspect and control context supplied by an IDE. |

Custom and plugin commands should use namespaces and must not override safety-critical built-ins.

### Indexing & Storage Maintenance

| Command | Purpose |
|---|---|
| `/index [action]` **NEW** | Inspect, build, rebuild, or clear an optional repository search index. |
| `/cache [action]` **NEW** | Inspect, prune, or clear disposable caches. |
| `/cleanup [scope]` **NEW** | Preview removal of disposable artifacts; require explicit application and protect project source files. |

### Sharing, Feedback & Experimental Features

| Command | Purpose |
|---|---|
| `/share [session]` | Preview redaction and explicitly publish selected session content with visible access settings. |
| `/unshare [share-id]` | Revoke future access to a shared resource; explain that existing copies cannot be recalled. |
| `/feedback [message]` | Submit deliberate feedback without attaching repository or session contents automatically. |
| `/experimental [action]` | Inspect and explicitly enable or disable experimental features. |

---

## Command Aliases

Aliases should resolve to the same parser, handler, permissions, help entry, and telemetry event as their canonical command.

| Alias | Canonical Command | Priority |
|---|---|---|
| `/quit` | `/exit` | P1 |
| `/settings` | `/config` | P1 |
| `/reasoning` | `/effort` | P1 — optional compatibility |
| `/mention` | `/attach` | P1 — optional compatibility |
| `/keybindings` | `/keymap` | P2 — optional compatibility |
| `/themes` | `/theme list` | P2 — optional compatibility |
| `/debug-config` | `/debug config` | P2 — optional compatibility |
| `/teleport` | `/handoff` | P3 — optional compatibility |

---

## Recommended Subcommand Structure

Use subcommands for management operations rather than creating dozens of additional top-level commands.

The entries below follow `/command operation ...`. Bare commands retain the defaults described above.

### Core Command Families

| Command Family | Recommended Operations |
|---|---|
| `/sessions` | `list`, `search <query>`, `switch <id>` |
| `/branch` | `list`, `create <name>`, `switch <name>` |
| `/provider` | `list`, `setup <name>`, `add <name>`, `remove <name>`, `test [name]` |
| `/model` | `show`, `info <id>`, `use <id>` |
| `/auth` | `status [provider]`, `test [provider]` |
| `/permissions` | `list`, `pending`, `add`, `remove <rule-id>`, `explain <action>`, `reset` |
| `/sandbox` | `status`, `list`, `set <policy>` |
| `/trust` | `status`, `list`, `add <path>`, `remove <path>` |
| `/config` | `show`, `get <key>`, `set <key> <value>`, `edit`, `reset [key]` |
| `/memory` | `list`, `show <id>`, `add`, `edit <id>`, `remove <id>` |
| `/instructions` | `show`, `sources`, `edit [path]`, `reload` |

### Professional Command Families

| Command Family | Recommended Operations |
|---|---|
| `/checkpoint` | `create [name]`, `list`, `show <id>`, `restore <id>`, `delete <id>` |
| `/tasks` | `list`, `show <id>`, `logs <id>`, `wait <id>` |
| `/queue` | `list`, `add <prompt>`, `remove <id>`, `clear` |
| `/tools` | `list`, `show <name>`, `enable <name>`, `disable <name>` |
| `/agents` | `list`, `show <name>`, `create <name>`, `edit <name>`, `delete <name>` |
| `/subagents` | `list`, `show <id>`, `logs <id>`, `cancel <id>` |
| `/pr` | `view [id]`, `create`, `update [id]`, `checks [id]` |
| `/profile` | `list`, `show <name>`, `create <name>`, `use <name>`, `delete <name>` |
| `/theme` | `list`, `show`, `preview <name>`, `use <name>` |
| `/keymap` | `show`, `edit`, `reset` |
| `/statusline` | `show`, `edit`, `reset` |
| `/debug` | `status`, `on`, `off`, `config` |
| `/budget` | `show`, `set <limit>`, `reset` |
| `/limits` | `show`, `set <key> <value>`, `reset [key]` |

### Advanced Command Families

| Command Family | Recommended Operations |
|---|---|
| `/goal` | `show`, `set <task>`, `update <task>`, `clear` |
| `/loop` | `start <task>`, `status [id]`, `stop <id>` |
| `/schedule` | `list`, `add`, `pause <id>`, `resume <id>`, `remove <id>` |
| `/notifications` | `status`, `configure`, `on`, `off`, `test` |
| `/remote` | `list`, `connect <name>`, `status`, `disconnect [name]` |
| `/remote-control` | `start`, `status`, `stop` |
| `/cloud` | `submit <task>`, `list`, `status <id>`, `logs <id>`, `cancel <id>` |
| `/cloud-environment` | `list`, `show <name>`, `create <name>`, `use <name>`, `remove <name>` |
| `/worktree` | `list`, `create <name>`, `switch <name>`, `remove <name>` |
| `/plugins` | `list`, `search`, `install`, `update`, `enable`, `disable`, `remove` |
| `/skills` | `list`, `show`, `create`, `edit`, `run`, `enable`, `disable`, `remove` |
| `/hooks` | `list`, `show`, `add`, `test`, `enable`, `disable`, `remove` |
| `/commands` | `list`, `show`, `create`, `edit`, `remove` |
| `/apps` | `list`, `connect`, `status`, `disconnect` |
| `/ide` | `status`, `connect`, `disconnect` |
| `/ide-context` | `show`, `add`, `remove`, `clear` |
| `/index` | `status`, `build`, `rebuild`, `clear` |
| `/cache` | `status`, `prune`, `clear` |
| `/experimental` | `list`, `show`, `enable`, `disable` |

---

## Permission Modes

`/mode` should be a friendly interface over enforceable permission rules—not a prompt telling the model to behave differently.

| Mode | Expected Behavior |
|---|---|
| `manual` | Ask before side-effecting tool operations. |
| `accept-edits` | Permit scoped workspace edits; continue asking for commands and other actions outside configured allowances. |
| `plan` | Allow read-only investigation and planning; block repository edits and mutating project commands. |
| `auto` | Execute actions allowed by explicit rules, scope, and resource limits; ask or stop when outside them. |
| `yolo` | Skip routine Klyro approval prompts while retaining sandbox restrictions, explicit deny rules, resource limits, and irreversible-operation safeguards. |

### Required Safety Rules

- `/approve` must not override host restrictions, sandbox enforcement, or explicit deny rules.
- Permission expansion, workspace trust changes, and extension activation must require deliberate user authorization.
- All execution routes—including `/run`, MCP, hooks, plugins, and subagents—must use the same policy engine.
- Destructive restoration/deletion and external sharing require clear scope and appropriate confirmation.
- Credentials must remain redacted in status output, configuration views, logs, diagnostics, exports, and raw-output views by default.

---

## Reasoning Effort Contract

Klyro should accept:

```text
/effort low
/effort medium
/effort high
/effort max
```

These are **portable intent levels**, not guarantees of identical reasoning, latency, or cost across providers.

Klyro should:

1. Validate the active model’s supported settings.
2. Translate the requested level into a supported provider setting.
3. Show the requested and effective settings.
4. Warn about approximations or unavailable levels.
5. Never silently claim to enable reasoning controls the provider does not expose.

The same capability checks apply to `/fast`.

---

## Important Command Distinctions

### Conversation State

| Commands | Difference |
|---|---|
| `/clear` vs `/new` | Clear active context in the current session versus create a separate session. |
| `/compact` vs `/recap` | Replace active context with a summary versus display a summary without changing context. |
| `/archive` vs `/delete` | Hide retained session data versus permanently remove selected session data. |
| `/fork` vs `/branch` | Create an independent session versus manage branches within a conversation. |
| `/branch` vs `/worktree` | Conversation organization versus Git workspace isolation. |

### Execution State

| Commands | Difference |
|---|---|
| `/resume` vs `/continue` | Load a saved session versus continue work in the current session. |
| `/continue` vs `/retry` | Continue unfinished work versus repeat a selected failed step. |
| `/cancel` vs `/stop` | Cancel the current foreground turn versus stop a selected background task/process. |
| `/pause` vs `/stop` | Suspend supported work for continuation versus terminate its execution. |

### Planning & Work Tracking

| Command | Source of Truth |
|---|---|
| `/plan` | The current plan, assumptions, and intended steps. |
| `/todos` | Actual autonomous task items and their completion/blocking state. |
| `/tasks` | Runtime jobs, subagent executions, and background work. |
| `/activity` | The agent’s current operation or wait condition. |
| `/queue` | Work accepted but not yet dispatched. |

**Bare `/plan` must show the current plan.** Enter read-only permission mode explicitly with `/mode plan`.

### Recovery

`/undo`, `/redo`, `/rewind`, and checkpoint restoration must:

- Use recorded changes or snapshots.
- Preview the affected scope.
- Detect conflicting edits.
- Preserve unrelated user changes.
- Never silently substitute a destructive `git reset --hard`.

Conversation rewind must not imply that external side effects—such as published PRs or sent network requests—have been undone.

---

## `/doctor` — Required Checks

`/doctor` should inspect:

- [ ] Node or the runtime actually used by Klyro.
- [ ] Git availability and repository access.
- [ ] Provider configuration and endpoint reachability.
- [ ] API authentication validity—not merely whether a credential exists.
- [ ] Model availability and capability compatibility.
- [ ] Tool registry and required executables.
- [ ] Permission rules and active mode.
- [ ] Sandbox availability and effective enforcement.
- [ ] MCP configuration and connection health.
- [ ] Project configuration and working-directory access.
- [ ] Workspace trust.
- [ ] `KLYRO.md` presence, readability, and instruction-source resolution.
- [ ] Session-store access, schema compatibility, and integrity.
- [ ] Clipboard and external-editor integration, when configured.

Each check should report **pass**, **fail**, **warning**, or **skipped**. Untested checks must not receive a success mark.

---

## What Was Missing or Inconsistent in Your Original Roadmap

### Commands Mentioned Earlier but Missing from the Final Lists

| Command | Correction |
|---|---|
| `/deny` | Restore to Priority 1 alongside `/approve`. |
| `/continue` | Include beside pause/continuation controls. |
| `/diagnostics` | Include in professional diagnostics. |
| `/logs` | Include in professional diagnostics. |

### Recommended Missing Capabilities

| Gap | Added Commands |
|---|---|
| Authentication lifecycle | `/login`, `/logout`, `/auth` |
| Foreground execution control | `/cancel`, `/retry` |
| Explicit context management | `/attach`, `/detach`, `/files`, `/search` |
| Instruction visibility and trust | `/instructions`, `/trust` |
| Installation visibility and maintenance | `/version`, `/update` |
| Complete verification workflow | `/format`, `/typecheck`, `/coverage` |
| Git and review delivery | `/commit`, `/pr` |
| Tool inventory | `/tools` |
| Pausable execution | `/pause` |
| Reusable configuration | `/profile`, `/reload` |
| Resource governance | `/budget`, `/limits` |
| Security accountability | `/audit` |
| Autonomous notifications | `/notifications` |
| Environment handoff | `/handoff` |
| Durable recovery | `/backup`, `/restore` |
| Custom slash commands | `/commands` |
| Index and artifact maintenance | `/index`, `/cache`, `/cleanup` |

### Priority & Duplication Fixes

- Keep `/sessions`, `/rename`, `/branch`, and `/fork` in **Priority 1**, rather than listing them again as future work.
- Use one `/tasks` system for background jobs and subagents.
- Keep `/background` defined once.
- Promote `/add-dir` and `/cd` to **Priority 1** because workspace scope is foundational.
- Move `/usage` and `/cost` to **Priority 2**, before unattended execution.
- Treat `/teleport` as an optional alias for `/handoff`, resolving its appearance in both your advanced list and your “do not copy literally” list.

---

## Commands Not to Copy Automatically

These names should not become Klyro commands merely for product parity.

| Commands | Klyro Recommendation |
|---|---|
| `/mobile`, `/desktop` | Add only if Klyro actually ships those applications and needs CLI integration. |
| `/stickers`, `/radio` | Omit unless there is a genuine Klyro-specific use case. |
| `/install-slack-app`, `/install-github-app` | Prefer supported integrations under `/apps`. |
| `/passes` | Omit unless Klyro develops a matching account/billing feature. |
| `/privacy-settings` | Provide appropriate privacy controls through `/config`; the copied name is unnecessary. |
| `/setup-bedrock`, `/setup-vertex` | Prefer provider setup workflows under `/provider`. |
| `/teleport` | Optional compatibility alias for `/handoff`, not a separate required feature. |

---

## Final Implementation Rule

**Do not ship command-shaped placeholders.**

Every exposed command should have:

- A registered parser and help entry.
- Capability and argument validation.
- A real backing subsystem.
- Consistent permission enforcement.
- Clear status, errors, and cancellation behavior.
- Tests for its behavior and side effects.

Unsupported capabilities should be shown as **unavailable with a reason**, not simulated as successful.

**Parity means reliable capability—not identical command names.**