/**
 * @unified-product-graph/sdk
 *
 * Programmatic SDK for reading and writing .upg product knowledge graphs.
 *
 * The high-level entry point is `UPGClient`, a namespaced facade over the
 * lower-level primitives (`UPGFileStore`, `createNode`, `createEdge`, etc.)
 * that are also re-exported here for advanced use.
 *
 * ```ts
 * import { UPGClient } from '@unified-product-graph/sdk'
 *
 * const upg = new UPGClient({ file: './product.upg' })
 * await upg.nodes.create({ type: 'feature', title: 'Dark mode' })
 * await upg.edges.connect('src-id', 'tgt-id')
 * const score = await upg.health()
 * ```
 */

export { UPGClient } from './client.js'
export type {
  UPGClientOptions,
  NodeListOptions,
  EdgeListOptions,
  HealthResult,
  SearchOptions,
} from './client.js'

// ── Core primitives ─────────────────────────────────────────────────────────
export {
  UPGFileStore,
  UPGPortfolioStore,
  type IntegrityReport,
  type ChangeEntry,
  type MergeResult,
  type QuarantinedEntity,
  type PortfolioLoadResult,
  type CrossEdgeMigrationResult,
  type UPGPortfolioDocument,
  type UPGCrossEdge,
} from './store.js'

// ── Graph operations (shared by CLI + MCP server) ───────────────────────────
export * from './lib/tools.js'

// ── Edge inference + validation ─────────────────────────────────────────────
export * from './lib/edge-inference.js'
export * from './lib/edge-pair-validator.js'
// (Seam 1): expose the explicit-edge-type validator so MCP handlers
// (batch_create_edges) route through the SAME catalog-membership + pair check
// that single create_edge already uses. One validation pass, every caller.
export { validateExplicitEdgeType } from './lib/write-validation.js'
export type { EdgeWriteValidation } from './lib/write-validation.js'

// ── ID generators ───────────────────────────────────────────────────────────
export { nodeId, edgeId, productId } from './lib/id.js'

// ── Workspace + portfolio routing ───────────────────────────────────────────
export * from './lib/workspace.js'
export * from './lib/portfolio-routing.js'

// ── Validators + diagnostics ────────────────────────────────────────────────
export * from './lib/dangling-edges.js'
export * from './lib/schema-drift.js'
export * from './lib/anti-pattern-inputs.js'
export * from './lib/property-type-validator.js'
export * from './lib/length-caps.js'
export * from './lib/tree-assemble.js'
export * from './lib/portfolio-landscape.js'

// ── Expression + resolver hints ─────────────────────────────────────────────
export * from './lib/expression.js'
export * from './lib/resolver-hints.js'

// ── Approach execution (framework playbooks) ────────────────────────────────
export * from './lib/approach-execution.js'

// ── Framework exercises (0.8.4): apply a framework + record results on edges ──
export * from './lib/framework-exercise.js'

// ── Classification (entity → business area / tier) ──────────────────────────
export * from './classification.js'

// ── Re-exported core resolvers (S-04) ──────────────────────────────
// The SDK previously re-exported NONE of `@unified-product-graph/core`, so a
// consumer holding the SDK had to separately import core to ask "what edge
// connects A→B?" or "what can attach to a feature?". Surface the catalog-backed
// resolvers here so the writer and the schema knowledge live in one import.
// NOTE: `resolveEntityType` / `UnknownEntityTypeError` / `EntityTypeResolution`
// are already re-exported via `./lib/tools.js`; not repeated here to avoid a
// duplicate-export conflict.
export {
  // edge catalog + pair resolution
  UPG_EDGE_CATALOG,
  UPG_EDGE_PAIR_MAP,
  resolveAllEdges,
  pickCanonicalEdge,
  resolveContainmentEdge,
  // hierarchy + regions
  getValidChildren,
  getRegionForEntityType,
} from '@unified-product-graph/core'

// ── Templates (access layer over @unified-product-graph/templates) ───────────
export * from './templates.js'
