import fs from 'fs';
import path from 'path';
import { readObject, writeObject, getGitRoot } from './utils/objects.js';
import { readIndex, writeIndex } from './add.js';
import { getConfigValue } from './config.js';
import { fatal, ExitCode } from './utils/cli.js';

function getHeadCommit(gitRoot) {
  const head = fs.readFileSync(path.join(gitRoot, 'HEAD'), 'utf8').trim();
  if (head.startsWith('ref: ')) {
    const refPath = path.join(gitRoot, head.slice(5));
    if (!fs.existsSync(refPath)) return null;
    return fs.readFileSync(refPath, 'utf8').trim();
  }
  return head;
}

function parseCommit(content) {
  const text  = Buffer.isBuffer(content) ? content.toString() : content;
  const lines = text.split('\n');
  const h = {}; let i = 0;
  while (i < lines.length && lines[i] !== '') {
    const sp = lines[i].indexOf(' ');
    h[lines[i].slice(0, sp)] = lines[i].slice(sp + 1); i++;
  }
  return { headers: h, message: lines.slice(i + 1).join('\n').trim() };
}

function buildTree(index, gitRoot) {
  let buf = Buffer.alloc(0);
  for (const filePath of Object.keys(index).sort()) {
    const hash     = index[filePath];
    const filename = path.basename(filePath);
    const entry    = Buffer.from(`100644 ${filename}\0`);
    const hashBin  = Buffer.from(hash, 'hex');
    buf = Buffer.concat([buf, entry, hashBin]);
  }
  return writeObject('tree', buf, gitRoot);
}

function updateHead(gitRoot, sha) {
  const head = fs.readFileSync(path.join(gitRoot, 'HEAD'), 'utf8').trim();
  if (head.startsWith('ref: ')) {
    const refPath = path.join(gitRoot, head.slice(5));
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, sha + '\n');
  } else {
    fs.writeFileSync(path.join(gitRoot, 'HEAD'), sha + '\n');
  }
}

export function amend(newMessage) {
  const gitRoot    = getGitRoot();
  const index      = readIndex(gitRoot);
  const headSHA    = getHeadCommit(gitRoot);

  if (!headSHA) {
    fatal('fatal: nothing to amend -- no commits yet', ExitCode.STATE);
  }

  // Read the existing last commit
  const { content } = readObject(headSHA, gitRoot);
  const old = parseCommit(content);

  // If there are staged files, build a new tree. Otherwise reuse old tree.
  let treeSHA;
  if (Object.keys(index).length > 0) {
    treeSHA = buildTree(index, gitRoot);
  } else {
    treeSHA = old.headers.tree;
  }

  // Keep original author, update committer timestamp
  const timestamp = Math.floor(Date.now() / 1000);
  const name      = getConfigValue('user.name')  || 'Developer';
  const email     = getConfigValue('user.email') || 'dev@gitbro.local';
  const message   = newMessage || old.message;

  // Preserve the parent of the OLD commit (we are REPLACING it, not adding on top)
  let commitContent = `tree ${treeSHA}\n`;
  if (old.headers.parent) commitContent += `parent ${old.headers.parent}\n`;
  commitContent += `author ${old.headers.author}\n`;
  commitContent += `committer ${name} <${email}> ${timestamp} +0000\n`;
  commitContent += `\n${message}\n`;

  const newSHA = writeObject('commit', commitContent, gitRoot);
  updateHead(gitRoot, newSHA);
  writeIndex(gitRoot, {});

  console.log(`[amended ${newSHA.slice(0, 7)}] ${message}`);
  if (Object.keys(index).length > 0)
    console.log(`  ${Object.keys(index).length} file(s) added to amendment`);
}