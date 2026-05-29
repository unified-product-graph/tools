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

// ── Expression + resolver hints ─────────────────────────────────────────────
export * from './lib/expression.js'
export * from './lib/resolver-hints.js'

// ── Approach execution (framework playbooks) ────────────────────────────────
export * from './lib/approach-execution.js'

// ── Classification (entity → business area / tier) ──────────────────────────
export * from './classification.js'
