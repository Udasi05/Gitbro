import fs from 'fs';
import path from 'path';
import { readObject, getGitRoot } from './utils/objects.js';
import { fatal, ExitCode } from './utils/cli.js';

function getHeadSHA(gitRoot) {
  const headPath = path.join(gitRoot, 'HEAD');
  const headContent = fs.readFileSync(headPath, 'utf8').trim();
  if (headContent.startsWith('ref: ')) {
    const refPath = path.join(gitRoot, headContent.slice(5));
    if (!fs.existsSync(refPath)) return null;
    return fs.readFileSync(refPath, 'utf8').trim();
  }
  return headContent;
}

function getCurrentBranch(gitRoot) {
  const headContent = fs.readFileSync(path.join(gitRoot, 'HEAD'), 'utf8').trim();
  if (headContent.startsWith('ref: refs/heads/')) {
    return headContent.slice('ref: refs/heads/'.length);
  }
  return null;
}

function listBranches(gitRoot) {
  const headsDir = path.join(gitRoot, 'refs', 'heads');
  if (!fs.existsSync(headsDir)) return [];
  return fs.readdirSync(headsDir);
}

/**
 * Flatten a tree object into an array of relative file paths.
 */
function flattenTree(treeSHA, gitRoot, prefix = '') {
  const { content } = readObject(treeSHA, gitRoot);
  const files = [];
  let offset = 0;
  while (offset < content.length) {
    const nullIdx = content.indexOf(0, offset);
    const [mode, name] = content.slice(offset, nullIdx).toString().split(' ');
    const sha = content.slice(nullIdx + 1, nullIdx + 21).toString('hex');
    offset = nullIdx + 21;
    const full = prefix ? `${prefix}/${name}` : name;
    if (mode === '40000') files.push(...flattenTree(sha, gitRoot, full));
    else files.push(full);
  }
  return files;
}

/**
 * Get the tree SHA from a commit object.
 */
function getCommitTreeSHA(commitSHA, gitRoot) {
  const { content } = readObject(commitSHA, gitRoot);
  const match = content.toString().match(/^tree ([a-f0-9]{40})/m);
  if (!match) throw new Error('Corrupt commit object');
  return match[1];
}

export function deleteBranch(branchName) {
  const gitRoot = getGitRoot();
  const current = getCurrentBranch(gitRoot);
  const refPath = path.join(gitRoot, 'refs', 'heads', branchName);

  if (!fs.existsSync(refPath)) {
    fatal(`error: branch '${branchName}' not found.`, ExitCode.STATE);
  }

  if (branchName === current) {
    fatal(`error: cannot delete branch '${branchName}' used by HEAD`, ExitCode.STATE);
  }

  fs.unlinkSync(refPath);
  console.log(`Deleted branch '${branchName}'.`);
}

export function branch(branchName, options = {}) {
  const gitRoot = getGitRoot();

  if (options.delete) {
    deleteBranch(branchName);
    return;
  }

  if (!branchName) {
    const branches = listBranches(gitRoot);
    const current = getCurrentBranch(gitRoot);
    branches.forEach(b => {
      const prefix = b === current ? '\x1b[32m* ' : '  ';
      console.log(`${prefix}${b}\x1b[0m`);
    });
    return;
  }

  const sha = getHeadSHA(gitRoot);
  if (!sha) {
    fatal('fatal: Not a valid object name: HEAD (no commits yet)', ExitCode.STATE);
  }

  const refPath = path.join(gitRoot, 'refs', 'heads', branchName);
  if (fs.existsSync(refPath)) {
    fatal(`fatal: A branch named '${branchName}' already exists`, ExitCode.STATE);
  }

  fs.writeFileSync(refPath, sha + '\n');
  console.log(`Created branch '${branchName}' at ${sha.slice(0, 7)}`);
}

function restoreTree(treeSHA, gitRoot, targetDir) {
  const { content } = readObject(treeSHA, gitRoot);
  let offset = 0;
  while (offset < content.length) {
    const nullIdx = content.indexOf(0, offset);
    const entryHeader = content.slice(offset, nullIdx).toString();
    const [mode, filename] = entryHeader.split(' ');
    const fileSHA = content.slice(nullIdx + 1, nullIdx + 21).toString('hex');
    offset = nullIdx + 21;
    const filePath = path.join(targetDir, filename);
    if (mode === '40000') {
      fs.mkdirSync(filePath, { recursive: true });
      restoreTree(fileSHA, gitRoot, filePath);
    } else {
      const { content: fileContent } = readObject(fileSHA, gitRoot);
      fs.writeFileSync(filePath, fileContent);
    }
  }
}

export function checkout(branchName) {
  const gitRoot = getGitRoot();
  const repoRoot = path.dirname(gitRoot);
  const refPath = path.join(gitRoot, 'refs', 'heads', branchName);

  if (!fs.existsSync(refPath)) {
    fatal(`error: pathspec '${branchName}' did not match any branch`, ExitCode.STATE);
  }

  const targetSHA = fs.readFileSync(refPath, 'utf8').trim();
  const targetTreeSHA = getCommitTreeSHA(targetSHA, gitRoot);
  const targetFiles = new Set(flattenTree(targetTreeSHA, gitRoot));

  // Get current commit's files so we can remove ones not in the target
  const currentSHA = getHeadSHA(gitRoot);
  if (currentSHA) {
    try {
      const currentTreeSHA = getCommitTreeSHA(currentSHA, gitRoot);
      const currentFiles = flattenTree(currentTreeSHA, gitRoot);

      for (const file of currentFiles) {
        if (!targetFiles.has(file)) {
          // This file exists in current branch but NOT in target → remove it
          const filePath = path.join(repoRoot, file.split('/').join(path.sep));
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          // Clean up empty parent directories
          let dir = path.dirname(filePath);
          while (dir !== repoRoot) {
            try {
              const entries = fs.readdirSync(dir);
              if (entries.length === 0) {
                fs.rmdirSync(dir);
                dir = path.dirname(dir);
              } else {
                break;
              }
            } catch { break; }
          }
        }
      }
    } catch {
      // If current commit can't be read, skip cleanup
    }
  }

  // Restore the target branch's files
  restoreTree(targetTreeSHA, gitRoot, repoRoot);
  fs.writeFileSync(path.join(gitRoot, 'HEAD'), `ref: refs/heads/${branchName}\n`);
  console.log(`Switched to branch '${branchName}'`);
}