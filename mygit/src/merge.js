import fs from 'fs';
import path from 'path';
import { readObject, writeObject, getGitRoot } from './utils/objects.js';
import { readIndex, writeIndex } from './add.js';
import { fatal, ExitCode } from './utils/cli.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function getGitRepoRoot(gitRoot) { return path.dirname(gitRoot); }

function getCurrentBranch(gitRoot) {
  const head = fs.readFileSync(path.join(gitRoot, 'HEAD'), 'utf8').trim();
  return head.startsWith('ref: refs/heads/') ? head.slice(16) : null;
}

function getBranchSHA(gitRoot, branch) {
  const refPath = path.join(gitRoot, 'refs', 'heads', branch);
  if (!fs.existsSync(refPath)) return null;
  return fs.readFileSync(refPath, 'utf8').trim();
}

function setBranchSHA(gitRoot, branch, sha) {
  const refPath = path.join(gitRoot, 'refs', 'heads', branch);
  fs.writeFileSync(refPath, sha + '\n');
}

function parseCommit(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content;
  const lines = text.split('\n');
  const headers = {};
  let i = 0;
  while (i < lines.length && lines[i] !== '') {
    const sp = lines[i].indexOf(' ');
    headers[lines[i].slice(0, sp)] = lines[i].slice(sp + 1);
    i++;
  }
  return { headers, message: lines.slice(i + 1).join('\n').trim() };
}

// ── ancestor walking ─────────────────────────────────────────────────────────

// Return all ancestor SHAs of a commit (including itself) as a Set
function getAncestors(sha, gitRoot) {
  const visited = new Set();
  const queue = [sha];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || visited.has(cur)) continue;
    visited.add(cur);
    try {
      const { content } = readObject(cur, gitRoot);
      const { headers } = parseCommit(content);
      if (headers.parent) queue.push(headers.parent);
    } catch { }
  }
  return visited;
}

// Find the best common ancestor (lowest common ancestor in commit DAG)
function findLCA(shaA, shaB, gitRoot) {
  const ancestorsA = getAncestors(shaA, gitRoot);
  // Walk B's ancestors; first one found in A's set is the LCA
  const queue = [shaB];
  const visited = new Set();
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || visited.has(cur)) continue;
    visited.add(cur);
    if (ancestorsA.has(cur)) return cur;
    try {
      const { content } = readObject(cur, gitRoot);
      const { headers } = parseCommit(content);
      if (headers.parent) queue.push(headers.parent);
    } catch { }
  }
  return null;
}

// ── tree helpers ─────────────────────────────────────────────────────────────

function readTree(treeSHA, gitRoot, prefix = '') {
  const { content } = readObject(treeSHA, gitRoot);
  const files = {};
  let offset = 0;
  while (offset < content.length) {
    const nullIdx = content.indexOf(0, offset);
    const header = content.slice(offset, nullIdx).toString();
    const [mode, name] = header.split(' ');
    const sha = content.slice(nullIdx + 1, nullIdx + 21).toString('hex');
    offset = nullIdx + 21;
    const fullPath = prefix ? `${prefix}/${name}` : name;
    if (mode === '40000') Object.assign(files, readTree(sha, gitRoot, fullPath));
    else files[fullPath] = { sha, mode };
  }
  return files;
}

function getCommitTree(commitSHA, gitRoot) {
  const { content } = readObject(commitSHA, gitRoot);
  const match = content.toString().match(/^tree ([a-f0-9]{40})/m);
  if (!match) throw new Error(`No tree in commit ${commitSHA}`);
  return readTree(match[1], gitRoot);
}

// Write a tree object from { filepath: { sha, mode } }
function writeTree(files, gitRoot) {
  let buf = Buffer.alloc(0);
  for (const [filepath, { sha, mode }] of Object.entries(files).sort()) {
    const filename = path.basename(filepath);
    const entry = Buffer.from(`${mode} ${filename}\0`);
    const hashBin = Buffer.from(sha, 'hex');
    buf = Buffer.concat([buf, entry, hashBin]);
  }
  return writeObject('tree', buf, gitRoot);
}

// ── three-way merge of file content ──────────────────────────────────────────

function mergeLines(base, ours, theirs) {
  // If either side is unchanged, take the changed side
  if (ours === base) return { content: theirs, conflict: false };
  if (theirs === base) return { content: ours, conflict: false };
  if (ours === theirs) return { content: ours, conflict: false };

  // Both sides changed — mark conflict
  const conflict = [
    '<<<<<<< HEAD',
    ours,
    '=======',
    theirs,
    '>>>>>>> incoming',
  ].join('\n');
  return { content: conflict, conflict: true };
}

function getBlobContent(sha, gitRoot) {
  const { content } = readObject(sha, gitRoot);
  return content.toString('utf8');
}

// ── main merge ───────────────────────────────────────────────────────────────

