import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/logic.ts'],
  format: ['esm'],
  target: 'node18',
  // Inline frameworks' .d.ts types; it's used type-only here and is an
  // internal (unpublished) package, so inlining keeps the published SDK's
  // types self-contained. core stays external in the types (it IS published).
  dts: { resolve: ['@unified-product-graph/frameworks'] },
  clean: true,
  sourcemap: true,
  // core exports raw .ts and must be bundled into the SDK runtime.
  noExternal: ['@unified-product-graph/core'],
})
