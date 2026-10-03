import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const manifestPath = 'chrome-extension/manifest.json';
const remote = 'couch';
const mainBranch = 'main';
const coAuthor = 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>';

function git(args, options = {}) {
  const output = execFileSync('git', args, { encoding: 'utf8', ...options });
  return typeof output === 'string' ? output.trim() : '';
}

if (git(['branch', '--show-current']) !== mainBranch) {
  throw new Error(`Releases must be created from ${mainBranch}.`);
}

if (git(['status', '--porcelain'])) {
  throw new Error('Commit or discard all worktree changes before releasing.');
}

const remoteBranches = git(['ls-remote', '--heads', remote, `refs/heads/${mainBranch}`]);
if (!remoteBranches) {
  throw new Error(`Could not find ${remote}/${mainBranch}.`);
}

const source = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(source);
const versionParts = manifest.version.split('.');

if (versionParts.length !== 2 || !versionParts.every((part) => /^\d+$/.test(part))) {
  throw new Error('Manifest version must use n.n format');
}

versionParts[1] = String(Number(versionParts[1]) + 1);
const version = versionParts.join('.');
const tag = `v${version}`;

if (git(['tag', '--list', tag])) {
  throw new Error(`Tag ${tag} already exists locally.`);
}

if (git(['ls-remote', '--tags', remote, `refs/tags/${tag}`])) {
  throw new Error(`Tag ${tag} already exists on ${remote}.`);
}

manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

try {
  execFileSync(process.execPath, ['--env-file-if-exists=.env', 'scripts/package.mjs'], {
    stdio: 'inherit'
  });
} catch (error) {
  writeFileSync(manifestPath, source);
  throw error;
}

try {
  git(['add', manifestPath]);
  git([
    'commit',
    '-m',
    `chore: bump manifest version to ${version}\n\n${coAuthor}`
  ], { stdio: 'inherit' });
} catch (error) {
  git(['restore', '--staged', manifestPath]);
  writeFileSync(manifestPath, source);
  throw error;
}

git(['tag', '-a', tag, '-m', `Release ${tag}`]);

try {
  git(['push', remote, mainBranch, `refs/tags/${tag}`], { stdio: 'inherit' });
} catch (error) {
  throw new Error(
    `Release ${tag} was committed and tagged locally, but pushing failed. Retry with: git push ${remote} ${mainBranch} ${tag}`,
    { cause: error }
  );
}

console.log(`Released ${tag} to ${remote}/${mainBranch}`);
