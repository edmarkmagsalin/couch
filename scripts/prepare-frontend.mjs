import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const version = JSON.parse(readFileSync('chrome-extension/manifest.json', 'utf8')).version;
const sharedAssets = [
  ['chrome-extension/couch-shared.js', 'frontend/public/couch-shared.js'],
  ['chrome-extension/panel.html', 'frontend/public/panel.html'],
  ['chrome-extension/panel.css', 'frontend/public/panel.css'],
  ['chrome-extension/assets/couch.svg', 'frontend/public/assets/couch.svg'],
  ['chrome-extension/assets/link.svg', 'frontend/public/assets/link.svg'],
  ['chrome-extension/assets/users.svg', 'frontend/public/assets/users.svg'],
  ['chrome-extension/assets/eraser.svg', 'frontend/public/assets/eraser.svg'],
  ['chrome-extension/assets/logout.svg', 'frontend/public/assets/logout.svg']
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

console.log('Copied shared Couch panel assets to the frontend public directory.');
