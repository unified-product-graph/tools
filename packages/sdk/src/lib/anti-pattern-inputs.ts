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
  edgeCountSpecKey,
  entityFilterKey,
  UPG_PRESENCE_EXCEPT_SPECS,
  UPG_EDGE_COUNT_SPECS,
  UPG_ENTITY_FILTER_SPECS,
  UPG_EDGE_CATALOG,
  UPG_WILDCARD_ENDPOINT,
} from '@unified-product-graph/core'
import type { UPGFileStore } from '../store.js'

/**
 * Does this property value count as PRESENT for a per-node predicate?
 *
 * The general reading, and the one to reach for when asking a single node
 * directly: only `undefined`, `null` and the empty string are absent.
 * `capacity: 0` is a real cap (a reserved place) and `mutates_content: false`
 * is a real answer, so neither is an omission. This also makes an explicitly
 * unset property read as absent, which is exactly what clearing it intends.
 *
 * Pairs with `isStringPropertyPresent`, and the two exist separately on
 * purpose: the aggregate indexes below can only see string values, so a
 * predicate written against them has to agree with THAT, not with this. Naming
 * both stops the next check author from copying whichever line they happened to
 * read first.
 */
export function isPropertyPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

/**
 * Does this property value count as present for the STRING-indexed aggregates?
 *
 * Narrower than `isPropertyPresent` by construction, not by oversight:
 * `countsByTypeAndProperty` and `countsByTypeAndPropertyPresence` index string
 * values only, so an attribution predicate that must agree with those counts
 * has to apply the same restriction. Using the broad helper here would let an
 * attributed id set disagree with the count that fired the violation.
 */
