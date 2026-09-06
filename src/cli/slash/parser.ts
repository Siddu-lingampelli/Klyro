/**
 * Slash command parser — turns "/model foo" into a typed Command.
 *
 * Commands supported in MVP:
 *   /clear             — clear the visible transcript (not the agent's)
 *   /compact           — ask the agent to compact its own context
 *   /model <id>        — switch the active model mid-session
 *   /diff              — show working-tree diff (git diff)
 *   /plan              — toggle the plan view (if a plan is loaded)
 *   /status            — show session status (model, steps, usage)
 *   /quit              — exit the REPL
 *   /help              — list available commands
 *
 * Anything not starting with "/" is a regular prompt and yields
 * { kind: 'prompt', text }.
 */

export type SlashCommand =
  | { kind: 'clear' }
  | { kind: 'new' }
  | { kind: 'compact'; focus?: string }
  | { kind: 'model'; model: string }
  | { kind: 'models' }
  | { kind: 'provider'; provider: string }
  | { kind: 'effort'; level: string }
  | { kind: 'fast'; state: string }
  | { kind: 'diff' }
  | { kind: 'undo' }
  | { kind: 'rewind' }
  | { kind: 'plan'; task?: string }
  | { kind: 'todos' }
  | { kind: 'status' }
  | { kind: 'quit' }
  | { kind: 'help' }
  | { kind: 'config' }
  | { kind: 'settings' }
  | { kind: 'doctor' }
  | { kind: 'version' }
  | { kind: 'update' }
  | { kind: 'cost' }
  | { kind: 'thinking' }
  | { kind: 'memory' }
  | { kind: 'jobs' }
  | { kind: 'verify' }
  | { kind: 'project' }
  | { kind: 'context' }
  | { kind: 'login' }
  | { kind: 'logout' }
  | { kind: 'auth' }
  | { kind: 'init' }
  | { kind: 'cancel' }
  | { kind: 'shell'; command: string }
  | { kind: 'mention'; path: string }
  | { kind: 'tools' }
  | { kind: 'permissions' }
  | { kind: 'mode'; mode: string }
  | { kind: 'sandbox'; policy: string }
  | { kind: 'approve' }
  | { kind: 'deny' }
  | { kind: 'resume'; id?: string }
  | { kind: 'sessions'; sub?: string }
  | { kind: 'rename'; name: string }
  | { kind: 'fork'; prompt?: string }
  | { kind: 'branch'; name: string }
  | { kind: 'export'; file?: string }
  | { kind: 'copy'; n?: string }
  | { kind: 'review'; target?: string }
  | { kind: 'code-review'; options?: string }
  | { kind: 'security-review' }
  | { kind: 'simplify'; target?: string }
  | { kind: 'test'; target?: string }
  | { kind: 'lint' }
  | { kind: 'build' }
  | { kind: 'run'; command: string }
  | { kind: 'fix'; target?: string }
  | { kind: 'explain'; target?: string }
  | { kind: 'format' }
  | { kind: 'ask'; question: string }
  | { kind: 'redo' }
  | { kind: 'checkpoint' }
  | { kind: 'accept' }
  | { kind: 'reject' }
  | { kind: 'details' }
  | { kind: 'verbose' }
  | { kind: 'raw' }
  | { kind: 'activity' }
  | { kind: 'tasks' }
  | { kind: 'ps' }
  | { kind: 'stop'; id?: string }
  | { kind: 'queue' }
  | { kind: 'retry' }
  | { kind: 'kill'; id?: string }
  | { kind: 'mcp'; sub?: string }
  | { kind: 'agents' }
  | { kind: 'agent'; name: string }
  | { kind: 'subagents' }
  | { kind: 'subtask'; task: string }
  | { kind: 'background'; task?: string }
  | { kind: 'add-dir'; path: string }
  | { kind: 'cd'; path: string }
  | { kind: 'attach'; file: string }
  | { kind: 'drop'; file?: string }
  | { kind: 'image'; path?: string }
  | { kind: 'paste' }
  | { kind: 'files' }
  | { kind: 'ls'; path?: string }
  | { kind: 'tree'; path?: string }
  | { kind: 'search'; query: string }
  | { kind: 'web'; url: string }
  | { kind: 'read'; path: string }
  | { kind: 'map' }
  | { kind: 'tokens' }
  | { kind: 'commit'; message?: string }
  | { kind: 'push' }
  | { kind: 'pull' }
  | { kind: 'pr'; args?: string }
  | { kind: 'issue'; id?: string }
  | { kind: 'editor'; file?: string }
  | { kind: 'keymap'; name: string }
  | { kind: 'vim'; state: string }
  | { kind: 'theme'; name: string }
  | { kind: 'statusline'; format: string }
  | { kind: 'output-style'; style: string }
  | { kind: 'debug' }
  | { kind: 'whoami' }
  | { kind: 'reload' }
  | { kind: 'reset' }
  | { kind: 'bug' }
  | { kind: 'changelog' }
  | { kind: 'promptcmd'; args: string }
  | { kind: 'alias'; args: string }
  | { kind: 'commands' }
  | { kind: 'env'; args?: string }
  | { kind: 'deps' }
  | { kind: 'install' }
  | { kind: 'prompt'; text: string }
  | { kind: 'unknown'; raw: string };

