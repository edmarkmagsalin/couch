import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const serverUrl = process.env.COUCH_SERVER_URL;
const tempDirectory = '.package-tmp';
const extensionDirectory = join(tempDirectory, 'couch-chrome-extension');
const distributionDirectory = 'dist';
const archivePath = join(distributionDirectory, 'couch-chrome-extension.zip');

if (!serverUrl) {
  throw new Error('COUCH_SERVER_URL must be set');
}

rmSync(tempDirectory, { recursive: true, force: true });
rmSync(distributionDirectory, { recursive: true, force: true });
mkdirSync(distributionDirectory, { recursive: true });

try {
  cpSync('chrome-extension', extensionDirectory, { recursive: true });
  execFileSync('find', [tempDirectory, '-name', '.DS_Store', '-delete']);

  const contentPath = join(extensionDirectory, 'content.js');
  const content = readFileSync(contentPath, 'utf8');
  writeFileSync(contentPath, content.replaceAll('http://localhost:3000', serverUrl));

  execFileSync(
    'zip',
    ['-r', join(process.cwd(), archivePath), 'couch-chrome-extension'],
    { cwd: tempDirectory, stdio: 'inherit' },
  );
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
