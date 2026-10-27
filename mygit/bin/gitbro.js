#!/usr/bin/env node

import { program } from 'commander';
import { init }                             from '../src/init.js';
import { hashObject }                       from '../src/hashObject.js';
import { add }                              from '../src/add.js';
import { commit }                           from '../src/commit.js';
import { log }                              from '../src/log.js';
import { branch, checkout }                 from '../src/branch.js';
import { status }                           from '../src/status.js';
import { diff }                             from '../src/diff.js';
import { merge }                            from '../src/merge.js';
import { remoteAdd, remoteRemove, remoteList } from '../src/remote.js';
import { push }                             from '../src/push.js';
import { pull }                             from '../src/pull.js';
import { webui }                            from '../src/webui.js';
import { configCmd }                        from '../src/config.js';
import { clone }                            from '../src/clone.js';
import { amend }                            from '../src/amend.js';
import { catFile }                          from '../src/catFile.js';
import { rm }                               from '../src/rm.js';
import { getCompletionScript, ExitCode }    from '../src/utils/cli.js';

const completionCommands = [
  'init', 'clone', 'config', 'hash-object', 'add', 'commit', 'log', 'status',
  'branch', 'checkout', 'merge', 'diff', 'remote', 'push', 'pull', 'webui',
  'commit-amend', 'amend', 'cat-file', 'rm', 'completion', 'help'
];

program
  .name('gitbro')
  .description('A Git engine built from scratch in Node.js')
  .version('1.0.0');

program.command('init [directory]')
  .description('Initialize a new gitbro repository')
  .action((dir) => init(dir || process.cwd()));

program.command('clone <url> [directory]')
  .description('Clone a remote repository locally')
  .action((url, dir) => clone(url, dir));

program.command('config [key] [value]')
  .description('Get or set config values  (e.g. user.name "Anish")')
  .option('-l, --list', 'List all config values')
  .action((key, value, opts) => configCmd(key, value, opts));

program.command('hash-object <file>')
  .description('Compute SHA hash of a file')
  .option('-w, --write', 'Write blob into object store')
  .action((file, opts) => hashObject(file, opts.write));

program.command('add <files...>')
  .description('Stage files for the next commit')
  .action((files) => add(files));

program.command('commit')
  .description('Record staged changes as a new commit')
  .requiredOption('-m, --message <message>', 'Commit message')
  .option('--author <n>', 'Author name (overrides config)')
  .option('--email <e>',  'Author email (overrides config)')
  .action(async (opts) => {
    // Pull name/email from global config if not passed
    const { getConfigValue } = await import('../src/config.js');
    const name  = opts.author || getConfigValue('user.name')  || 'Developer';
    const email = opts.email  || getConfigValue('user.email') || 'dev@gitbro.local';
    commit(opts.message, name, email);
  });

program.command('log')
  .description('Show commit history')
  .action(() => log());

program.command('status')
  .description('Show working tree status')
  .action(() => status());

program.command('branch [name]')
  .description('List, create, or delete branches')
  .option('-d, --delete', 'Delete a branch')
  .action((name, opts) => branch(name, opts));

program.command('checkout <branch>')
  .description('Switch to a branch')
  .action((b) => checkout(b));

program.command('merge <branch>')
  .description('Merge a branch into the current branch')
  .action((b) => merge(b));

program.command('diff')
  .description('Show unstaged changes (--cached for staged)')
  .option('--cached', 'Compare staged vs last commit')
  .action((opts) => diff(opts));

const remote = program.command('remote').description('Manage remote connections');
remote.command('add <n> <url>').action((n, u) => remoteAdd(n, u));
remote.command('remove <n>').action((n) => remoteRemove(n));
remote.action(() => remoteList());

program.command('push [remote] [branch]')
  .description('Push current branch to a remote')
  .action((r, b) => push(r || 'origin', b));

program.command('pull [remote] [branch]')
  .description('Fetch and merge from a remote')
  .action((r, b) => pull(r || 'origin', b));



program.command('webui [path]')
  .description('Launch full GitHub-style web interface')
  .option('-p, --port <port>', 'Port to listen on', '9000')
  .action((repoPath, opts) => webui(repoPath || '.', parseInt(opts.port)));

program.command('commit-amend')
  .description('Amend the last commit (change message or add staged files)')
  .option('-m, --message <message>', 'New commit message (optional)')
  .action((opts) => amend(opts.message));

program.command('amend')
  .description('Alias for commit-amend (amend the last commit)')
  .option('-m, --message <message>', 'New commit message (optional)')
  .action((opts) => amend(opts.message));

program.command('completion [shell]')
  .description('Print shell completion script for bash, zsh, or fish')
  .action((shell = 'bash') => {
    const normalized = String(shell).toLowerCase();
    if (!['bash', 'zsh', 'fish'].includes(normalized)) {
      console.error(`fatal: unsupported shell '${shell}'`);
      process.exit(ExitCode.USAGE);
    }
    process.stdout.write(getCompletionScript(normalized, completionCommands));
  });

program.command('cat-file <hash>')
  .description('Provide content or type and size information for repository objects')
  .option('-p, --pretty', 'Pretty-print the contents of <hash> based on its type')
  .option('-t, --type', 'Show the object type identified by <hash>')
  .option('-s, --size', 'Show the object size identified by <hash>')
  .action((hash, options) => {
    catFile(hash, options);
  });

program.command('rm <files...>')
  .description('Remove files from the working tree and from the index')
  .option('--cached', 'Only remove from the index, keep on disk')
  .action((files, opts) => rm(files, opts));

program.exitOverride();

try {
  program.parse(process.argv);
} catch (error) {
  if (error.code === 'commander.helpDisplayed') {
    process.exit(0);
  }
  if (error.code === 'commander.unknownCommand') {
    process.exit(ExitCode.USAGE);
  }
  console.error(error.message || error);
  process.exit(ExitCode.INTERNAL);
}