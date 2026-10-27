import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { spawn } from 'child_process';
import { readObject, writeObject, getGitRoot } from './utils/objects.js';
import { getStatusData } from './status.js';
import { add } from './add.js';
import { commit } from './commit.js';

process.on('uncaughtException', (err) => {
  try { fs.appendFileSync('d:/Projects/Hackathon_class/webui.log', `Uncaught Exception: ${err.stack}\n`); } catch {}
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  try { fs.appendFileSync('d:/Projects/Hackathon_class/webui.log', `Unhandled Rejection: ${reason}\n`); } catch {}
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

function getAllObjects(gitRoot) {
  const objectsDir = path.join(gitRoot, 'objects');
  const objects = {};
  if (!fs.existsSync(objectsDir)) return objects;

  for (const prefix of fs.readdirSync(objectsDir)) {
    const prefixDir = path.join(objectsDir, prefix);
    if (!fs.statSync(prefixDir).isDirectory()) continue;
    for (const suffix of fs.readdirSync(prefixDir)) {
      const sha = prefix + suffix;
      try {
        const { type, content } = readObject(sha, gitRoot);
        objects[sha] = { type, content: content.toString('base64') };
      } catch {}
    }
  }

  return objects;
}

function getAllRefs(gitRoot) {
  const refs = {};
  const heads = path.join(gitRoot, 'refs', 'heads');
  if (fs.existsSync(heads)) {
    for (const branch of fs.readdirSync(heads)) {
      refs[`refs/heads/${branch}`] = fs.readFileSync(path.join(heads, branch), 'utf8').trim();
    }
  }
  const headPath = path.join(gitRoot, 'HEAD');
  if (fs.existsSync(headPath)) refs.HEAD = fs.readFileSync(headPath, 'utf8').trim();
  return refs;
}

function getCurrentBranch(gitRoot) {
  const head = fs.readFileSync(path.join(gitRoot, 'HEAD'), 'utf8').trim();
  return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
}

function getHeadCommitSHA(gitRoot) {
  const head = fs.readFileSync(path.join(gitRoot, 'HEAD'), 'utf8').trim();
  if (head.startsWith('ref: ')) {
    const refPath = path.join(gitRoot, head.slice(5));
    if (!fs.existsSync(refPath)) return null;
    return fs.readFileSync(refPath, 'utf8').trim();
  }
  return head;
}

function getBranches(gitRoot) {
  const dir = path.join(gitRoot, 'refs', 'heads');
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const branch of fs.readdirSync(dir)) {
    out[branch] = fs.readFileSync(path.join(dir, branch), 'utf8').trim();
  }
  return out;
}

function parseCommit(content) {
  const text = Buffer.isBuffer(content) ? content.toString() : content;
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

function walkAllCommits(branchMap, gitRoot, limit = 150) {
  const list = [];
  const seen = new Set();
  const queue = Object.values(branchMap).filter(Boolean);

  while (queue.length && list.length < limit) {
    const sha = queue.shift();
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    try {
      const { content } = readObject(sha, gitRoot);
      const commit = parseCommit(content);
      const ts = commit.headers.author?.match(/(\d+) [+-]/)?.[1];
      list.push({
        sha,
        short: sha.slice(0, 7),
        message: commit.message,
        author: (commit.headers.author || '').replace(/<.*/, '').trim(),
        email: (commit.headers.author || '').match(/<(.+)>/)?.[1] || '',
        date: ts ? new Date(+ts * 1000).toISOString() : '',
        parents: [commit.headers.parent, commit.headers.parent2].filter(Boolean),
        tree: commit.headers.tree || '',
      });
      if (commit.headers.parent) queue.push(commit.headers.parent);
      if (commit.headers.parent2) queue.push(commit.headers.parent2);
    } catch {}
  }

  return list.sort((a, b) => new Date(b.date) - new Date(a.date));
}

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
    else files.push({ path: full, sha, mode });
  }
  return files;
}

