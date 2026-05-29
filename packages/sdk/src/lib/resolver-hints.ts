/**
 * Resolver enrichment helpers ( and).
 *
 * When the canonical resolver returns `null` for a (source_type, target_type)
 * pair, these helpers surface what the catalog DOES know about, so the failure
 * boundary becomes a teaching moment instead of a dead end.
 *
 * Three enrichments:
 *
 * - `buildAnchorHint(source, target)`: when the target's domain has
 *   a canonical anchor entity that DIFFERS from the source, surface the
 *   anchor + the domain's creation sequence so the author can route via the
 *   correct entry point ("ideal_customer_profile is anchored in gtm_strategy
 *   create one of those first").
 *
 * - `buildAlternateAnchors(source, target)`: catalog walk for
 *   edges where `target_type === requested_target` AND `source_type !==
 *   requested_source`. Surfaces the OTHER sources the catalog connects to
 *   this target. Sorted by classification: hierarchy > causal > semantic
 *   > cross-domain. Capped at 3.
 *
 * - `buildAdjacentEdges(source)`: catalog walk for edges where
 *   `source_type === requested_source`. Helps the author discover what they
 *   CAN reach from this source. Capped at 3.
 *
 * All three are pure functions of the catalog; no graph state required.
 */

import {
  UPG_DOMAIN_GUIDES,
  UPG_EDGE_CATALOG,
  UPG_ENTITY_TO_DOMAIN,
} from '@unified-product-graph/core'

export interface AnchorHint {
  target_domain: string
  domain_anchor: string
  creation_sequence: readonly string[]
  hint: string
}

export interface AlternateAnchor {
  source_type: string
  edge_type: string
  hint: string
}

export interface AdjacentEdge {
  source_type: string
  target_type: string
  edge_type: string
}

// Classification rank for sorting alternates; matches the catalog's
// pickCanonicalEdge policy: hierarchy ≻ causal ≻ semantic ≻ cross-domain.
const CLASSIFICATION_RANK: Record<string, number> = {
  hierarchy: 0,
  causal: 1,
  semantic: 2,
  'cross-domain': 3,
}

/**
 *: anchor hint.
 *
 * When the target type is anchored in a domain different from the source's
 * domain, surface that anchor + the domain's creation sequence. Returns
 * undefined when no useful hint can be constructed (target has no known
 * domain, target's domain has no guide, or the target IS the anchor and the
 * source is already in the same domain).
 *
 * The hint prose intentionally names the anchor explicitly so a first-time
 * author reading the error sees what entity to create next.
 */
export function buildAnchorHint(
  sourceType: string,
  targetType: string,
): AnchorHint | undefined {
  const targetDomainId = (UPG_ENTITY_TO_DOMAIN as Record<string, string | undefined>)[targetType]
  if (!targetDomainId) return undefined

  const guide = UPG_DOMAIN_GUIDES.find((g) => g.domain_id === targetDomainId)
  if (!guide) return undefined

  // Prefer the explicit anchor_entity; fall back to the first entry in the
  // creation_sequence (which is usually the same node, but stays robust if
  // the guide drifts).
  const anchor = guide.anchor_entity ?? guide.creation_sequence[0]
  if (!anchor) return undefined

  // No hint when the source IS the anchor; the author already routed
  // correctly, the null was for a different reason (true catalog gap).
  if (anchor === sourceType) return undefined

  // No hint when the target IS its own anchor AND the source is in the same
  // domain; the author is reaching across a domain they already entered,
  // so routing through the anchor again would be circular advice.
  const sourceDomainId = (UPG_ENTITY_TO_DOMAIN as Record<string, string | undefined>)[sourceType]
  if (anchor === targetType && sourceDomainId === targetDomainId) return undefined

  return {
    target_domain: targetDomainId,
    domain_anchor: anchor,
    creation_sequence: guide.creation_sequence,
    hint:
      `${targetType} is anchored in the ${targetDomainId} domain through ${anchor}. ` +
      `Create a ${anchor} node first, then link it to ${targetType}.`,
  }
}

