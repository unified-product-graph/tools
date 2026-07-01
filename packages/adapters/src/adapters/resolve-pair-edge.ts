/**
 * Shared parent -> child edge resolution for the import adapters.
 *
 * Resolves the canonical UPG edge for a parent UPG type -> child UPG type pair
 * via UPG_EDGE_PAIR_MAP, honouring direction; returns null when no canonical
 * edge exists, in which case callers emit a `node_informs_node` generic link.
 *
 * Deliberate-only edges are excluded here, read directly from core's
 * `isDeliberateOnlyEdge` (the single source of truth, derived from the
 * `deliberate_only` catalog flag) — no local copy. A deliberate-only edge carries
 * a meaning that is an authoring act, not a relationship that can be inferred from
 * a source tool's hierarchy: `objective_defers_feature` / `objective_defers_
 * capability` mean an objective explicitly PARKS a feature or capability out of
 * scope, the opposite of the "this child contributes to this parent" link a
 * nesting implies. They must never be auto-emitted from a parentage, so a generic
 * objective -> feature link falls back to `node_informs_node`. A new deliberate-only
 * edge self-excludes here with one core flag.
 */
import {
  isDeliberateOnlyEdge,
  UPG_EDGE_PAIR_MAP,
  resolveContainmentEdge,
  type UPGEdgeType,
} from '@unified-product-graph/core'

function firstInferrable(types: readonly string[] | undefined): string | undefined {
  return types?.find((t) => !isDeliberateOnlyEdge(t))
}

/**
 * Resolve the canonical UPG edge for a parent UPG type -> child UPG type pair
 * via UPG_EDGE_PAIR_MAP, honouring direction; null when no inferrable canonical
 * edge exists. The generic-parentage entry point used by the pair-map adapters.
 */
export function resolvePairEdge(
  parentUpg: string,
  childUpg: string,
): { type: string; sourceIsChild: boolean } | null {
  const fwd = firstInferrable(UPG_EDGE_PAIR_MAP[`${parentUpg}:${childUpg}`])
  if (fwd) return { type: fwd, sourceIsChild: false }
  const rev = firstInferrable(UPG_EDGE_PAIR_MAP[`${childUpg}:${parentUpg}`])
  if (rev) return { type: rev, sourceIsChild: true }
  return null
}

/**
 * Deliberate-only-filtered wrapper around the spec's `resolveContainmentEdge`,
 * the second generic-parentage entry point (used by the markdown, notion,
 * github, and linear adapters). The spec resolver short-circuits a single-
 * candidate pair regardless of classification, so with `objective:feature` /
 * `objective:capability` now single-candidate it would return the deliberate-only
 * defer edge for an ordinary feature-under-objective nesting. This wrapper drops
 * that, returning null so callers keep their `?? 'node_informs_node'` fallback.
 * The spec resolver is left untouched: `resolve_edge_for_pair` MUST still return
 * the defer edge for EXPLICIT resolution.
 */
export function resolveContainmentEdgeInferrable(
  parentType: string,
  childType: string,
): UPGEdgeType | null {
  const edge = resolveContainmentEdge(parentType, childType)
  if (!edge || isDeliberateOnlyEdge(edge)) return null
  return edge
}
