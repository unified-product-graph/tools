import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // The default 5s is too tight for this transform-heavy suite: the
    // filesystem-backed create_product / workspace tests (and the portfolio
    // E2E build) run real UPGFileStore I/O + integrity hashing, and under the
    // full parallel run they get CPU-starved past 5s and flake. 20s is
    // comfortably above their isolated runtime (<1s each) while still catching
    // genuine hangs.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
