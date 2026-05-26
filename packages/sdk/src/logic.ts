/**
 * @unified-product-graph/sdk/logic
 *
 * Pure, storage-agnostic graph logic — edge inference, validators, id
 * generators, classification. Depends only on `@unified-product-graph/core`
 * and pulls in **no** file-system or file-watching code.
 *
 * This is the entry point for consumers that have their own storage layer
 * (e.g. the Postgres-backed cloud server) but still need the canonical UPG
 * semantics: the same edge inference, the same property/length/anti-pattern
 * validation, and the same resolver hints the file-backed SDK uses.
 *
 * ```ts
 * import { inferEdgeTypeWithTier, validateEdgeTypePair } from '@unified-product-graph/sdk/logic'
 * ```
 *
 * Everything exported here is also re-exported from the package root
 * (`@unified-product-graph/sdk`) for file-backed consumers. The root entry
 * additionally exposes `UPGClient`, `UPGFileStore`, and the graph-operations
 * layer, which are intentionally absent here.
 */

// ── ID generators ───────────────────────────────────────────────────────────
export { nodeId, edgeId, productId } from './lib/id.js'

// ── Edge inference + validation ─────────────────────────────────────────────
export * from './lib/edge-inference.js'
export * from './lib/edge-pair-validator.js'

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
