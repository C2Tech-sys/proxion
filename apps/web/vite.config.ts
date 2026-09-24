import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, './package.json'), 'utf-8'),
) as { version: string };

export default defineConfig({
  // Keep Vite's dependency pre-bundle out of the (Dropbox-synced) repo tree: file locks there
  // have produced EBUSY on re-optimisation and '504 Outdated Optimize Dep' in the dev server.
  cacheDir: path.join(os.tmpdir(), 'proxion-vite-cache'),
  // Read once at build/dev-server start, not per-request -- see src/version.ts for the
  // consumer side and its 'dev' fallback for anything that isn't run through this config.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://localhost:3080',
        ws: true,
      },
    },
  },
});
