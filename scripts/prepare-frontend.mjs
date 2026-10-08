import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const sharedAssets = [
  ['chrome-extension/couch-shared.js', 'frontend/couch-shared.js'],
  ['chrome-extension/panel.html', 'frontend/panel.html'],
  ['chrome-extension/panel.css', 'frontend/panel.css'],
  ['chrome-extension/assets/couch.svg', 'frontend/assets/couch.svg']
];

for (const [source, destination] of sharedAssets) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

console.log('Copied shared Couch panel assets to the static frontend directory.');