const KNOWN = ['help', 'clear', 'new', 'exit', 'quit', 'q', 'compact', 'resume', 'sessions', 'rename', 'fork', 'branch', 'export', 'copy', 'model', 'm', 'models', 'provider', 'p', 'effort', 'e', 'fast', 'init', 'status', 'context', 'diff', 'plan', 'todos', 'memory', 'permissions', 'mode', 'sandbox', 'approve', 'deny', 'login', 'logout', 'auth', 'version', 'update', 'cancel', 'shell', 'mention', 'tools', 'config', 'settings', 'doctor', 'cost', 'thinking', 'jobs', 'verify', 'project', 'undo', 'rewind', 'review', 'code-review', 'security-review', 'simplify', 'test', 'lint', 'build', 'run', 'fix', 'explain', 'format', 'ask', 'redo', 'checkpoint', 'accept', 'reject', 'details', 'verbose', 'raw', 'activity', 'tasks', 'ps', 'stop', 'queue', 'retry', 'kill', 'mcp', 'agents', 'agent', 'subagents', 'subtask', 'background', 'add-dir', 'cd', 'attach', 'drop', 'image', 'paste', 'files', 'ls', 'tree', 'search', 'web', 'read', 'map', 'tokens', 'commit', 'push', 'pull', 'pr', 'issue', 'editor', 'keymap', 'vim', 'theme', 'statusline', 'output-style', 'debug', 'whoami', 'reload', 'reset', 'bug', 'changelog', 'prompt', 'alias', 'commands', 'env', 'deps', 'install'] as const;

