/**
 * 1.2 — klyro completion
 * Generates shell completion scripts for bash/zsh/fish/powershell.
 */

const COMMANDS = ['tui', 'run', 'chat', 'config', 'doctor', 'completion', 'update', 'eval', 'session', 'resume', 'help', 'version'];

function bashScript(): string {
  return `# klyro bash completion
_klyro_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local cmds="${COMMANDS.join(' ')}"
  COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )
}
complete -F _klyro_complete klyro
complete -F _klyro_complete ky
`;
}

function zshScript(): string {
  return `#compdef klyro ky
_klyro() {
  local -a completions
  completions=(${COMMANDS.map((c) => `'${c}'`).join(' ')})
  _describe 'klyro commands' completions
}
compdef _klyro klyro ky
`;
}

function fishScript(): string {
  return `# klyro fish completion
${COMMANDS.map((c) => `complete -c klyro -f -a ${c}`).join('\n')}
complete -c ky -f -a "${COMMANDS.join(' ')}"
`;
}

function powershellScript(): string {
  return `# klyro powershell completion
Register-ArgumentCompleter -Native -CommandName klyro,ky -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $cmds = @(${COMMANDS.map((c) => `'${c}'`).join(', ')})
  $cmds | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
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
