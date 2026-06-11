import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // The CLI suite spawns the built binary as a subprocess per assertion. Under
    // concurrent load (the publish train builds + tests every package at once),
    // cold Node startup plus CLI load can exceed the 5s default and flake on a
    // timeout that is environmental, not a real failure. Give it real headroom so
    // the gate is trustworthy.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
