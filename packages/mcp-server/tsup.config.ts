import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/preflight.ts'],
  format: ['esm'],
  target: 'node18',
  dts: true,
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  // Inline workspace packages that aren't published to npm separately:
  // - @unified-product-graph/core exports raw .ts files and must be bundled
  // - @unified-product-graph/mcp-tooling is an internal workspace package
  //   (private); bundling keeps the published mcp-server self-contained
  // - @unified-product-graph/frameworks is internal (private); mcp-server is its
  //   only runtime value consumer, so inline the catalogue here
  noExternal: [
    '@unified-product-graph/core',
    '@unified-product-graph/mcp-tooling',
    '@unified-product-graph/frameworks',
    // adapters: bundled for the same reason. get_import_recipe reads the mapping
    // tables via the pure `./recipes` subpath, so bundling keeps the published
    // server self-contained and never pulls a transport SDK (@linear/sdk etc.).
    '@unified-product-graph/adapters',
  ],
})
