/**
 * Schema-drift summary. Walks a loaded UPG document once on load and
 * counts deviations from the canonical UPG shape, by class:
 *
 *   1. entity_drift:     nodes whose type ∉ UPG_TYPES (often have a
 *                         UPG_MIGRATIONS or UPG_SPLIT_MIGRATIONS rule).
 *   2. edge_drift:       edges whose type ∉ UPG_EDGE_CATALOG. A non-canonical
 *                         edge type often has a UPG_EDGE_MIGRATIONS rule
 *                         pointing at its successor; see validation.ts for the
 *                         suggested-migration logic. Canonical edges are never
 *                         counted, even if they still appear as `from` in a
 *                         historical migration rule.
 *   3. top_level_drift:  nodes with top-level keys outside UPGBaseNode.
 *   4. lifecycle_drift:  nodes whose `status` value is not a valid phase id
 *                         for their entity type (per `getLifecycleForType`).
 *   5. self_referential: nodes where `source_id === id` AND
 *                         `source_type === type`. The fields are for
 *                         external-import round-trip; self-references are
 *                         redundant and should be dropped.
 *   6. property_drift:   properties on a node that should have been migrated
 *                         (rename, drop, or lift to top-level). Powered by
 *                         UPG_PROPERTY_MIGRATIONS once full property-migration
 *                         coverage ships; today the count is driven by
 *                         intra-`properties` rename rules only.
 *
 * Output is COUNTS ONLY. The full per-node breakdown lives in the
 * `validate_graph` MCP tool.
 */

import {
  UPG_TYPES,
  UPG_EDGE_CATALOG,
  UPG_MIGRATIONS,
  UPG_SPLIT_MIGRATIONS,
  UPG_PROPERTY_MIGRATIONS,
  getLifecycleForType,
  getReplacementType,
} from '@unified-product-graph/core'
import type { UPGDocument } from '@unified-product-graph/core'

export interface SchemaDriftSummary {
  entity_drift: number
  edge_drift: number
  top_level_drift: number
  lifecycle_drift: number
  self_referential: number
  property_drift: number
  total_nodes: number
  total_edges: number
}

/**
 * Canonical top-level node fields per `UPGBaseNode` shape. Anything outside
 * this set on a node is counted under `top_level_drift`.
 *
 * Synced manually with `packages/upg-spec/src/shapes/base-node.ts`. If the
 * UPGBaseNode interface gains a field, add it here too.
 */
const CANONICAL_NODE_FIELDS = new Set<string>([
  'id',
  'type',
  'title',
  'slug',
  'aliases',
  'description',
  'tags',
  'status',
  'source_id',
  'source_type',
  'mapping_confidence',
  'external_tool',
  'external_ref',
  'external_id',
  'properties',
])

const validTypes = new Set<string>(UPG_TYPES)
const canonicalEdgeKeys = new Set<string>(Object.keys(UPG_EDGE_CATALOG))

// Pre-compute the union of from-types in UPG_MIGRATIONS / UPG_SPLIT_MIGRATIONS
// so we can flag deprecated entity types quickly.
//
// A type that's both `from` of a migration rule AND present in
// UPG_TYPES is canonical (e.g. `experiment`; the v0.2.6 split rule is
// retained for legacy data, but the type itself remains canonical
// alongside its former children). Exclude canonical-and-also-rule-source
// types from the deprecated set so they're not double-counted as drift.
const knownDeprecatedEntityTypes = new Set<string>()
for (const rules of Object.values(UPG_MIGRATIONS)) {
  for (const r of rules) {
    if (!validTypes.has(r.from)) knownDeprecatedEntityTypes.add(r.from)
  }
}
for (const rules of Object.values(UPG_SPLIT_MIGRATIONS)) {
  for (const r of rules) {
    if (!validTypes.has(r.from)) knownDeprecatedEntityTypes.add(r.from)
  }
}

// Note: we deliberately do NOT pre-compute a `knownDeprecatedEdgeKeys` set
// from UPG_EDGE_MIGRATIONS. An edge key that appears as `from` in a migration
// rule is not necessarily deprecated; the hypothesis family was
// renamed and then renamed back, so the same key appears as `from` in one
// version and as `to` (canonical) in another. Canonicality is determined by
// UPG_EDGE_CATALOG alone; the migration registry is consulted only to suggest
// a target for non-canonical edges (see validation.ts).

// Pre-compute the per-type set of `properties.<key>` names that are touched by
// UPG_PROPERTY_MIGRATIONS rules. Only `lift_property_to_top_level` and
// `drop_props` operate on values nested under `properties`; `rename_top_level`
// and `drop_when_self_referential` operate on top-level fields, which are
// covered by other drift classes (top_level_drift, self_referential).
//
// Wildcard rules (`type: '*'`) apply to every entity type; materialise them
// during the walk against each node's actual type.
const propertyMigrationKeysByType = new Map<string, Set<string>>()
const propertyMigrationKeysWildcard = new Set<string>()
for (const rules of Object.values(UPG_PROPERTY_MIGRATIONS)) {
  for (const r of rules) {
    if (r.kind === 'lift_property_to_top_level') {
      addPropertyKey(r.type, r.from_property)
    } else if (r.kind === 'drop_props') {
      for (const key of r.drop_props) addPropertyKey(r.type, key)
    }
    // rename_top_level and drop_when_self_referential touch top-level fields,
    // not properties; see top_level_drift / self_referential.
  }
}

