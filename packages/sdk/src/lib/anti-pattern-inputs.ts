/**
 * Local anti-pattern input collector.
 *
 * Walks the loaded UPGFileStore once and builds the `AntiPatternInputs`
 * shape consumed by `evaluateAntiPatterns` from `@unified-product-graph/core`.
 *
 * Cloud has its own SQL-based collector (Phase 2 at `packages/upg-cloud-server/
 * src/lib/anti-pattern-inputs.ts`). Different stores, same output shape.
 */

import {
  type AntiPatternInputs,
  type UPGProductStage,
  getDomainForType,
  presenceExceptKey,
  UPG_PRESENCE_EXCEPT_SPECS,
} from '@unified-product-graph/core'
import type { UPGFileStore } from '../store.js'

/**
 * Build the per-graph statistics consumed by `evaluateAntiPatterns`.
 *
 * Single linear pass over `getAllNodes()` plus one over `getAllEdges()`. No
 * caching; the cost is bounded by graph size, and `validate_graph` is
 * already O(nodes + edges) for schema drift.
 *
 * @param store The loaded UPGFileStore.
 * @param productStage Active product stage (read from the document's
 *   `product.stage` by the caller). Used by stage-gated anti-patterns.
 */
export function collectAntiPatternInputs(
  store: UPGFileStore,
  productStage?: UPGProductStage,
): AntiPatternInputs {
  const nodes = store.getAllNodes()
  const edges = store.getAllEdges()

  // ── Counts by type + counts by type and status ─────────────────────────────
  const countsByType: Record<string, number> = {}
  const countsByTypeAndStatus: Record<string, Record<string, number>> = {}
  // type → property key → property value → count (0.17.0): lets an anti-pattern
  // filter an entity_count on a property value, e.g. metric where designation ==
  // 'north_star'. Built for every string-valued property; bounded by the data.
  const countsByTypeAndProperty: Record<string, Record<string, Record<string, number>>> = {}
  // type → property key → count of nodes of that type CARRYING a value (0.27.0).
  // Lets an anti-pattern key on a field nobody filled in: the evaluator derives
  // the absent count as countsByType - this, so absences are never enumerated.
  const countsByTypeAndPropertyPresence: Record<string, Record<string, number>> = {}
  // type → presenceExceptKey(...) → count of nodes of that type CARRYING the
  // property, counted only over nodes that do NOT declare the exemption
  // (0.28.0). Driven by UPG_PRESENCE_EXCEPT_SPECS rather than by indexing every
  // property pair, which would be quadratic in properties-per-node to serve the
  // one detector that asks. One spec today, so this costs a handful of lookups
  // per node.
  const countsByTypeAndPropertyPresenceExcept: Record<string, Record<string, number>> = {}
  // Seed every declared spec at zero BEFORE the walk. Without this, "no entry"
  // would be ambiguous between "this collector predates the spec" and "no node
  // matched", and the evaluator could not tell a stale collector from an honest
  // zero. Seeded, an absent entry means exactly one thing: stale collector.
  for (const spec of UPG_PRESENCE_EXCEPT_SPECS) {
    let byKey = countsByTypeAndPropertyPresenceExcept[spec.entity_type]
    if (!byKey) {
      byKey = {}
      countsByTypeAndPropertyPresenceExcept[spec.entity_type] = byKey
    }
    byKey[presenceExceptKey(spec.property, spec.except_property, spec.except_value)] = 0
  }
  // Per-type → set of domain ids; collapsed to domainPopulation/domainCount.
  const domainsWithEntities = new Set<string>()
  const domainPopulation: Record<string, boolean> = {}

  for (const node of nodes) {
    const type = node.type as string
    countsByType[type] = (countsByType[type] ?? 0) + 1

    if (typeof node.status === 'string' && node.status.length > 0) {
      let byStatus = countsByTypeAndStatus[type]
      if (!byStatus) {
        byStatus = {}
        countsByTypeAndStatus[type] = byStatus
      }
      byStatus[node.status] = (byStatus[node.status] ?? 0) + 1
    }

    const props = (node as { properties?: Record<string, unknown> }).properties
    if (props) {
      for (const [k, val] of Object.entries(props)) {
        if (typeof val !== 'string' || val.length === 0) continue
        let byProp = countsByTypeAndProperty[type]
        if (!byProp) {
          byProp = {}
          countsByTypeAndProperty[type] = byProp
        }
        let byVal = byProp[k]
        if (!byVal) {
          byVal = {}
          byProp[k] = byVal
        }
        byVal[val] = (byVal[val] ?? 0) + 1

        let presence = countsByTypeAndPropertyPresence[type]
        if (!presence) {
          presence = {}
          countsByTypeAndPropertyPresence[type] = presence
        }
        presence[k] = (presence[k] ?? 0) + 1
      }

      // Except-qualified presence (0.28.0). A node counts toward a spec only if
      // it carries the property AND does not declare the exemption; the
      // evaluator derives the absent-and-not-exempt figure from this.
      for (const spec of UPG_PRESENCE_EXCEPT_SPECS) {
        if (spec.entity_type !== type) continue
        const value = props[spec.property]
        if (typeof value !== 'string' || value.length === 0) continue
        if (props[spec.except_property] === spec.except_value) continue
        const byKey = countsByTypeAndPropertyPresenceExcept[type]!
        const key = presenceExceptKey(spec.property, spec.except_property, spec.except_value)
        byKey[key] = (byKey[key] ?? 0) + 1
      }
    }

    const domain = getDomainForType(type)
    if (domain) {
      domainsWithEntities.add(domain.id)
      domainPopulation[domain.id] = true
    }
  }

  // ── Edge presence + per-node connectivity (for orphan count) ───────────────
  const edgePresence: Record<string, boolean> = {}
  const connected = new Set<string>()

  // Build a node id → type lookup so we can resolve source/target types.
  const typeById = new Map<string, string>()
  for (const node of nodes) typeById.set(node.id, node.type as string)

  for (const edge of edges) {
    connected.add(edge.source)
    connected.add(edge.target)

    const sourceType = typeById.get(edge.source)
    const targetType = typeById.get(edge.target)
    // Skip dangling edges (endpoint not in node set); they don't tell us
    // anything about (source_type, edge_type, target_type) presence.
    if (!sourceType || !targetType) continue
    const key = `${sourceType}|${edge.type}|${targetType}`
    edgePresence[key] = true
  }

  // ── Orphan count: nodes with no incoming AND no outgoing edge ──────────────
  let orphanCount = 0
  for (const node of nodes) {
    if (!connected.has(node.id)) orphanCount++
  }

  return {
    countsByType,
    countsByTypeAndStatus,
    countsByTypeAndProperty,
    countsByTypeAndPropertyPresence,
    countsByTypeAndPropertyPresenceExcept,
    edgePresence,
    domainPopulation,
    totalEntityCount: nodes.length,
    domainCount: domainsWithEntities.size,
    orphanCount,
    productStage,
  }
}