function getBlobContent(sha, gitRoot) {
  try {
    return readObject(sha, gitRoot).content.toString('utf8');
  } catch {
    return null;
  }
}

function diffLines(oldLines, newLines) {
  const m = oldLines.length;
  const n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const res = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      res.push({ t: 'eq', l: oldLines[i] });
      i++;
      j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      res.push({ t: 'add', l: newLines[j] });
      j++;
    } else {
      res.push({ t: 'del', l: oldLines[i] });
      i++;
    }
  }
  return res;
}

function getCommitDiff(commitSHA, gitRoot) {
  const out = [];
  try {
    const { content: commitContent } = readObject(commitSHA, gitRoot);
    const commit = parseCommit(commitContent);
    const files = commit.headers.tree ? flattenTree(commit.headers.tree, gitRoot) : [];
    let parentFiles = {};
    if (commit.headers.parent) {
      try {
        const { content: parentContent } = readObject(commit.headers.parent, gitRoot);
        const parentCommit = parseCommit(parentContent);
        if (parentCommit.headers.tree) {
          flattenTree(parentCommit.headers.tree, gitRoot).forEach((file) => {
            parentFiles[file.path] = file.sha;
          });
        }
      } catch {}
    }

    const allPaths = new Set([...files.map((file) => file.path), ...Object.keys(parentFiles)]);
    allPaths.forEach((filepath) => {
      const newEntry = files.find((file) => file.path === filepath);
      const oldSHA = parentFiles[filepath];
      const newContent = newEntry ? getBlobContent(newEntry.sha, gitRoot) || '' : '';
      const oldContent = oldSHA ? getBlobContent(oldSHA, gitRoot) || '' : '';
      if (newContent === oldContent) return;

      const edits = diffLines(oldContent.split('\n'), newContent.split('\n'));
      const hunks = [];
      let hunk = null;
      let oi = 1;
      let ni = 1;

      for (const edit of edits) {
        if (edit.t !== 'eq') {
          if (!hunk) hunk = { oldStart: oi, newStart: ni, lines: [] };
          hunk.lines.push(edit);
        } else if (hunk) {
          hunks.push(hunk);
          hunk = null;
        }
        if (edit.t !== 'add') oi++;
        if (edit.t !== 'del') ni++;
      }
      if (hunk) hunks.push(hunk);
      out.push({ path: filepath, isNew: !oldSHA, isDeleted: !newEntry, hunks });
    });
  } catch {}
  return out;
}

function getCommitHistory(commitSHA, gitRoot) {
  const history = [];
  const seen = new Set();
  let current = commitSHA;
  while (current && !seen.has(current)) {
    seen.add(current);
    history.push(current);
    try {
      const { content } = readObject(current, gitRoot);
      const commit = parseCommit(content);
      current = commit.headers.parent || null;
    } catch {
      break;
    }
  }
  return history.reverse();
}

function getFileSnapshotAtCommit(commitSHA, filePath, gitRoot) {
  try {
    const { content } = readObject(commitSHA, gitRoot);
    const commit = parseCommit(content);
    if (!commit.headers.tree) return null;
    const entry = flattenTree(commit.headers.tree, gitRoot).find((item) => item.path === filePath);
    if (!entry) return null;
    return { sha: entry.sha, content: getBlobContent(entry.sha, gitRoot) || '' };
  } catch {
    return null;
  }
}

