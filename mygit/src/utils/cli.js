export const ExitCode = {
  USAGE: 2,
  STATE: 3,
  NETWORK: 4,
  INTERNAL: 5,
};

export function fatal(message, code = ExitCode.INTERNAL) {
  console.error(message);
  process.exit(code);
}

function escapeForSingleQuotes(value) {
  return String(value).replace(/'/g, "'\\''");
}

export function getCompletionScript(shell, commandNames) {
  const commands = [...new Set(commandNames)].filter(Boolean).sort();
  const commandList = commands.join(' ');

  if (shell === 'zsh') {
    return `#compdef gitbro\n\n_gitbro() {\n  local -a commands\n  commands=(${commands.map((name) => `'${escapeForSingleQuotes(name)}'`).join(' ')})\n  _describe 'command' commands\n}\n\ncompdef _gitbro gitbro\n`;
  }

  if (shell === 'fish') {
    return commands
      .map((name) => `complete -c gitbro -f -n '__fish_use_subcommand' -a '${escapeForSingleQuotes(name)}'`)
      .join('\n') + '\n';
  }

  return [
    '#!/usr/bin/env bash',
    '',
    '_gitbro_completions() {',
    '  local cur',
    '  COMPREPLY=()',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    `  COMPREPLY=( $(compgen -W "${escapeForSingleQuotes(commandList)}" -- "$cur") )`,
    '  return 0',
    '}',
    '',
    'complete -F _gitbro_completions gitbro',
    '',
  ].join('\n');
}
