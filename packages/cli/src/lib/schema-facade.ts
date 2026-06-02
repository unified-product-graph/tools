/**
 * Thin pure wrappers over the SDK's re-exported core resolvers, so
 * the Tier-1 verbs depend on one import surface (`@unified-product-graph/sdk`)
 * for both writes and schema knowledge — exactly the consolidation the SDK
 * facade was built for. These are catalog reads; no graph state.
 *
 * Mirrors `UPGClient.schema.allEdgesFor` / `.edgeFor` as standalone functions
 * (the Tier-1 commands hold a `UPGFileStore`, not a `UPGClient`, so a free
 * function is the right shape here).
 */

import { resolveAllEdges, pickCanonicalEdge } from '@unified-product-graph/sdk'
import type { UPGEdgeType } from '@unified-product-graph/core'

/** Every concrete catalogued edge for the directed `(a → b)` pair (may be > 1). */
export function allEdgesForCli(a: string, b: string): UPGEdgeType[] {
  return resolveAllEdges(a, b)
}

/** The single canonical edge for `(a → b)`, or `null`. Direction matters. */
export function edgeForCli(a: string, b: string): UPGEdgeType | null {
  return pickCanonicalEdge(a, b)
}
