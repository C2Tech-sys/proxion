import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// PROXION_VITEST_WORKERS=<n> caps the vitest worker count (e.g. 2 when several suites share
// one busy machine); unset keeps vitest's default, so CI is unaffected.
const workerCap = Number.parseInt(process.env.PROXION_VITEST_WORKERS ?? '', 10);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    // Route-level render tests (router + fixture data) can take 10+ s when several suites
    // share a loaded machine (parallel worktrees); they finish in well under a second alone.
    // The timeout only bites on a failure, so the headroom costs fast tests nothing.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    ...(workerCap > 0 ? { maxWorkers: workerCap } : {}),
    setupFiles: ['./src/test/setup.ts'],
  },
});
