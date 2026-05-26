import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Integration tests run against a real Postgres via the separate
    // `test:integration` config; keep them out of the default mocked suite.
    exclude: [...configDefaults.exclude, '**/integration/**'],
  },
})
