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

// ─── Explicit project membership ─────────────────────────────────────────────

/**
 * UPG work-item types a project can deliver, for `project_delivers_work_item`.
 *
 * The set is not arbitrary: it is exactly the semantic family the `work_item`
 * token names in the edge key, the same bounded family as
 * `planning_cycle_schedules_work_item` and `work_item_blocks_work_item`.
 *
 * It is deliberately NARROWER than the catalogue entry, whose `target_type` is
 * the `node` wildcard. Honouring the wildcard literally would let a project
 * membership edge swallow pairs that already have a better, more specific edge:
 * `project_produces_deliverable` and `project_targets_milestone` both exist, and
 * `release` and `feature_area` are containers rather than work items. Those four
 * types are excluded here on purpose. Do NOT widen this set to match the
 * catalogue's `node` target.
 */
export const PROJECT_WORK_ITEM_TYPES: ReadonlySet<string> = new Set([
  'bug',
  'epic',
  'feature',
  'task',
  'user_story',
])

/**
 * True when a parent -> child pair is a project delivering a work item, and the
 * adapter should therefore emit `project_delivers_work_item` EXPLICITLY.
 *
 * Why explicit, in every adapter that calls this: the edge is flagged
 * `deliberate_only`, so every generic-inference chokepoint (`resolvePairEdge`,
 * `resolveContainmentEdgeInferrable`) filters it out by design, because nothing
 * should derive project membership from mere co-occurrence. An adapter reading an
 * explicit `project_id` / `parent_id` field that the source system itself stores
 * is not inferring from co-occurrence, it is carrying an authored fact faithfully.
 * The generic resolver cannot tell those two cases apart, which is exactly why the
 * explicit path has to be explicit.
 *
 * 0.33.0 added a second barrier: the catalogue entry's target widened to the
 * `node` wildcard, so `UPG_EDGE_PAIR_MAP['project:epic']` did not exist and the
 * generic resolvers returned null for the pair regardless of classification.
 * Explicit emission was then the ONLY route.
 *
 * 0.41.0 CHANGED THAT, and the consequence is worth stating plainly rather than
 * leaving for someone to discover. Concrete containment edges landed for exactly
 * these five child types (`project_contains_{epic,feature,user_story,task,bug}`),
 * so the pair map answers again. Under the ordering rule below, every caller now
 * resolves to containment and this explicit path is NOT reached for any of the
 * five. That is the rule working as written, not a regression: the membership is
 * carried by a more precise edge, and `parent_id` resolves natively.
 *
 * OPERATIONAL CONSEQUENCE for anyone running an incremental sync: a re-import
 * emits `project_contains_task` where a previous import emitted
 * `project_delivers_work_item`. Nothing rewrites the old edges, so a graph
 * imported twice across the boundary can hold both for one pair. That is the
 * shadow pair the 0.41.0 ruling accepted knowingly; containment is the parent
 * axis and wins. Retiring the polymorphic edge for these five types, with a
 * migration, is the follow-up decision that ruling names.
 *
 * KEPT, not dead: this path still carries a project membership for any target
 * OUTSIDE the five, which is the wildcard's remaining job, and the constant is
 * still the right thing to read for graphs already holding the edge.
 *
 * CALL IT LAST, after the generic resolver has returned null. That ordering is
 * what makes the deference in `PROJECT_WORK_ITEM_TYPES` real: a pair with a more
 * specific catalogued edge is resolved before this is ever consulted.
 *
 * Do NOT "tidy" any caller onto the generic resolver as a REPLACEMENT for this
 * check. The relationship would silently vanish for any pair the resolver cannot
 * answer, with a green test suite, which is precisely how it was lost once.
 */
export function isProjectWorkItemMembership(parentType: string, childType: string): boolean {
  return parentType === 'project' && PROJECT_WORK_ITEM_TYPES.has(childType)
}

/** The edge emitted for a project -> work-item membership. */
export const PROJECT_WORK_ITEM_EDGE = 'project_delivers_work_item'
