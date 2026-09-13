/**
 * 1.2 — klyro completion
 * Generates shell completion scripts for bash/zsh/fish/powershell.
 */

const COMMANDS = ['tui', 'run', 'chat', 'config', 'doctor', 'completion', 'update', 'eval', 'session', 'resume', 'help', 'version', 'scan', 'project', 'mcp', 'hooks', 'agents', 'commit', 'audit', 'benchmark', 'sessions', 'login', 'logout'];

/** Second-level completion: global flags + per-command flags. */
const GLOBAL_FLAGS = ['--cwd', '--config', '--debug', '--verbose', '--quiet', '--json', '--yes', '--no-color', '--print', '--output-format', '--no-stream', '--show-thinking', '--tui', '--chat', '--continue', '--resume', '--help', '--version'];
const COMMAND_FLAGS: Record<string, string[]> = {
  run: ['-m', '--model', '--max-steps', '--max-tokens', '--temperature', '--timeout', '--base-url', '--api-key', '--output', '--provider', '--dry-run', '--resume', '--resume-session', '--verify', '--verify-command', '--verify-mode', '--max-repairs', '--persist', '--require-verify', '--agent', '--max-depth'],
  chat: ['-s', '--system', '-m', '--model', '-t', '--timeout'],
  eval: ['--output', '--suite', '--filter', '--runs', '--parallel', '--model'],
  tui: ['-m', '--model', '--max-steps'],
  doctor: ['--json'],
  session: ['list', 'show', 'resume', 'fork', 'delete'],
  sessions: ['export', 'import', 'fork', 'delete'],
  mcp: ['list', 'add', 'remove', 'probe', 'serve'],
  config: ['list', 'get', 'set', 'unset', 'path'],
  commit: ['--dry-run', '--message', '--force-secret'],
  completion: ['bash', 'zsh', 'fish', 'powershell'],
  resume: ['-m', '--model', '--max-steps'],
};

function flagsFor(cmd: string): string[] {
  return [...GLOBAL_FLAGS, ...(COMMAND_FLAGS[cmd] ?? [])];
}

function bashScript(): string {
  const cmdCases = Object.entries(COMMAND_FLAGS)
    .map(([c, fs]) => `      ${c}) opts="${fs.join(' ')}" ;;`)
    .join('\n');
  return `# klyro bash completion (commands + flags)
_klyro_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local cmds="${COMMANDS.join(' ')}"
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$cmds ${GLOBAL_FLAGS.join(' ')}" -- "$cur") )
    return
  fi
  local first="\${COMP_WORDS[1]}"
  local opts=""
  case "$first" in
${cmdCases}
    *) opts="${GLOBAL_FLAGS.join(' ')}" ;;
  esac
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _klyro_complete klyro
complete -F _klyro_complete ky
`;
}

function zshScript(): string {
  const cmdCases = Object.entries(COMMAND_FLAGS)
    .map(([c, fs]) => `      ${c}) _values 'flags' ${fs.map((f) => `'${f}'`).join(' ')} ;;`)
    .join('\n');
  return `#compdef klyro ky
_klyro() {
  if (( CURRENT == 2 )); then
    _describe 'klyro commands' ${COMMANDS.map((c) => `'${c}'`).join(' ')} ${GLOBAL_FLAGS.map((f) => `'${f}'`).join(' ')}
    return
  fi
  case "$words[2]" in
${cmdCases}
    *) _values 'flags' ${GLOBAL_FLAGS.map((f) => `'${f}'`).join(' ')} ;;
  esac
}
compdef _klyro klyro ky
`;
}

function fishScript(): string {
  const flagLines = Object.entries(COMMAND_FLAGS)
    .flatMap(([c, fs]) => fs.map((f) => `complete -c klyro -f -n "__fish_seen_subcommand_from ${c}" -a ${f}`))
    .join('\n');
  return `# klyro fish completion (commands + flags)
${COMMANDS.map((c) => `complete -c klyro -f -n __fish_use_subcommand -a ${c}`).join('\n')}
${flagLines}
complete -c ky -f -a "${COMMANDS.join(' ')}"
`;
}

function powershellScript(): string {
  return `# klyro powershell completion (commands + flags)
Register-ArgumentCompleter -Native -CommandName klyro,ky -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $cmds = @(${COMMANDS.map((c) => `'${c}'`).join(', ')})
  $flags = @(${GLOBAL_FLAGS.map((f) => `'${f}'`).join(', ')})
  $tokens = $commandAst.ToString() -split '\\s+'
  if ($tokens.Count -le 2) { $cands = $cmds + $flags } else {
    switch ($tokens[1]) {
${Object.entries(COMMAND_FLAGS).map(([c, fs]) => `      '${c}' { $cands = @(${fs.map((f) => `'${f}'`).join(', ')}) }`).join('\n')}
      default { $cands = $flags }
    }
  }
  $cands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}

export function getCompletionScript(shell: string): string | null {
  switch (shell) {
    case 'bash': return bashScript();
    case 'zsh': return zshScript();
    case 'fish': return fishScript();
    case 'powershell': case 'pwsh': return powershellScript();
    default: return null;
  }
}

export async function runCompletion(shell?: string): Promise<number> {
  if (!shell) {
    process.stderr.write('Usage: klyro completion <bash|zsh|fish|powershell>\n');
    return 2;
  }
  const script = getCompletionScript(shell);
  if (!script) {
    process.stderr.write(`Unknown shell: ${shell} (expected bash|zsh|fish|powershell)\n`);
    return 2;
  }
  process.stdout.write(script);
  return 0;
}
