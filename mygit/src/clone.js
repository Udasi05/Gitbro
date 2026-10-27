import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { getGitRoot } from './utils/objects.js';
import { init } from './init.js';
import { fatal, ExitCode } from './utils/cli.js';

async function getJSON(url) {
  try {
    const result = await fetch(url, {
      headers: { 'Bypass-Tunnel-Reminder': 'true' }
    });
    if (!result.ok) throw new Error(`HTTP ${result.status}`);
    const text = await result.text();
    try { return JSON.parse(text); }
    catch { throw new Error('invalid JSON from server'); }
  } catch (err) {
    throw err;
  }
}

function readObject(sha, gitRoot) {
  const file = path.join(gitRoot, 'objects', sha.slice(0,2), sha.slice(2));
  const raw  = zlib.inflateSync(fs.readFileSync(file));
  const ni   = raw.indexOf(0);
  const [type] = raw.slice(0, ni).toString().split(' ');
  return { type, content: raw.slice(ni + 1) };
}

function restoreTree(treeSHA, gitRoot, dir) {
  const { content } = readObject(treeSHA, gitRoot);
  let offset = 0;
  while (offset < content.length) {
    const ni   = content.indexOf(0, offset);
    const [mode, name] = content.slice(offset, ni).toString().split(' ');
    const sha  = content.slice(ni + 1, ni + 21).toString('hex');
    offset     = ni + 21;
    const dest = path.join(dir, name);
    if (mode === '40000') {
      fs.mkdirSync(dest, { recursive: true });
      restoreTree(sha, gitRoot, dest);
    } else {
      const { content: blob } = readObject(sha, gitRoot);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, blob);
    }
  }
}

export async function clone(remoteUrl, targetDir) {
  // Derive folder name from URL if not given
  if (!targetDir) {
    targetDir = remoteUrl.split('/').pop().replace(/\.git$/, '') || 'repo';
  }

  const absTarget = path.resolve(process.cwd(), targetDir);

  if (fs.existsSync(absTarget)) {
    fatal(`fatal: destination '${targetDir}' already exists`, ExitCode.USAGE);
  }

  console.log(`Cloning from ${remoteUrl} into '${targetDir}'...`);

  // Fetch all refs + objects from remote
  let payload;
  try {
    payload = await getJSON(`${remoteUrl}/info/refs`);
  } catch(e) {
    fatal(`fatal: could not reach '${remoteUrl}'\n  ${e.message}`, ExitCode.NETWORK);
  }

  const { refs, objects } = payload;

  // Determine default branch
  const headRef = refs['HEAD'];
  const branch  = headRef?.startsWith('ref: refs/heads/')
    ? headRef.slice(16)
    : 'main';
  const tipSHA  = refs[`refs/heads/${branch}`];

  if (!tipSHA) {
    fatal(`fatal: remote has no commits on '${branch}'`, ExitCode.STATE);
  }

  // Create the target directory and init
  fs.mkdirSync(absTarget, { recursive: true });
  process.chdir(absTarget);
  init(absTarget);

  const gitRoot = path.join(absTarget, '.gitbro');

  // Write all objects
  let written = 0;
  for (const [sha, { type, content }] of Object.entries(objects)) {
    const buf     = Buffer.from(content, 'base64');
    const objDir  = path.join(gitRoot, 'objects', sha.slice(0,2));
    const objFile = path.join(objDir, sha.slice(2));
    if (!fs.existsSync(objFile)) {
      const header = Buffer.from(`${type} ${buf.length}\0`);
      fs.mkdirSync(objDir, { recursive: true });
      fs.writeFileSync(objFile, zlib.deflateSync(Buffer.concat([header, buf])));
      written++;
    }
  }

  // Write branch ref + HEAD
  const refPath = path.join(gitRoot, 'refs', 'heads', branch);
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(refPath, tipSHA + '\n');
  fs.writeFileSync(path.join(gitRoot, 'HEAD'), `ref: refs/heads/${branch}\n`);

  // Store remote origin in config
  const configPath = path.join(gitRoot, 'config');
  fs.appendFileSync(configPath,
    `\n[remote "origin"]\n  url = ${remoteUrl}\n  fetch = +refs/heads/*:refs/remotes/origin/*\n`
  );

  // Restore working directory
  const { content } = readObject(tipSHA, gitRoot);
  const treeMatch   = content.toString().match(/^tree ([a-f0-9]{40})/m);
  if (treeMatch) restoreTree(treeMatch[1], gitRoot, absTarget);

  console.log(`\x1b[32mDone! ${written} objects received.\x1b[0m`);
  console.log(`Branch: ${branch}  HEAD: ${tipSHA.slice(0,7)}`);
  console.log(`\ncd ${targetDir}`);
}