export function merge(branchName) {
  const gitRoot = getGitRoot();
  const repoRoot = getGitRepoRoot(gitRoot);
  const currentBranch = getCurrentBranch(gitRoot);

  if (!currentBranch) {
    fatal('fatal: not on a branch (detached HEAD)', ExitCode.STATE);
  }

  const ourSHA = getBranchSHA(gitRoot, currentBranch);
  const theirSHA = getBranchSHA(gitRoot, branchName);

  if (!theirSHA) {
    fatal(`fatal: branch '${branchName}' not found`, ExitCode.STATE);
  }

  if (ourSHA === theirSHA) {
    console.log('Already up to date.');
    return;
  }

  // ── fast-forward? ────────────────────────────────────────────────────────
  const theirAncestors = getAncestors(theirSHA, gitRoot);
  if (theirAncestors.has(ourSHA)) {
    // Our HEAD is an ancestor of theirs → pure fast-forward
    const theirTree = getCommitTree(theirSHA, gitRoot);

    // Restore working directory files
    for (const [file, { sha }] of Object.entries(theirTree)) {
      const dest = path.join(repoRoot, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const { content } = readObject(sha, gitRoot);
      fs.writeFileSync(dest, content);
    }

    setBranchSHA(gitRoot, currentBranch, theirSHA);
    console.log(`Updating ${ourSHA.slice(0, 7)}..${theirSHA.slice(0, 7)}`);
    console.log(`Fast-forward`);
    console.log(`Merge made by fast-forward.`);
    return;
  }

  // ── three-way merge ───────────────────────────────────────────────────────
  const lcaSHA = findLCA(ourSHA, theirSHA, gitRoot);
  if (!lcaSHA) {
    fatal('fatal: no common ancestor found (unrelated histories)', ExitCode.STATE);
  }

  const baseTree = lcaSHA ? getCommitTree(lcaSHA, gitRoot) : {};
  const ourTree = getCommitTree(ourSHA, gitRoot);
  const theirTree = getCommitTree(theirSHA, gitRoot);

  const allFiles = new Set([
    ...Object.keys(baseTree),
    ...Object.keys(ourTree),
    ...Object.keys(theirTree),
  ]);

  const mergedTree = {};
  let conflicts = 0;
  const stats = { added: [], modified: [], deleted: [], conflicted: [] };

  for (const file of allFiles) {
    const base = baseTree[file]?.sha || null;
    const ours = ourTree[file]?.sha || null;
    const theirs = theirTree[file]?.sha || null;
    const mode = ourTree[file]?.mode || theirTree[file]?.mode || '100644';

    // File deleted on both sides relative to base → skip
    if (!ours && !theirs) continue;

    // File only in theirs (added by them) → take it
    if (!ours && theirs) {
      mergedTree[file] = { sha: theirs, mode };
      stats.added.push(file);
      const { content } = readObject(theirs, gitRoot);
      const dest = path.join(repoRoot, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
      continue;
    }

    // File only in ours → keep it
    if (ours && !theirs) {
      mergedTree[file] = { sha: ours, mode };
      continue;
    }

    // Both have it → check if same
    if (ours === theirs) {
      mergedTree[file] = { sha: ours, mode };
      continue;
    }

    // Both changed from base → three-way merge content
    const baseContent = base ? getBlobContent(base, gitRoot) : '';
    const ourContent = getBlobContent(ours, gitRoot);
    const theirContent = getBlobContent(theirs, gitRoot);

    const { content: merged, conflict } = mergeLines(baseContent, ourContent, theirContent);

    if (conflict) {
      conflicts++;
      stats.conflicted.push(file);
    } else {
      stats.modified.push(file);
    }

    // Write merged content as new blob
    const mergedSHA = writeObject('blob', merged, gitRoot);
    mergedTree[file] = { sha: mergedSHA, mode };

    const dest = path.join(repoRoot, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, merged);
  }

  if (conflicts > 0) {
    // Don't create a merge commit — leave it for the user to resolve
    console.log(`Auto-merging finished with ${conflicts} conflict(s).`);
    stats.conflicted.forEach(f => console.log(`  CONFLICT: ${f}`));
    console.log(`\nFix conflicts then run: gitbro add <file> && gitbro commit -m "Merge branch '${branchName}'"`);
    return;
  }

  // Build the merge commit
  const newTreeSHA = writeTree(mergedTree, gitRoot);
  const timestamp = Math.floor(Date.now() / 1000);
  const commitContent = [
    `tree ${newTreeSHA}`,
    `parent ${ourSHA}`,
    `parent ${theirSHA}`,
    `author Developer <dev@gitbro.local> ${timestamp} +0000`,
    `committer Developer <dev@gitbro.local> ${timestamp} +0000`,
    '',
    `Merge branch '${branchName}'`,
    '',
  ].join('\n');

  const mergeCommitSHA = writeObject('commit', commitContent, gitRoot);
  setBranchSHA(gitRoot, currentBranch, mergeCommitSHA);
  writeIndex(gitRoot, {});

  console.log(`Merge made by the 'ort' strategy.`);
  if (stats.added.length) stats.added.forEach(f => console.log(` \x1b[32mnew file:  ${f}\x1b[0m`));
  if (stats.modified.length) stats.modified.forEach(f => console.log(` \x1b[33mmodified:  ${f}\x1b[0m`));
  if (stats.deleted.length) stats.deleted.forEach(f => console.log(` \x1b[31mdeleted:   ${f}\x1b[0m`));
}