import { defineConfig } from 'vitest/config'

// Real-Postgres integration tier (UPG-554). Run with `npm run test:integration`.
// Needs a reachable Postgres (UPG_TEST_DATABASE_URL or the docker default on
// :5433); suites self-skip via `describe.skipIf` when none is available.
export default defineConfig({
  test: {
    globals: true,
    include: ['**/integration/**/*.integration.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    // Each file resets the shared schema in beforeAll, so they must not run
    // concurrently against the same database.
    fileParallelism: false,
  },
})
