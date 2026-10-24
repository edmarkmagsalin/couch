import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
  const { API_URL } = loadEnv(mode, projectRoot, 'API_URL');
  if (!API_URL) {
    throw new Error(`API_URL must be set in the root .env file or the build environment (mode: ${mode}).`);
  }

  return {
    root: 'remote',
    define: {
      'import.meta.env.API_URL': JSON.stringify(API_URL)
    },
    server: {
      host: '0.0.0.0',
      port: 4173,
      strictPort: true
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true
    }
  };
});