/**
 *: alternate anchors.
 *
 * Walk `UPG_EDGE_CATALOG` for every edge whose `target_type` matches the
 * requested target AND whose `source_type` differs from the requested source.
 * Sort by classification rank (hierarchy → cross-domain) and cap at 3.
 *
 * This converts "no edge from `service` to `external_api`" into "but
 * `bounded_context → external_api` is canonical."
 *
 * Deduplicates by source_type; when the catalog registers multiple edges
 * from the same source to the same target (e.g. semantic + causal), the
 * highest-ranked one wins.
 */
export function buildAlternateAnchors(
  sourceType: string,
  targetType: string,
): AlternateAnchor[] {
  type Row = { source_type: string; edge_type: string; rank: number }
  const bestBySource = new Map<string, Row>()
  for (const [edgeKey, def] of Object.entries(UPG_EDGE_CATALOG)) {
    if (def.target_type !== targetType) continue
    if (def.source_type === sourceType) continue
    if (def.source_type === '*' || def.target_type === '*') continue
    const rank = CLASSIFICATION_RANK[def.classification] ?? 99
    const existing = bestBySource.get(def.source_type)
    if (!existing || rank < existing.rank) {
      bestBySource.set(def.source_type, { source_type: def.source_type, edge_type: edgeKey, rank })
    }
  }
  const rows = [...bestBySource.values()]
  rows.sort((a, b) => a.rank - b.rank)
  return rows.slice(0, 3).map((r) => ({
    source_type: r.source_type,
    edge_type: r.edge_type,
    hint: `${targetType} anchors on ${r.source_type} instead.`,
  }))
}

/**
 *: adjacent edges.
 *
 * Walk `UPG_EDGE_CATALOG` for every edge whose `source_type` matches the
 * requested source. Surfaces what the author CAN reach from where they are
 * standing. Sort by classification rank and cap at 3.
 *
 * Skips polymorphic edges (`source_type === '*'`); those don't teach
 * useful adjacency.
 */
export function buildAdjacentEdges(sourceType: string): AdjacentEdge[] {
  type Row = { source_type: string; target_type: string; edge_type: string; rank: number }
  const bestByTarget = new Map<string, Row>()
  for (const [edgeKey, def] of Object.entries(UPG_EDGE_CATALOG)) {
    if (def.source_type !== sourceType) continue
    if (def.source_type === '*' || def.target_type === '*') continue
    const rank = CLASSIFICATION_RANK[def.classification] ?? 99
    const existing = bestByTarget.get(def.target_type)
    if (!existing || rank < existing.rank) {
      bestByTarget.set(def.target_type, {
        source_type: def.source_type,
        target_type: def.target_type,
        edge_type: edgeKey,
        rank,
      })
    }
  }
  const rows = [...bestByTarget.values()]
  rows.sort((a, b) => a.rank - b.rank)
  return rows.slice(0, 3).map((r) => ({
    source_type: r.source_type,
    target_type: r.target_type,
    edge_type: r.edge_type,
  }))
}

/**
 * Convenience aggregator: emit every applicable enrichment block for a
 * failed (source, target) pair. Used by `resolve_edge_for_pair` and
 * `create_edge` / `batch_create_edges` error paths.
 *
 * Only includes fields that are non-empty / defined, so consumers don't
 * have to filter undefined keys.
 */
export function buildResolverHints(
  sourceType: string,
  targetType: string,
): {
  anchor_hint?: AnchorHint
  alternate_anchors?: AlternateAnchor[]
  adjacent_edges?: AdjacentEdge[]
} {
  const out: {
    anchor_hint?: AnchorHint
    alternate_anchors?: AlternateAnchor[]
    adjacent_edges?: AdjacentEdge[]
  } = {}
  const anchor = buildAnchorHint(sourceType, targetType)
  if (anchor) out.anchor_hint = anchor
  const alternates = buildAlternateAnchors(sourceType, targetType)
  if (alternates.length > 0) out.alternate_anchors = alternates
  const adjacent = buildAdjacentEdges(sourceType)
  if (adjacent.length > 0) out.adjacent_edges = adjacent
  return out
}