function addPropertyKey(type: string, key: string): void {
  if (type === '*') {
    propertyMigrationKeysWildcard.add(key)
    return
  }
  let set = propertyMigrationKeysByType.get(type)
  if (!set) {
    set = new Set()
    propertyMigrationKeysByType.set(type, set)
  }
  set.add(key)
}

export function computeSchemaDriftSummary(doc: UPGDocument): SchemaDriftSummary {
  let entity_drift = 0
  let top_level_drift = 0
  let lifecycle_drift = 0
  let self_referential = 0
  let property_drift = 0

  for (const node of doc.nodes) {
    // 1. entity_drift
    if (!validTypes.has(node.type) || knownDeprecatedEntityTypes.has(node.type)) {
      entity_drift++
    }

    // 3. top_level_drift
    const nodeRecord = node as unknown as Record<string, unknown>
    for (const key of Object.keys(nodeRecord)) {
      if (!CANONICAL_NODE_FIELDS.has(key)) {
        top_level_drift++
        break // count nodes, not field-violations
      }
    }

    // 4. lifecycle_drift
    if (typeof node.status === 'string' && node.status.length > 0) {
      const lifecycle = getLifecycleForType(node.type as string)
      if (lifecycle) {
        const validPhases = new Set(lifecycle.phases.map((p) => p.id))
        if (!validPhases.has(node.status)) lifecycle_drift++
      }
    }

    // 5. self_referential source_id / source_type
    const nodeAny = node as unknown as Record<string, unknown>
    if (nodeAny.source_id === node.id && nodeAny.source_type === node.type) {
      self_referential++
    }

    // 6. property_drift: count nodes whose properties carry at least one key
    // covered by a `lift_property_to_top_level` or `drop_props` rule for their
    // type (or by a wildcard `'*'` rule).
    //
    // Normalise via getReplacementType so deprecated aliases
    // (e.g. `kpi` → `metric`) resolve to their canonical type before the
    // property-migration key map is consulted.
    if (node.properties) {
      const effectiveType = (getReplacementType(node.type as string) ?? node.type) as string
      const typeKeys = propertyMigrationKeysByType.get(effectiveType)
      const propKeys = Object.keys(node.properties)
      let matched = false
      for (const key of propKeys) {
        if (typeKeys?.has(key) || propertyMigrationKeysWildcard.has(key)) {
          matched = true
          break
        }
      }
      if (matched) property_drift++
    }
  }

  // 2. edge_drift
  //
  // Mirror the entity_drift rule (line 147 above): a type listed in
  // UPG_EDGE_CATALOG is canonical and must never surface as drift, even if a
  // stale rename rule still references it as `from`. The hypothesis family
  // (late finding 2026-05-21) is the canonical example: v0.2.8
  // renamed `solution_proposes_hypothesis → solution_proposes_hypothesis_claim`,
  // v0.4.0 renamed it back; both rules are correct history, but both names
  // appear as `from` in UPG_EDGE_MIGRATIONS. The OR-with-knownDeprecatedEdgeKeys
  // form below would have flagged canonical `solution_proposes_hypothesis` as
  // drift purely because it's still a `from` in a v0.2.8 rule.
  //
  // Canonicality is the authoritative signal; only flag when the type
  // isn't in UPG_EDGE_CATALOG.
  let edge_drift = 0
  for (const edge of doc.edges) {
    if (!canonicalEdgeKeys.has(edge.type)) {
      edge_drift++
    }
  }

  return {
    entity_drift,
    edge_drift,
    top_level_drift,
    lifecycle_drift,
    self_referential,
    property_drift,
    total_nodes: doc.nodes.length,
    total_edges: doc.edges.length,
  }
}

export function renderDriftSummary(summary: SchemaDriftSummary, filePath?: string): string | null {
  const total =
    summary.entity_drift +
    summary.edge_drift +
    summary.top_level_drift +
    summary.lifecycle_drift +
    summary.self_referential +
    summary.property_drift
  if (total === 0) return null

  const lines: string[] = []
  lines.push(`.upg schema drift summary${filePath ? ` (${filePath})` : ''}:`)
  if (summary.entity_drift > 0) {
    lines.push(
      `  - ${summary.entity_drift} node${summary.entity_drift === 1 ? '' : 's'} with non-canonical entity types (run migrate_type)`,
    )
  }
  if (summary.edge_drift > 0) {
    lines.push(
      `  - ${summary.edge_drift} edge${summary.edge_drift === 1 ? '' : 's'} with non-canonical edge types (run migrate_type or rename_edge_type)`,
    )
  }
  if (summary.top_level_drift > 0) {
    lines.push(
      `  - ${summary.top_level_drift} node${summary.top_level_drift === 1 ? '' : 's'} with non-spec top-level fields`,
    )
  }
  if (summary.lifecycle_drift > 0) {
    lines.push(
      `  - ${summary.lifecycle_drift} node${summary.lifecycle_drift === 1 ? '' : 's'} with invalid status for their lifecycle`,
    )
  }
  if (summary.self_referential > 0) {
    lines.push(
      `  - ${summary.self_referential} node${summary.self_referential === 1 ? '' : 's'} with self-referential source_id/source_type (redundant)`,
    )
  }
  if (summary.property_drift > 0) {
    lines.push(
      `  - ${summary.property_drift} node${summary.property_drift === 1 ? '' : 's'} with properties matching UPG_PROPERTY_MIGRATIONS rules`,
    )
  }
  lines.push('Run `validate_graph` for full per-node breakdown.')
  return lines.join('\n')
}
