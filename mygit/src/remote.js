import fs from 'fs';
import path from 'path';
import { getGitRoot } from './utils/objects.js';
import { fatal, ExitCode } from './utils/cli.js';

const CONFIG_FILE = (gitRoot) => path.join(gitRoot, 'config');

function readConfig(gitRoot) {
  const file = CONFIG_FILE(gitRoot);
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  const config = {};
  let section = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const secMatch = line.match(/^\[(.+)\]$/);
    if (secMatch) { section = secMatch[1]; config[section] = config[section] || {}; continue; }
    const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (kvMatch && section) config[section][kvMatch[1]] = kvMatch[2];
  }
  return config;
}

function writeConfig(gitRoot, config) {
  const lines = [];
  for (const [section, kvs] of Object.entries(config)) {
    lines.push(`[${section}]`);
    for (const [k, v] of Object.entries(kvs)) lines.push(`  ${k} = ${v}`);
  }
  fs.writeFileSync(CONFIG_FILE(gitRoot), lines.join('\n') + '\n');
}

// gitbro remote add <name> <url>
export function remoteAdd(name, url) {
  const gitRoot = getGitRoot();
  const config = readConfig(gitRoot);
  const key = `remote "${name}"`;
  if (config[key]) {
    fatal(`fatal: remote '${name}' already exists`, ExitCode.STATE);
  }
  config[key] = { url, fetch: `+refs/heads/*:refs/remotes/${name}/*` };
  writeConfig(gitRoot, config);
  console.log(`Added remote '${name}' → ${url}`);
}

// gitbro remote remove <name>
export function remoteRemove(name) {
  const gitRoot = getGitRoot();
  const config = readConfig(gitRoot);
  const key = `remote "${name}"`;
  if (!config[key]) { fatal(`fatal: no such remote '${name}'`, ExitCode.STATE); }
  delete config[key];
  writeConfig(gitRoot, config);
  console.log(`Removed remote '${name}'`);
}

// gitbro remote (list)
export function remoteList() {
  const gitRoot = getGitRoot();
  const config = readConfig(gitRoot);
  const remotes = Object.keys(config).filter(k => k.startsWith('remote "'));
  if (!remotes.length) { console.log('No remotes configured.'); return; }
  remotes.forEach(key => {
    const name = key.slice(8, -1);
    console.log(`${name}\t${config[key].url}`);
  });
}

// Get URL for a named remote
export function getRemoteUrl(name) {
  const gitRoot = getGitRoot();
  const config = readConfig(gitRoot);
  const key = `remote "${name}"`;
  if (!config[key]) { fatal(`fatal: no such remote '${name}'`, ExitCode.STATE); }
  return config[key].url;
}