function buildBlame(filePath, gitRoot) {
  const headSHA = getHeadCommitSHA(gitRoot);
  if (!headSHA) return [];

  const history = getCommitHistory(headSHA, gitRoot);
  const snapshots = history
    .map((sha) => ({ sha, snapshot: getFileSnapshotAtCommit(sha, filePath, gitRoot) }))
    .filter(({ snapshot }) => snapshot && typeof snapshot.content === 'string');

  if (!snapshots.length) return [];

  let lines = snapshots[0].snapshot.content.split('\n');
  let origins = new Array(lines.length).fill(snapshots[0].sha);

  for (let i = 1; i < snapshots.length; i++) {
    const { sha, snapshot } = snapshots[i];
    const nextLines = snapshot.content.split('\n');
    const edits = diffLines(lines, nextLines);
    const mergedLines = [];
    const mergedOrigins = [];
    let oldIndex = 0;

    for (const edit of edits) {
      if (edit.t === 'eq') {
        mergedLines.push(edit.l);
        mergedOrigins.push(origins[oldIndex]);
        oldIndex++;
      } else if (edit.t === 'del') {
        oldIndex++;
      } else if (edit.t === 'add') {
        mergedLines.push(edit.l);
        mergedOrigins.push(sha);
      }
    }

    lines = mergedLines;
    origins = mergedOrigins;
  }

  return lines.map((line, index) => {
    const originSHA = origins[index];
    let author = '';
    let message = '';
    try {
      const { content } = readObject(originSHA, gitRoot);
      const commit = parseCommit(content);
      author = (commit.headers.author || '').replace(/<.*/, '').trim();
      message = commit.message || '';
    } catch {}
    return { line, sha: originSHA, short: originSHA.slice(0, 7), author, message };
  });
}

function getBlameLinesForFile(filePath, gitRoot) {
  return buildBlame(filePath, gitRoot);
}