export function parse(input: string): SlashCommand {
  const trimmed = input.trim();
  // `!cmd` alias for /shell, `@path` alias for /mention (commands.md P1)
  if (trimmed.startsWith('!')) {
    return { kind: 'shell', command: trimmed.slice(1).trim() };
  }
  if (trimmed.startsWith('@')) {
    return { kind: 'mention', path: trimmed.slice(1).trim() };
  }
  if (!trimmed.startsWith('/')) {
    return { kind: 'prompt', text: trimmed };
  }
  const space = trimmed.indexOf(' ');
  const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const rest = space === -1 ? '' : trimmed.slice(space + 1).trim();
  switch (name) {
    case 'clear':   return { kind: 'clear' };
    case 'new':     return { kind: 'new' };
    case 'compact': return { kind: 'compact', focus: rest || undefined };
    case 'diff':    return { kind: 'diff' };
    case 'undo':    return { kind: 'undo' };
    case 'rewind':  return { kind: 'rewind' };
    case 'plan':    return { kind: 'plan', task: rest || undefined };
    case 'todos':   return { kind: 'todos' };
    case 'status':  return { kind: 'status' };
    case 'cost':    return { kind: 'cost' };
    case 'thinking': return { kind: 'thinking' };
    case 'memory':  return { kind: 'memory' };
    case 'jobs':    return { kind: 'jobs' };
    case 'verify':  return { kind: 'verify' };
    case 'project': return { kind: 'project' };
    case 'context': return { kind: 'context' };
    case 'login':   return { kind: 'login' };
    case 'logout':  return { kind: 'logout' };
    case 'auth':    return { kind: 'auth' };
    case 'init':    return { kind: 'init' };
    case 'cancel':
    case 'interrupt': return { kind: 'cancel' };
    case 'shell':   return { kind: 'shell', command: rest };
    case 'mention': return { kind: 'mention', path: rest };
    case 'tools':   return { kind: 'tools' };
    case 'permissions': return { kind: 'permissions' };
    case 'mode':    return { kind: 'mode', mode: rest };
    case 'sandbox': return { kind: 'sandbox', policy: rest };
    case 'approve': return { kind: 'approve' };
    case 'deny':    return { kind: 'deny' };
    case 'resume':  return { kind: 'resume', id: rest || undefined };
    case 'sessions': return { kind: 'sessions', sub: rest || undefined };
    case 'rename':
    case 'title':   return { kind: 'rename', name: rest };
    case 'fork':    return { kind: 'fork', prompt: rest || undefined };
    case 'branch':  return { kind: 'branch', name: rest };
    case 'export':  return { kind: 'export', file: rest || undefined };
    case 'copy':    return { kind: 'copy', n: rest || undefined };
    case 'update':
    case 'upgrade': return { kind: 'update' };
    case 'models':  return { kind: 'models' };
    case 'fast':    return { kind: 'fast', state: rest };
    case 'settings': return { kind: 'settings' };
    case 'quit':
    case 'exit':
    case 'q':       return { kind: 'quit' };
    case 'help':
    case '?':       return { kind: 'help' };
    case 'config':  return { kind: 'config' };
    case 'doctor':  return { kind: 'doctor' };
    case 'version': return { kind: 'version' };
    case 'provider':
    case 'p': {
      return { kind: 'provider', provider: rest };
    }
    case 'effort':
    case 'e': {
      return { kind: 'effort', level: rest };
    }
    case 'model':
    case 'm': {
      return { kind: 'model', model: rest };
    }
    // Priority 2 — developer workflow
    case 'review':  return { kind: 'review', target: rest || undefined };
    case 'code-review': return { kind: 'code-review', options: rest || undefined };
    case 'security-review': return { kind: 'security-review' };
    case 'simplify': return { kind: 'simplify', target: rest || undefined };
    case 'test':    return { kind: 'test', target: rest || undefined };
    case 'lint':    return { kind: 'lint' };
    case 'build':   return { kind: 'build' };
    case 'run':     return { kind: 'run', command: rest };
    case 'fix':     return { kind: 'fix', target: rest || undefined };
    case 'explain': return { kind: 'explain', target: rest || undefined };
    case 'format':  return { kind: 'format' };
    case 'ask':     return { kind: 'ask', question: rest };
    // Priority 2 — checkpoints / edit loop
    case 'redo':    return { kind: 'redo' };
    case 'checkpoint':
    case 'snapshot': return { kind: 'checkpoint' };
    case 'accept':  return { kind: 'accept' };
    case 'reject':  return { kind: 'reject' };
    // Priority 2 — activity controls
    case 'details': return { kind: 'details' };
    case 'verbose': return { kind: 'verbose' };
    case 'raw':     return { kind: 'raw' };
    case 'activity': return { kind: 'activity' };
    case 'tasks':   return { kind: 'tasks' };
    case 'ps':      return { kind: 'ps' };
    case 'stop':    return { kind: 'stop', id: rest || undefined };
    case 'queue':   return { kind: 'queue' };
    case 'retry':   return { kind: 'retry' };
    case 'kill':    return { kind: 'kill', id: rest || undefined };
    // Priority 2 — MCP / agents
    case 'mcp':     return { kind: 'mcp', sub: rest || undefined };
    case 'agents':  return { kind: 'agents' };
    case 'agent':   return { kind: 'agent', name: rest };
    case 'subagents': return { kind: 'subagents' };
    case 'subtask': return { kind: 'subtask', task: rest };
    case 'background':
    case 'bg':      return { kind: 'background', task: rest || undefined };
    // Priority 2 — files / context
    case 'add-dir': return { kind: 'add-dir', path: rest };
    case 'cd':      return { kind: 'cd', path: rest };
    case 'attach':  return { kind: 'attach', file: rest };
    case 'drop':    return { kind: 'drop', file: rest || undefined };
    case 'image':   return { kind: 'image', path: rest || undefined };
    case 'paste':   return { kind: 'paste' };
    case 'files':   return { kind: 'files' };
    case 'ls':      return { kind: 'ls', path: rest || undefined };
    case 'tree':    return { kind: 'tree', path: rest || undefined };
    case 'search':  return { kind: 'search', query: rest };
    case 'web':     return { kind: 'web', url: rest };
    case 'read':    return { kind: 'read', path: rest };
    case 'map':     return { kind: 'map' };
    case 'tokens':  return { kind: 'tokens' };
    // Priority 2 — git workflow
    case 'commit':  return { kind: 'commit', message: rest || undefined };
    case 'push':    return { kind: 'push' };
    case 'pull':    return { kind: 'pull' };
    case 'pr':      return { kind: 'pr', args: rest || undefined };
    case 'issue':   return { kind: 'issue', id: rest || undefined };
    // Priority 2 — config / UI
    case 'editor':  return { kind: 'editor', file: rest || undefined };
    case 'keymap':  return { kind: 'keymap', name: rest };
    case 'vim':     return { kind: 'vim', state: rest };
    case 'theme':   return { kind: 'theme', name: rest };
    case 'statusline': return { kind: 'statusline', format: rest };
    case 'output-style': return { kind: 'output-style', style: rest };
    // Priority 2 — diagnostics / misc
    case 'debug':   return { kind: 'debug' };
    case 'whoami':  return { kind: 'whoami' };
    case 'reload':  return { kind: 'reload' };
    case 'reset':   return { kind: 'reset' };
    case 'bug':     return { kind: 'bug' };
    case 'changelog': return { kind: 'changelog' };
    case 'prompt':  return { kind: 'promptcmd', args: rest };
    case 'alias':   return { kind: 'alias', args: rest };
    case 'commands': return { kind: 'commands' };
    case 'env':     return { kind: 'env', args: rest || undefined };
    case 'deps':    return { kind: 'deps' };
    case 'install': return { kind: 'install' };
    default:        return { kind: 'unknown', raw: trimmed };
  }
}

