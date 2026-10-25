import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const version = JSON.parse(readFileSync('chrome-extension/manifest.json', 'utf8')).version;
const sharedAssets = [
  ['chrome-extension/couch-shared.js', 'remote/public/couch-shared.js'],
  ['chrome-extension/panel.html', 'remote/public/panel.html'],
  ['chrome-extension/panel.css', 'remote/public/panel.css'],
  ['chrome-extension/assets/couch.svg', 'remote/public/assets/couch.svg'],
  ['chrome-extension/assets/link.svg', 'remote/public/assets/link.svg'],
  ['chrome-extension/assets/users.svg', 'remote/public/assets/users.svg'],
  ['chrome-extension/assets/eraser.svg', 'remote/public/assets/eraser.svg'],
  ['chrome-extension/assets/logout.svg', 'remote/public/assets/logout.svg']
];

for (const [source, destination] of sharedAssets) {
  mkdirSync(dirname(destination), { recursive: true });
  if (source === 'chrome-extension/panel.html') {
    writeFileSync(
      destination,
      readFileSync(source, 'utf8').replaceAll('__COUCH_VERSION__', version)
    );
  } else {
    copyFileSync(source, destination);
  }
}

console.log('Copied shared Couch panel assets to the remote public directory.');
