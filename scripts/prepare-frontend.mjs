import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const version = JSON.parse(readFileSync('chrome-extension/manifest.json', 'utf8')).version;
const sharedAssets = [
  ['chrome-extension/couch-shared.js', 'frontend/couch-shared.js'],
  ['chrome-extension/panel.html', 'frontend/panel.html'],
  ['chrome-extension/panel.css', 'frontend/panel.css'],
  ['chrome-extension/assets/couch.svg', 'frontend/assets/couch.svg']
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

console.log('Copied shared Couch panel assets to the static frontend directory.');