export function listCommands(): string[] {
  return [...KNOWN];
}

export interface CommandDef { name: string; hint: string }

/** Curated canonical commands with one-line hints — drives /help, /commands and TUI autocomplete. */
export const COMMAND_DEFS: CommandDef[] = [
  { name: 'help', hint: 'show all commands' },
  { name: 'clear', hint: 'clear transcript' },
  { name: 'new', hint: 'start a new session' },
  { name: 'exit', hint: 'exit Klyro' },
  { name: 'compact', hint: 'compact context [focus]' },
  { name: 'resume', hint: 'resume previous session' },
  { name: 'sessions', hint: 'list sessions' },
  { name: 'rename', hint: 'rename current session' },
  { name: 'fork', hint: 'fork conversation' },
  { name: 'branch', hint: 'create/switch branch' },
  { name: 'export', hint: 'export conversation' },
  { name: 'copy', hint: 'copy last response' },
  { name: 'model', hint: 'show/switch model' },
  { name: 'models', hint: 'list available models' },
  { name: 'provider', hint: 'show/switch provider' },
  { name: 'effort', hint: 'set reasoning effort' },
  { name: 'fast', hint: 'toggle fast mode' },
  { name: 'init', hint: 'create KLYRO.md' },
  { name: 'status', hint: 'session/model status' },
  { name: 'context', hint: 'context usage' },
  { name: 'diff', hint: 'show git diff' },
  { name: 'plan', hint: 'show/enter plan' },
  { name: 'todos', hint: 'show task state' },
  { name: 'memory', hint: 'view memory' },
  { name: 'permissions', hint: 'permission rules' },
  { name: 'mode', hint: 'permission mode' },
  { name: 'sandbox', hint: 'sandbox policy' },
  { name: 'approve', hint: 'approve blocked action' },
  { name: 'deny', hint: 'deny blocked action' },
  { name: 'login', hint: 'authenticate' },
  { name: 'logout', hint: 'sign out' },
  { name: 'auth', hint: 'auth status' },
  { name: 'version', hint: 'show version' },
  { name: 'update', hint: 'update CLI' },
  { name: 'cancel', hint: 'interrupt operation' },
  { name: 'shell', hint: 'run shell (!cmd)' },
  { name: 'mention', hint: 'attach file (@path)' },
  { name: 'tools', hint: 'list tools' },
  { name: 'config', hint: 'open configuration' },
  { name: 'doctor', hint: 'health check' },
  { name: 'review', hint: 'review changes' },
  { name: 'code-review', hint: 'deep code review' },
  { name: 'security-review', hint: 'security review' },
  { name: 'simplify', hint: 'simplify changes' },
  { name: 'test', hint: 'run tests' },
  { name: 'lint', hint: 'run linting' },
  { name: 'build', hint: 'run build' },
  { name: 'run', hint: 'run a command' },
  { name: 'fix', hint: 'fix errors/tests' },
  { name: 'explain', hint: 'explain code' },
  { name: 'format', hint: 'format code' },
  { name: 'ask', hint: 'read-only Q&A' },
  { name: 'undo', hint: 'undo change' },
  { name: 'redo', hint: 'redo change' },
  { name: 'rewind', hint: 'rewind code' },
  { name: 'checkpoint', hint: 'create checkpoint' },
  { name: 'accept', hint: 'accept edits' },
  { name: 'reject', hint: 'reject edits' },
  { name: 'details', hint: 'toggle details' },
  { name: 'verbose', hint: 'toggle verbose' },
  { name: 'raw', hint: 'toggle raw output' },
  { name: 'activity', hint: 'agent activity' },
  { name: 'tasks', hint: 'background tasks' },
  { name: 'ps', hint: 'background processes' },
  { name: 'stop', hint: 'stop process' },
  { name: 'queue', hint: 'queued prompts' },
  { name: 'retry', hint: 'retry last action' },
  { name: 'kill', hint: 'kill process' },
  { name: 'mcp', hint: 'MCP servers' },
  { name: 'agents', hint: 'manage agents' },
  { name: 'agent', hint: 'switch agent' },
  { name: 'subagents', hint: 'list subagents' },
  { name: 'subtask', hint: 'spawn subagent' },
  { name: 'background', hint: 'run in background' },
  { name: 'add-dir', hint: 'add directory' },
  { name: 'cd', hint: 'change directory' },
  { name: 'attach', hint: 'attach file' },
  { name: 'drop', hint: 'drop file' },
  { name: 'image', hint: 'attach image' },
  { name: 'paste', hint: 'paste clipboard' },
  { name: 'files', hint: 'files in context' },
  { name: 'ls', hint: 'list files' },
  { name: 'tree', hint: 'file tree' },
  { name: 'search', hint: 'search codebase' },
  { name: 'web', hint: 'fetch URL' },
  { name: 'read', hint: 'read file' },
  { name: 'map', hint: 'repository map' },
  { name: 'tokens', hint: 'token usage' },
  { name: 'commit', hint: 'git commit' },
  { name: 'push', hint: 'git push' },
  { name: 'pull', hint: 'git pull' },
  { name: 'pr', hint: 'pull request' },
  { name: 'issue', hint: 'github issue' },
  { name: 'editor', hint: 'external editor' },
  { name: 'keymap', hint: 'keyboard shortcuts' },
  { name: 'vim', hint: 'vim input mode' },
  { name: 'theme', hint: 'configure theme' },
  { name: 'statusline', hint: 'status bar format' },
  { name: 'output-style', hint: 'output style' },
  { name: 'debug', hint: 'debug info' },
  { name: 'whoami', hint: 'identity' },
  { name: 'reload', hint: 'reload config' },
  { name: 'reset', hint: 'reset settings' },
  { name: 'bug', hint: 'report a bug' },
  { name: 'changelog', hint: 'release notes' },
  { name: 'prompt', hint: 'saved prompts' },
  { name: 'alias', hint: 'command aliases' },
  { name: 'commands', hint: 'custom commands' },
  { name: 'env', hint: 'environment vars' },
  { name: 'deps', hint: 'dependencies' },
  { name: 'install', hint: 'install deps' },
];

/** Prefix-match command names for TUI autocomplete — top `limit` (default 6). */
export function suggestCommands(prefix: string, limit = 6): CommandDef[] {
  const p = prefix.toLowerCase().replace(/^\//, '');
  if (!p) return COMMAND_DEFS.slice(0, limit);
  const starts: CommandDef[] = [];
  const contains: CommandDef[] = [];
  for (const d of COMMAND_DEFS) {
    if (d.name.startsWith(p)) starts.push(d);
    else if (d.name.includes(p)) contains.push(d);
  }
  return [...starts, ...contains].slice(0, limit);
}