export function isStringPropertyPresent(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

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
    edgePresence[`${sourceType}|${edge.type}|${targetType}`] = true

    // Polymorphic edges are ALSO recorded under the wildcard endpoint (0.32.0).
    //
    // This index is keyed by the CONCRETE endpoint types of each instance, so
    // without this a check declaring `target_type: 'node'` — the only honest
    // declaration for an edge whose catalog target IS the wildcard — would
    // match nothing. For a `not_exists` comparison that means firing on every
    // graph, including the correct ones, which is the false-positive class the
    // labeled-fixture doctrine exists to catch. Found at compile time when
    // planning_cycle_schedules_work_item widened and the narrow type refused
    // the wildcard; the type was right and the collector was incomplete.
    //
    // Both keys are written, never one: concrete checks keep working unchanged.
    const def = UPG_EDGE_CATALOG[edge.type as keyof typeof UPG_EDGE_CATALOG] as
      | { source_type?: string; target_type?: string }
      | undefined
    if (def?.target_type === UPG_WILDCARD_ENDPOINT) {
      edgePresence[`${sourceType}|${edge.type}|${UPG_WILDCARD_ENDPOINT}`] = true
    }
    if (def?.source_type === UPG_WILDCARD_ENDPOINT) {
      edgePresence[`${UPG_WILDCARD_ENDPOINT}|${edge.type}|${targetType}`] = true
      if (def?.target_type === UPG_WILDCARD_ENDPOINT) {
        edgePresence[`${UPG_WILDCARD_ENDPOINT}|${edge.type}|${UPG_WILDCARD_ENDPOINT}`] = true
      }
    }
  }

  // ── Orphan count: nodes with no incoming AND no outgoing edge ──────────────
  let orphanCount = 0
  for (const node of nodes) {
    if (!connected.has(node.id)) orphanCount++
  }

  // ── Per-node edge-count checks (0.29.0) ────────────────────────────────────
  // The one input whose arithmetic is per-node rather than aggregate: for each
  // declared spec, tally the edges on each node of the type and compare against
  // that same node's numeric property. Driven by UPG_EDGE_COUNT_SPECS, so the
  // cost is one pass over the relevant edges per declared spec (one today).
  //
  // Seeded at empty for every declared spec, for the same reason the
  // except-presence map is: an absent key must mean "stale collector" and
  // nothing else, so an honest zero is recorded as an empty array.
  const nodesByEdgeCountSpec: Record<string, string[]> = {}
  for (const spec of UPG_EDGE_COUNT_SPECS) {
    const key = edgeCountSpecKey(spec)
    const matched: string[] = []

    // Tally this spec's edge type onto the endpoint the spec cares about.
    const tally = new Map<string, number>()
    for (const edge of edges) {
      if (edge.type !== spec.edge_type) continue
      const endpoint = spec.direction === 'outbound' ? edge.source : edge.target
      if (typeById.get(endpoint) !== spec.entity_type) continue
      tally.set(endpoint, (tally.get(endpoint) ?? 0) + 1)
    }

    for (const node of nodes) {
      if ((node.type as string) !== spec.entity_type) continue
      const props = (node as { properties?: Record<string, unknown> }).properties ?? {}

      // Exemption first: an exempt node is not evaluated and not attributed.
      if (
        spec.except_property !== undefined &&
        props[spec.except_property] === spec.except_value
      ) {
        continue
      }

      // Optional extra per-node presence requirement. Uses the BROAD reading:
      // this is a question asked of one node directly, not a predicate that has
      // to agree with a string-only aggregate.
      if (spec.node_filter) {
        if (isPropertyPresent(props[spec.node_filter.property]) !== spec.node_filter.present) {
          continue
        }
      }

      // Absent (or non-numeric) property falls back to the declared default.
      // On `surface.capacity` that default is 1, which is what makes an
      // unbounded surface with several occupants fire rather than escape.
      const rawValue = props[spec.property]
      const threshold =
        typeof rawValue === 'number' && Number.isFinite(rawValue)
          ? rawValue
          : spec.property_absent_default

      const count = tally.get(node.id) ?? 0
      let hit = false
      switch (spec.node_comparison) {
        case 'gt':
          hit = count > threshold
          break
        case 'gte':
          hit = count >= threshold
          break
        case 'lt':
          hit = count < threshold
          break
        case 'lte':
          hit = count <= threshold
          break
        case 'eq':
          hit = count === threshold
          break
      }
      if (hit) matched.push(node.id)
    }
    nodesByEdgeCountSpec[key] = matched
  }

  // ── Attribution ids for declared entity-count filters (0.29.0) ─────────────
  // Attribution ONLY. Every count above is untouched, so a bug here can cost a
  // violation its node list but can never change a verdict.
  const nodesByEntityFilter: Record<string, string[]> = {}
  for (const spec of UPG_ENTITY_FILTER_SPECS) {
    const key = entityFilterKey(spec.entity_type, spec.filter)
    const matched: string[] = []
    const f = spec.filter
    for (const node of nodes) {
      if ((node.type as string) !== spec.entity_type) continue
      const props = (node as { properties?: Record<string, unknown> }).properties ?? {}

      // Exhaustive over a CLOSED set. `kind` was resolved when the spec was
      // derived, and an unrecognised shape threw there, so there is no silent
      // skip branch here for a shape this collector was never taught: such a
      // shape cannot reach a shipped build.
      //
      // These predicates use the STRING-only reading, because they must agree
      // with the aggregate counts that decide whether the violation fires. An
      // attributed id set that disagreed with its own count would be worse than
      // no attribution.
      switch (spec.kind) {
        case 'presence':
          if (isStringPropertyPresent(props[f.property as string]) !== f.present) continue
          break
        case 'value':
          if (props[f.property as string] !== f.value) continue
          break
        case 'status':
          if (node.status !== f.status) continue
          break
      }
      matched.push(node.id)
    }
    nodesByEntityFilter[key] = matched
  }

  return {
    countsByType,
    countsByTypeAndStatus,
    countsByTypeAndProperty,
    countsByTypeAndPropertyPresence,
    countsByTypeAndPropertyPresenceExcept,
    nodesByEdgeCountSpec,
    nodesByEntityFilter,
    edgePresence,
    domainPopulation,
    totalEntityCount: nodes.length,
    domainCount: domainsWithEntities.size,
    orphanCount,
    productStage,
  }
}
