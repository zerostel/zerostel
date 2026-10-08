import { ADAPTERS } from '../agents/adapters.js';

// `zerostel completion <shell>` prints a completion script to source from your
// shell's startup file. The scripts only list words; they never run anything.

const COMMANDS = ['install', 'uninstall', 'run', 'demo', 'log', 'ui', 'sessions', 'show', 'diff', 'find', 'undo', 'rewind', 'snapshot', 'check', 'checks', 'handoff', 'report', 'verify', 'policy', 'mcp', 'status', 'doctor', 'prune', 'projects', 'config', 'completion', 'help'];
const FLAGS = ['--session', '--project', '--agent', '--json', '--yes', '--dry-run', '--after', '--only', '--changes', '--message', '--output', '--open', '--share', '--no-prompts', '--no-output', '--no-diffs', '--older-than', '--force', '--all', '--port', '--no-open', '--help', '--version'];
const SUB: Record<string, string[]> = {
  policy: ['init', 'test'],
  completion: ['bash', 'zsh', 'fish', 'powershell'],
  rewind: ['0'],
};

export const SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;

export function completionScript(shell: string): string | null {
  const agents = ADAPTERS.map((a) => a.id).join(' ');
  const words = COMMANDS.join(' ');
  const flags = FLAGS.join(' ');
  switch (shell) {
    case 'bash':
      return `# zerostel completion for bash: eval "$(zerostel completion bash)" in ~/.bashrc
_zerostel() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$prev" = "--agent" ]; then COMPREPLY=($(compgen -W "${agents} all" -- "$cur")); return; fi
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=($(compgen -W "${words}" -- "$cur")); return; fi
  case "\${COMP_WORDS[1]}" in
${Object.entries(SUB)
  .map(([k, v]) => `    ${k}) if [ "$COMP_CWORD" -eq 2 ]; then COMPREPLY=($(compgen -W "${v.join(' ')}" -- "$cur")); return; fi ;;`)
  .join('\n')}
  esac
  COMPREPLY=($(compgen -W "${flags}" -- "$cur"))
}
complete -F _zerostel zerostel
`;
    case 'zsh':
      return `# zerostel completion for zsh: eval "$(zerostel completion zsh)" in ~/.zshrc
_zerostel() {
  if (( CURRENT == 2 )); then compadd -- ${words}; return; fi
  if [[ \${words[CURRENT-1]} == --agent ]]; then compadd -- ${agents} all; return; fi
  case \${words[2]} in
${Object.entries(SUB)
  .map(([k, v]) => `    ${k}) (( CURRENT == 3 )) && { compadd -- ${v.join(' ')}; return; } ;;`)
  .join('\n')}
  esac
  compadd -- ${flags}
}
compdef _zerostel zerostel
`;
    case 'fish':
      return `# zerostel completion for fish: zerostel completion fish > ~/.config/fish/completions/zerostel.fish
complete -c zerostel -f
complete -c zerostel -n __fish_use_subcommand -a "${words}"
${Object.entries(SUB)
  .map(([k, v]) => `complete -c zerostel -n "__fish_seen_subcommand_from ${k}" -a "${v.join(' ')}"`)
  .join('\n')}
complete -c zerostel -l agent -x -a "${agents} all"
${FLAGS.filter((f) => f !== '--agent')
  .map((f) => `complete -c zerostel -l ${f.slice(2)}`)
  .join('\n')}
`;
    case 'powershell':
      return `# zerostel completion for PowerShell: save it, then load it from $PROFILE
#   zerostel completion powershell > $HOME/zerostel-completion.ps1
#   and add this line to $PROFILE:  . $HOME/zerostel-completion.ps1
Register-ArgumentCompleter -Native -CommandName zerostel -ScriptBlock {
  param($word, $ast, $cursor)
  $parts = $ast.CommandElements | ForEach-Object { $_.ToString() }
  $commands = '${COMMANDS.join("','")}'
  $sub = @{ ${Object.entries(SUB)
    .map(([k, v]) => `'${k}' = @('${v.join("','")}')`)
    .join('; ')} }
  $flags = '${FLAGS.join("','")}'
  $agents = '${ADAPTERS.map((a) => a.id).join("','")}','all'
  if ($parts.Count -le 1 -or ($parts.Count -eq 2 -and $word)) { $list = $commands }
  elseif ($parts[-1] -eq '--agent' -or ($parts.Count -ge 2 -and $parts[-2] -eq '--agent' -and $word)) { $list = $agents }
  elseif ($sub.ContainsKey($parts[1]) -and $parts.Count -le 3) { $list = $sub[$parts[1]] + $flags }
  else { $list = $flags }
  $list | Where-Object { $_ -like "$word*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;
  }
  return null;
}
