#!/usr/bin/env node
/**
 * Publish this folder to GitHub without git.
 *
 * The machine this plugin was built on has no git binary, so the repository is
 * created through the GitHub REST API instead: blobs → tree → commit → ref. One
 * commit, no history rewriting, no force-push.
 *
 * Usage:
 *   GITHUB_TOKEN=... node scripts/publish-github.mjs --repo dsh-loan-cal --dry-run
 *   GITHUB_TOKEN=... node scripts/publish-github.mjs --repo dsh-loan-cal --push
 *
 * Flags:
 *   --repo <name>     repository name (default: package.json name)
 *   --owner <login>   owner (default: the token's own user)
 *   --branch <name>   branch to write (default: main)
 *   --private         create a private repository
 *   --push            actually write; without it the script only prints the plan
 *
 * The token needs the `repo` scope. It is never printed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const API = 'https://api.github.com';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const token = process.env.GITHUB_TOKEN ?? '';
const dryRun = !flag('push');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const repoName = value('repo', pkg.name);
const branch = value('branch', 'main');
const privateRepo = flag('private');

if (token === '' && !dryRun) {
  console.error('GITHUB_TOKEN is not set. Create a token with the `repo` scope and export it.');
  process.exit(2);
}

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-loan-cal-publisher',
  'content-type': 'application/json',
};

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text === '' ? null : JSON.parse(text);
  if (!response.ok) {
    const message = json?.message ?? text;
    const error = new Error(`${method} ${path} → ${response.status}: ${message}`);
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

/** Everything that belongs in the repository, and nothing that does not. */
function collectFiles(root) {
  const skip = new Set(['.git', 'node_modules', '.npmcache', 'asar-out']);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      if (entry.name.endsWith('.tgz')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  return files.map((file) => ({ path: relative(root, file).split(sep).join('/'), full: file }));
}

const files = collectFiles('.').filter((file) => file.path !== 'package-lock.json');
console.log(`plan: ${files.length} files → ${repoName}@${branch}${dryRun ? ' (dry run)' : ''}`);
for (const file of files) console.log(`  ${file.path}`);

if (dryRun) {
  console.log('\nNothing was written. Re-run with --push to create the repository and commit.');
  process.exit(0);
}

const user = await call('GET', '/user');
const owner = value('owner', user.login);
console.log(`authenticated as ${owner}`);

try {
  await call('POST', '/user/repos', {
    name: repoName,
    description: pkg.description,
    private: privateRepo,
    has_issues: true,
    has_wiki: false,
  });
  console.log(`created repository ${owner}/${repoName}`);
} catch (error) {
  if (error.status !== 422) throw error;
  console.log(`repository ${owner}/${repoName} already exists, committing on top of it`);
}

// Parent commit, so a re-run adds a commit instead of rewriting history.
let parents = [];
try {
  const ref = await call('GET', `/repos/${owner}/${repoName}/git/ref/heads/${branch}`);
  parents = [ref.object.sha];
  console.log(`parent commit ${ref.object.sha}`);
} catch (error) {
  if (error.status !== 404) throw error;
  console.log('empty repository: this will be the first commit');
}

const tree = [];
for (const file of files) {
  const content = readFileSync(file.full);
  const blob = await call('POST', `/repos/${owner}/${repoName}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
}

const treeResult = await call('POST', `/repos/${owner}/${repoName}/git/trees`, { tree });
const commit = await call('POST', `/repos/${owner}/${repoName}/git/commits`, {
  message: `${pkg.name} ${pkg.version}\n\nInitial public release: six loan tools, zero runtime dependencies.\n`,
  tree: treeResult.sha,
  parents,
});

await call('POST', `/repos/${owner}/${repoName}/git/refs`, {
  ref: `refs/heads/${branch}`,
  sha: commit.sha,
});

console.log(`\npushed ${files.length} files in one commit`);
console.log(`commit ${commit.sha}`);
console.log(`https://github.com/${owner}/${repoName}`);
