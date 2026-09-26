import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const manifestPath = 'chrome-extension/manifest.json';
const source = readFileSync(manifestPath, 'utf8');
const match = source.match(/("version"\s*:\s*"\d+)\.(\d+)(")/);

if (!match) {
  throw new Error('Manifest version must use n.n format');
}

const nextVersion = Number(match[2]) + 1;
const nextSource = source.replace(
  match[0],
  `${match[1]}.${nextVersion}${match[3]}`,
);
const version = `${match[1].match(/\d+$/)[0]}.${nextVersion}`;

writeFileSync(manifestPath, nextSource);
execFileSync('git', ['add', manifestPath]);
execFileSync(
  'git',
  ['commit', '-m', `chore: bump manifest version to ${version}`],
  { stdio: 'inherit' },
);

console.log(`Bumped manifest version to ${version}`);
