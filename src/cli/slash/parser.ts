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
  | { kind: 'prompt'; text: string }
  | { kind: 'unknown'; raw: string };

const KNOWN = ['help', 'clear', 'new', 'exit', 'quit', 'q', 'compact', 'resume', 'sessions', 'rename', 'fork', 'branch', 'export', 'copy', 'model', 'm', 'models', 'provider', 'p', 'effort', 'e', 'fast', 'init', 'status', 'context', 'diff', 'plan', 'todos', 'memory', 'permissions', 'mode', 'sandbox', 'approve', 'deny', 'login', 'logout', 'auth', 'version', 'update', 'cancel', 'shell', 'mention', 'tools', 'config', 'settings', 'doctor', 'version', 'cost', 'thinking', 'jobs', 'verify', 'project', 'undo', 'rewind'] as const;

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
    default:        return { kind: 'unknown', raw: trimmed };
  }
}

export function listCommands(): string[] {
  return [...KNOWN];
}
