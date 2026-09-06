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
  | { kind: 'compact' }
  | { kind: 'model'; model: string }
  | { kind: 'diff' }
  | { kind: 'undo' }
  | { kind: 'rewind' }
  | { kind: 'plan' }
  | { kind: 'status' }
  | { kind: 'quit' }
  | { kind: 'help' }
  | { kind: 'config' }
  | { kind: 'doctor' }
  | { kind: 'version' }
  | { kind: 'cost' }
  | { kind: 'thinking' }
  | { kind: 'memory' }
  | { kind: 'jobs' }
  | { kind: 'prompt'; text: string }
  | { kind: 'unknown'; raw: string };

const KNOWN = ['clear', 'compact', 'model', 'diff', 'undo', 'rewind', 'plan', 'status', 'quit', 'help', 'config', 'doctor', 'version', 'cost', 'thinking', 'memory', 'jobs', 'exit', 'clear'] as const;

export function parse(input: string): SlashCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return { kind: 'prompt', text: trimmed };
  }
  const space = trimmed.indexOf(' ');
  const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const rest = space === -1 ? '' : trimmed.slice(space + 1).trim();
  switch (name) {
    case 'clear':   return { kind: 'clear' };
    case 'compact': return { kind: 'compact' };
    case 'diff':    return { kind: 'diff' };
    case 'undo':    return { kind: 'undo' };
    case 'rewind':  return { kind: 'rewind' };
    case 'plan':    return { kind: 'plan' };
    case 'status':  return { kind: 'status' };
    case 'cost':    return { kind: 'cost' };
    case 'thinking': return { kind: 'thinking' };
    case 'memory':  return { kind: 'memory' };
    case 'jobs':    return { kind: 'jobs' };
    case 'quit':
    case 'exit':
    case 'q':       return { kind: 'quit' };
    case 'help':
    case '?':       return { kind: 'help' };
    case 'config':  return { kind: 'config' };
    case 'doctor':  return { kind: 'doctor' };
    case 'version': return { kind: 'version' };
    case 'model':
    case 'm': {
      if (!rest) return { kind: 'unknown', raw: trimmed };
      return { kind: 'model', model: rest };
    }
    default:        return { kind: 'unknown', raw: trimmed };
  }
}

export function listCommands(): string[] {
  return [...KNOWN];
}
