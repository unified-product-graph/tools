import { defineConfig } from 'tsup'
import * as path from 'node:path'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['cjs'],
  target: 'node18',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [
    // Bundle ALL monorepo siblings so the CLI is a self-contained CJS binary.
    // Every @unified-product-graph/* package is ESM-only (type: module with
    // "import"-only exports), but the CLI ships as CJS — so they MUST be
    // inlined for require() to resolve. A regex (rather than an explicit list)
    // ensures new/transitive UPG deps — e.g. sdk → frameworks, mcp-tooling —
    // can never silently fall through to an external CJS require() crash.
    /^@unified-product-graph\//,
  ],
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
})
