import { defineConfig } from 'vite';

export default defineConfig({
  configFile: false,
  build: {
    outDir: 'chrome-extension',
    emptyOutDir: false,
    lib: {
      entry: 'chrome-extension/qr-generator-entry.js',
      name: 'CouchQrCode',
      formats: ['iife'],
      fileName: () => 'qr-code.js'
    }
  }
});
