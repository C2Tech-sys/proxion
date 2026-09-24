import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The first test in each file pays the Fastify app boot (plugins, fake PVE servers).
    // `pnpm -r test` runs the web and server suites concurrently, so under CPU contention
    // (CI, parallel builds) that boot can exceed vitest's 5 s default.
    testTimeout: 20000,
    hookTimeout: 20000,

    environment: 'node',
  },
});
