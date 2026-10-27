import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readObject, getGitRoot } from './utils/objects.js';
import { readIndex } from './add.js';
import { loadIgnore, isIgnored } from './utils/ignore.js';

// Helper function to read files with retry logic for EBUSY errors (Windows file locking)
function readFileSyncWithRetry(filepath, encoding = 'utf8', maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return fs.readFileSync(filepath, encoding);
    } catch (error) {
      if (error.code === 'EBUSY' || error.code === 'EACCES') {
        lastError = error;
        // Exponential backoff: 10ms, 20ms, 40ms
        const delay = 10 * Math.pow(2, attempt);
        const start = Date.now();
        while (Date.now() - start < delay) {} // Busy wait
      } else {
        throw error; // Re-throw non-EBUSY errors
      }
    }
  }
  throw lastError; // Throw after all retries exhausted
}

function getCurrentBranch(gitRoot) {
  const head = fs.readFileSync(path.join(gitRoot, 'HEAD'), 'utf8').trim();
  return head.startsWith('ref: refs/heads/') ? head.slice(16) : 'HEAD (detached)';
}

function getCommittedFiles(gitRoot) {
  const head = fs.readFileSync(path.join(gitRoot, 'HEAD'), 'utf8').trim();
  let commitSHA = null;
  if (head.startsWith('ref: ')) {
    const refPath = path.join(gitRoot, head.slice(5));
    if (!fs.existsSync(refPath)) return {};
    commitSHA = fs.readFileSync(refPath, 'utf8').trim();
  } else {
    commitSHA = head;
  }
  try {
    const { content } = readObject(commitSHA, gitRoot);
    const match = content.toString().match(/^tree ([a-f0-9]{40})/m);
    if (!match) return {};
    return readTreeFlat(match[1], gitRoot);
  } catch { return {}; }
}

function readTreeFlat(treeSHA, gitRoot, prefix = '') {
  const { content } = readObject(treeSHA, gitRoot);
  const files = {};
  let offset = 0;
  while (offset < content.length) {
    const nullIdx = content.indexOf(0, offset);
    const [mode, name] = content.slice(offset, nullIdx).toString().split(' ');
    const sha = content.slice(nullIdx + 1, nullIdx + 21).toString('hex');
    offset = nullIdx + 21;
    const full = prefix ? `${prefix}/${name}` : name;
    if (mode === '40000') Object.assign(files, readTreeFlat(sha, gitRoot, full));
    else files[full] = sha;
  }
  return files;
}

function hashFileContent(filepath) {
  const content = readFileSyncWithRetry(filepath, null); // null for binary
  const header = Buffer.from(`blob ${content.length}\0`);
  return crypto.createHash('sha1').update(Buffer.concat([header, content])).digest('hex');
}

function getWorkingFiles(dir, base = dir, rules) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(base, full).split(path.sep).join('/');
      
      if (isIgnored(rel, rules)) continue;
      
      if (e.isDirectory()) results.push(...getWorkingFiles(full, base, rules));
      else results.push(rel);
    }
  } catch (err) {}
  return results;
}

export function getStatusData() {
  const gitRoot = getGitRoot();
  const repoRoot = path.dirname(gitRoot);
  const rules = loadIgnore(gitRoot);

  const index = readIndex(gitRoot);       
  const committed = getCommittedFiles(gitRoot); 

  const allFiles = new Set([
    ...Object.keys(index),
    ...Object.keys(committed),
    ...getWorkingFiles(repoRoot, repoRoot, rules),
  ]);

  const toCommit = [];
  for (const file of Object.keys(index)) {
    if (!committed[file]) toCommit.push({ type: 'new file', file });
    else if (committed[file] !== index[file]) toCommit.push({ type: 'modified', file });
  }

  const notStaged = [];
  for (const file of allFiles) {
    const diskPath = path.join(repoRoot, file);
    const isTracked = committed[file] !== undefined;
    if (!isTracked) continue;

    if (!fs.existsSync(diskPath)) {
      notStaged.push({ type: 'deleted', file });
    } else {
      const diskSHA = hashFileContent(diskPath);
      const baseSHA = index[file] || committed[file];
      if (diskSHA !== baseSHA) {
        notStaged.push({ type: 'modified', file });
      }
    }
  }

  const untracked = getWorkingFiles(repoRoot, repoRoot, rules).filter(
    f => !committed[f] && !index[f]
  );

  const checkConflict = (fileObj) => {
    if (fileObj.type !== 'deleted') {
      const p = path.join(repoRoot, fileObj.file);
      if (fs.existsSync(p)) {
        const c = readFileSyncWithRetry(p, 'utf8');
        if (c.includes('<<<<<<< HEAD')) {
          fileObj.isConflict = true;
        }
      }
    }
  };
  notStaged.forEach(checkConflict);
  toCommit.forEach(checkConflict);

  return {
    branch: getCurrentBranch(gitRoot),
    toCommit,
    notStaged,
    untracked
  };
}

export function status() {
  const data = getStatusData();
  console.log(`On branch ${data.branch}`);
  console.log('');
  if (data.toCommit.length) {
    console.log('Changes to be committed:');
    data.toCommit.forEach(({ type, file }) =>
      console.log(`\t\x1b[32m${type.padEnd(12)}${file}\x1b[0m`));
    console.log('');
  }
  if (data.notStaged.length) {
    console.log('Changes not staged for commit:');
    data.notStaged.forEach(({ type, file }) =>
      console.log(`\t\x1b[31m${type.padEnd(12)}${file}\x1b[0m`));
    console.log('');
  }
  if (data.untracked.length) {
    console.log('Untracked files:');
    data.untracked.forEach(f => console.log(`\t\x1b[31m${f}\x1b[0m`));
    console.log('');
  }
  if (!data.toCommit.length && !data.notStaged.length && !data.untracked.length) {
    console.log('nothing to commit, working tree clean');
  }
}