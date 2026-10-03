import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const serverUrl = process.env.COUCH_SERVER_URL;
const archivePath = resolve(
  process.env.COUCH_PACKAGE_OUTPUT ?? join(tmpdir(), 'couch-chrome-extension.zip'),
);
const packageDestination = process.env.COUCH_PACKAGE_DESTINATION;

if (!serverUrl) {
  throw new Error('COUCH_SERVER_URL must be set');
}

const tempDirectory = mkdtempSync(join(tmpdir(), 'couch-package-'));
const extensionDirectory = join(tempDirectory, 'couch-chrome-extension');
try {
  cpSync('chrome-extension', extensionDirectory, { recursive: true });
  execFileSync('find', [tempDirectory, '-name', '.DS_Store', '-delete']);

  const contentPath = join(extensionDirectory, 'content.js');
  const content = readFileSync(contentPath, 'utf8');
  writeFileSync(contentPath, content.replaceAll('http://localhost:3000', serverUrl));

  mkdirSync(dirname(archivePath), { recursive: true });
  rmSync(archivePath, { force: true });
  execFileSync(
    'zip',
    ['-r', archivePath, ...readdirSync(extensionDirectory)],
    { cwd: extensionDirectory, stdio: 'inherit' },
  );

  if (packageDestination) {
    mkdirSync(packageDestination, { recursive: true });
    const destinationPath = join(packageDestination, 'couch-chrome-extension.zip');
    copyFileSync(archivePath, destinationPath);
    console.log(`Copied package to ${destinationPath}`);
  }

  console.log(`Created package at ${archivePath}`);
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
