import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/logic.ts'],
  format: ['esm'],
  target: 'node18',
  dts: true,
  clean: true,
  sourcemap: true,
  // core exports raw .ts and must be bundled into the SDK runtime.
  noExternal: ['@unified-product-graph/core'],
})
