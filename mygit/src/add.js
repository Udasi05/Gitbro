import fs from 'fs';
import path from 'path';
import { writeObject, getGitRoot } from './utils/objects.js';
import { loadIgnore, isIgnored } from './utils/ignore.js';
import { fatal, ExitCode } from './utils/cli.js';

export function readIndex(gitRoot) {
  const indexPath = path.join(gitRoot, 'index');
  if (!fs.existsSync(indexPath)) return {};
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

export function writeIndex(gitRoot, index) {
  const indexPath = path.join(gitRoot, 'index');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

export function add(files) {
  const gitRoot = getGitRoot();
  const index = readIndex(gitRoot);
  const cwd = process.cwd();
  
  const ignoreRules = loadIgnore(gitRoot);

  const processPath = (absPath) => {
    if (!fs.existsSync(absPath)) return;
    
    const relPath = path.relative(cwd, absPath).split(path.sep).join('/');
    
    // Check if the current path is ignored
    if (isIgnored(relPath, ignoreRules)) return;

    if (fs.statSync(absPath).isDirectory()) {
      for (const child of fs.readdirSync(absPath)) {
        processPath(path.join(absPath, child));
      }
    } else {
      const content = fs.readFileSync(absPath);
      const hash = writeObject('blob', content, gitRoot);
      index[relPath] = hash;
      console.log(`add '${relPath}'`);
    }
  };

  for (const file of files) {
    const absPath = path.resolve(cwd, file);
    const relPath = path.relative(cwd, absPath).split(path.sep).join('/');

    if (!fs.existsSync(absPath)) {
      // If it exists in index but not on disk, stage the removal
      if (index[relPath]) {
        delete index[relPath];
        console.log(`remove '${relPath}'`);
      } else {
        fatal(`fatal: pathspec '${file}' did not match any files`, ExitCode.USAGE);
      }
    } else {
      processPath(absPath);
    }
  }

  writeIndex(gitRoot, index);
}