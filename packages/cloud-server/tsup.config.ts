import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  banner: {
    js: '#!/usr/bin/env node',
  },
  // @unified-product-graph/mcp-tooling is an internal workspace package
  // (private, not published to npm); bundling keeps the published
  // cloud-server self-contained.
  noExternal: ['@unified-product-graph/mcp-tooling'],
})