export function webui(repoPath = '.', port = 5005) {
  try {
    fs.appendFileSync('d:/Projects/Hackathon_class/webui.log', `Starting webui on port ${port} in ${repoPath}\n`);
  } catch {}

  const abs = path.resolve(repoPath);
  process.chdir(abs);
  let gitRoot = null;
  try {
    gitRoot = getGitRoot();
  } catch {
    console.warn('Standby Mode: Not a gitbro repository yet. Use "gitbro init" to start.');
  }

  const repoName = gitRoot ? path.basename(path.dirname(gitRoot)) : 'None';

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const parsedUrl = new URL(req.url, `http://localhost:${port}`);
    const url = parsedUrl.pathname;

    if (req.method === 'GET' && url === '/info/refs') {
      if (!gitRoot) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not a repo' })); return; }
      const payload = { refs: getAllRefs(gitRoot), objects: getAllObjects(gitRoot) };
      const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      res.end(gzipped);
      return;
    }

    if (req.method === 'POST' && url === '/receive') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          let bodyBuf = Buffer.concat(chunks);
          if (req.headers['content-encoding'] === 'gzip') bodyBuf = zlib.gunzipSync(bodyBuf);
          const { refs, objects } = JSON.parse(bodyBuf.toString('utf8'));
          let written = 0;
          for (const [sha, { type, content }] of Object.entries(objects)) {
            const buf = Buffer.from(content, 'base64');
            const objectDir = path.join(gitRoot, 'objects', sha.slice(0, 2));
            const objectFile = path.join(objectDir, sha.slice(2));
            if (!fs.existsSync(objectFile)) {
              fs.mkdirSync(objectDir, { recursive: true });
              fs.writeFileSync(objectFile, zlib.deflateSync(Buffer.concat([Buffer.from(`${type} ${buf.length}\0`), buf])));
              written++;
            }
          }
          for (const [ref, sha] of Object.entries(refs)) {
            if (ref === 'HEAD') continue;
            const refPath = path.join(gitRoot, ref);
            fs.mkdirSync(path.dirname(refPath), { recursive: true });
            fs.writeFileSync(refPath, `${sha}\n`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, written }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    if (url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'gitbro api running', repo: gitRoot ? repoName : 'none' }));
      return;
    }

    if (url === '/api/info') {
      if (!gitRoot) {
        try { gitRoot = getGitRoot(); } catch {}
      }
      if (!gitRoot) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ branches: {}, head: '', files: [], repoName: 'Not a Repository' }));
        return;
      }
      const branches = getBranches(gitRoot);
      const head = getCurrentBranch(gitRoot) || '';
      const headSHA = head ? branches[head] : getHeadCommitSHA(gitRoot);
      let files = [];
      if (headSHA) {
        try {
          const { content } = readObject(headSHA, gitRoot);
          const commit = parseCommit(content);
          if (commit.headers.tree) files = flattenTree(commit.headers.tree, gitRoot);
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ branches, head, files, repoName }));
      return;
    }

    if (url === '/api/status') {
      if (!gitRoot) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ toCommit: [], notStaged: [], untracked: [] }));
        return;
      }
      try {
        const stats = getStatusData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ toCommit: [], notStaged: [], untracked: [], error: error.message }));
      }
      return;
    }

    if (url === '/api/commits') {
      const commits = walkAllCommits(getBranches(gitRoot), gitRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(commits));
      return;
    }

    if (url.startsWith('/api/files/')) {
      const sha = url.slice('/api/files/'.length);
      let files = [];
      try {
        const { content } = readObject(sha, gitRoot);
        const commit = parseCommit(content);
        if (commit.headers.tree) files = flattenTree(commit.headers.tree, gitRoot);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
      return;
    }

    if (url.startsWith('/api/worktree/')) {
      const filepath = decodeURIComponent(url.slice('/api/worktree/'.length));
      const absPath = path.join(path.dirname(gitRoot), filepath);
      if (req.method === 'GET') {
        try {
          const content = fs.readFileSync(absPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ content }));
        } catch {
          res.writeHead(404);
          res.end('{}');
        }
      } else if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => body += chunk);
        req.on('end', () => {
          try {
            fs.writeFileSync(absPath, JSON.parse(body).content, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      }
      return;
    }

    if (url.startsWith('/api/blob/')) {
      const sha = url.slice('/api/blob/'.length);
      try {
        const content = getBlobContent(sha, gitRoot);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content }));
      } catch {
        res.writeHead(404);
        res.end('{}');
      }
      return;
    }

    if (url.startsWith('/api/commitdiff/')) {
      const sha = url.slice('/api/commitdiff/'.length);
      const diff = getCommitDiff(sha, gitRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files: diff }));
      return;
    }

    if (url.startsWith('/api/blame/')) {
      const filePath = decodeURIComponent(url.slice('/api/blame/'.length));
      const blame = getBlameLinesForFile(filePath, gitRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ file: filePath, lines: blame }));
      return;
    }

    if (url === '/api/run' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', async () => {
        try {
          const { cmd } = JSON.parse(body || '{}');
          const parts = String(cmd || '').trim().split(/\s+/).filter(Boolean);
          const sub = parts[0] === 'gitbro' ? parts.slice(1) : parts;
          const gitbroJs = new URL('../bin/gitbro.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1');
          const repoPath = gitRoot ? path.dirname(gitRoot) : process.cwd();
          const proc = spawn(process.execPath, [gitbroJs, ...sub], { cwd: repoPath, env: process.env });
          let out = '';
          let err = '';
          proc.stdout.on('data', (chunk) => out += chunk);
          proc.stderr.on('data', (chunk) => err += chunk);
          proc.on('close', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: out.trim(), error: err.trim() }));
          });
        } catch (error) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    if (url === '/api/commit' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        try {
          const { message, stageAll = true } = JSON.parse(body || '{}');
          if (!message || !String(message).trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Commit message is required' }));
            return;
          }
          if (stageAll) add(['.']);
          commit(String(message).trim());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (error) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Error: Port ${port} is already in use. Try a different port.`);
      process.exit(1);
    }
    console.error(error);
  });

  server.listen(port, () => {
    console.log(`\x1b[32mGitBro Web UI → http://localhost:${port}\x1b[0m`);
    console.log('Full GitHub-style interface. Ctrl+C to stop.\n');
  });
}
