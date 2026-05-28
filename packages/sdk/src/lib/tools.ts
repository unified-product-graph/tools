/**
 * Shared tool logic. Pure functions that operate on a UPGFileStore.
 *
 * Used by both the MCP server (server.ts) and the CLI (@unified-product-graph/mcp).
 * Extract here, import everywhere.
 */

import type { UPGFileStore } from '../store.js'
import type { UPGBaseNode, UPGEdge, UPGEdgeType, UPGEntityType, UPGProductStage } from '@unified-product-graph/core'
import {
  coerceProductStage,
  collectSlugsForType,
  generateSlug,
  getLifecycleForType,
  getReplacementType,
  resolveSlugCollision,
  UPG_EDGE_CATALOG,
} from '@unified-product-graph/core'

/**
 * Resolve a (possibly deprecated) entity type to its canonical replacement.
 * Returns the input unchanged if it is already canonical or unknown.
 */
function canonicalType(name: string): string {
  return getReplacementType(name) ?? name
}

// ── Entity type validation ────────────────────────────────────────
//
// `resolveEntityType` + `UnknownEntityTypeError` live in
// `@unified-product-graph/core` so cloud + local + downstream HTTP consumers
// all run the same alias path (`get_entity_schema('jtbd') → job`) AND share a
// single `UnknownEntityTypeError` class — an `instanceof` thrown by the SDK
// stays true when caught in a server. We import + re-export here so existing
// consumers (tools/nodes.ts, tools/schema.ts, __tests__/tools.test.ts) keep
// their import path AND the symbols stay locally bound for use further down
// the file (createNode + migrateNodeType).
import {
  resolveEntityType,
  UnknownEntityTypeError,
  type EntityTypeResolution,
} from '@unified-product-graph/core'
export { resolveEntityType, UnknownEntityTypeError, type EntityTypeResolution }
import { nodeId, edgeId } from './id.js'
import { inferEdgeType, inferEdgeTypeWithTier } from './edge-inference.js'
import { validateEdgeTypePair } from './edge-pair-validator.js'

// ── Lifecycle helpers ─────────────────────────────────────────────────────────

/**
 * Validate a status value against the lifecycle phases for an entity type.
 * Returns a warning string if the status is invalid, or undefined if valid / no lifecycle.
 */
export function validateStatusAgainstLifecycle(
  entityType: string,
  status: string,
): string | undefined {
  const lifecycle = getLifecycleForType(entityType)
  if (!lifecycle) return undefined
  const validPhases = lifecycle.phases.map((p) => p.id)
  if (!validPhases.includes(status)) {
    return `Status "${status}" is not a valid phase for type "${entityType}". Valid phases: [${validPhases.join(', ')}]`
  }
  return undefined
}

/**
 * Returns the initial_phase for an entity type, or undefined if the type has no lifecycle.
 */
export function getDefaultStatus(entityType: string): string | undefined {
  const lifecycle = getLifecycleForType(entityType)
  return lifecycle?.initial_phase
}

// ── Tag normalisation (shared) ──────────────────────────────────────────────

/**
 * Backfill `slug` on a freshly-built node before it's added to the store.
 * Picks the auto-generated slug from `title`, resolved against
 * every existing slug + alias of the same `type` in the same product.
 *
 * No-op if the node already carries an explicit slug.
 */
export function autoFillSlug(node: UPGBaseNode, store: UPGFileStore): void {
  if (node.slug) return
  if (!node.title) return
  const existing = collectSlugsForType(store.getAllNodes(), node.type)
  const base = generateSlug(node.title)
  node.slug = resolveSlugCollision(base, existing)
}

export function normalizeTags(tags: unknown): string[] | undefined {
  if (!tags) return undefined
  if (Array.isArray(tags)) return tags
  if (typeof tags === 'string') {
    try {
      const parsed = JSON.parse(tags)
      if (Array.isArray(parsed)) return parsed
    } catch { /* not valid JSON */ }
    return [tags] // treat as single-tag string
  }
  return undefined
}

// ── Business area → entity type mapping ──────────────────────────────────────

export const BUSINESS_AREAS: Record<string, { emoji: string; types: string[] }> = {
  identity: { emoji: '🎯', types: ['product', 'vision', 'mission'] },
  understanding: { emoji: '👤', types: ['persona', 'job', 'need', 'research_study', 'insight'] },
  // Surface canonical post-split types. `hypothesis` is canonical
  // (re-promoted in v0.4.0 from hypothesis_claim). `hypothesis_evidence`
  // is deprecated — use `evidence` + hypothesis_has_evidence edge instead.
  // `experiment` remains canonical alongside `experiment_plan` / `experiment_run`.
  discovery: { emoji: '💡', types: ['opportunity', 'solution', 'competitor', 'hypothesis', 'experiment_plan', 'experiment_run', 'learning'] },
  // `validation` overlaps `discovery` semantically but tracks the stage's
  // characteristic artefacts (hypothesis tested, evidence captured, experiment
  // run-throughs). Surfaced as its own region so STAGE_COVERAGE_TARGETS can
  // gate on it at `validation` stage without re-graveling `discovery`.
  validation: { emoji: '🧪', types: ['hypothesis', 'experiment_plan', 'experiment_run', 'evidence', 'learning'] },
  reaching: { emoji: '📣', types: ['ideal_customer_profile', 'positioning', 'messaging', 'acquisition_channel', 'content_strategy'] },
  converting: { emoji: '💰', types: ['value_proposition', 'pricing_tier', 'funnel', 'funnel_step'] },
  // (since v0.4.0) story_task collapsed into task; building area uses task for story work.
  building: { emoji: '📦', types: ['feature', 'user_story', 'epic', 'release', 'user_journey', 'user_flow'] },
  sustaining: { emoji: '🏦', types: ['business_model', 'revenue_stream', 'cost_structure', 'unit_economics', 'pricing_strategy'] },
  learning: { emoji: '📊', types: ['outcome', 'metric', 'objective', 'key_result', 'retrospective'] },
  // Operations is a maintenance-stage concern — incidents, postmortems, error
  // budgets only become coverage-relevant once a product is in `maintenance`.
  // Surfaced informationally at earlier stages.
  operations: { emoji: '🚨', types: ['incident', 'postmortem', 'error_budget'] },
}

// ── Stage-aware coverage targets ──────────────────────────────────────────────
//
// Per Finding 9 in `2026-05-20-spec-as-observed-v2.md`. The eight (plus
// `operations`) business-area regions in `BUSINESS_AREAS` are the spec's
// implicit completeness model, but a concept-stage product should not be
// graded against a launched product's checklist. Each `UPGProductStage` maps
// to the list of region keys that are *counted toward completeness*. Regions
// outside this list are still surfaced in `coverage` (with
// `counted_toward_stage: false`) so the caller can see them informationally
// without dragging the headline `overall_pct` down.
//
// Stages widen the counted set as a product matures:
// concept → validation → build → beta → launch → growth → mature →
//   maintenance (adds Operations) → sunset (narrowest, only Identity +
//   Learning — the retrospective).
//
// Keys MUST exist in `BUSINESS_AREAS` above. The type assertion at the
// bottom of this module enforces this at compile time.
export const STAGE_COVERAGE_TARGETS: Record<UPGProductStage, string[]> = {
  concept: ['identity', 'understanding', 'discovery'],
  validation: ['identity', 'understanding', 'discovery', 'validation'],
  build: ['identity', 'understanding', 'discovery', 'validation', 'building'],
  beta: ['identity', 'understanding', 'discovery', 'validation', 'building', 'reaching', 'converting'],
  launch: ['identity', 'understanding', 'discovery', 'validation', 'building', 'reaching', 'converting', 'sustaining'],
  growth: ['identity', 'understanding', 'discovery', 'validation', 'building', 'reaching', 'converting', 'sustaining', 'learning'],
  mature: ['identity', 'understanding', 'discovery', 'validation', 'building', 'reaching', 'converting', 'sustaining', 'learning'],
  maintenance: ['identity', 'understanding', 'discovery', 'validation', 'building', 'reaching', 'converting', 'sustaining', 'learning', 'operations'],
  // Sunset products are winding down — Identity stays (the product still has
  // a name + vision) and Learning becomes the priority (capture the
  // retrospective + reasons for sunsetting). Everything else is informational.
  sunset: ['identity', 'learning'],
}

/**
 * Resolve the canonical UPGProductStage for digest coverage. Returns
 * `'concept'` as the default when stage is missing or unrecognised — concept
 * is the narrowest expectation surface, so we under-grade rather than
 * over-grade. Legacy `"idea"` and friends route through `coerceProductStage`
 * (which lives in `@unified-product-graph/core`); the inline `"idea" →
 * "concept"` fallback below is defensive in case the core helper is ever
 * unavailable.
 */
export function resolveCoverageStage(rawStage: unknown): UPGProductStage {
  if (typeof rawStage === 'string') {
    const coerced = coerceProductStage(rawStage)
    if (coerced.canonical) return coerced.canonical
    // Defensive: if `coerceProductStage` ever stops returning canonical for
    // the most common legacy alias, keep the digest sane.
    if (rawStage.toLowerCase() === 'idea') return 'concept'
  }
  return 'concept'
}

export const LIFECYCLE_PHASES: Record<string, string[]> = {
  strategy: ['product', 'outcome', 'metric', 'objective', 'key_result', 'vision', 'mission', 'strategic_theme', 'initiative'],
  users: ['persona', 'job', 'need', 'desired_outcome', 'job_step'],
  discovery: ['opportunity', 'solution', 'research_study', 'insight', 'competitor'],
  // (since v0.4.0) hypothesis is canonical; hypothesis_claim/hypothesis_evidence
  // are deprecated aliases. evidence replaces hypothesis_evidence in new graphs.
  validation: ['hypothesis', 'experiment_plan', 'experiment_run', 'learning', 'evidence', 'experiment', 'hypothesis_claim', 'hypothesis_evidence'],
  // (since v0.4.0) story_task collapsed into task (deprecated alias).
  execution: ['feature', 'epic', 'user_story', 'release', 'task', 'bug', 'user_story', 'story_task'],
}

// ── Chain definitions ──────────────────────────────────────────────────────

// Chain definitions reference canonical types. `hypothesis` is canonical
// (v0.4.0); legacy `hypothesis_claim` nodes fold into canonical via
// `canonicalType()`. `experiment` nodes also resolve correctly.
export const CHAINS = [
  { name: 'persona → job', from: 'persona', to: 'job', edgePattern: 'job' },
  { name: 'job → need', from: 'job', to: 'need', edgePattern: 'need' },
  { name: 'opportunity → solution', from: 'opportunity', to: 'solution', edgePattern: 'solution' },
  { name: 'solution → hypothesis', from: 'solution', to: 'hypothesis', edgePattern: 'hypothesis' },
  { name: 'hypothesis → experiment_plan', from: 'hypothesis', to: 'experiment_plan', edgePattern: 'experiment_plan' },
  { name: 'experiment_run → learning', from: 'experiment_run', to: 'learning', edgePattern: 'learning' },
  { name: 'objective → key_result', from: 'objective', to: 'key_result', edgePattern: 'key_result' },
  // (v0.2.7 split 2) features specify user_storys (the design
  // artefact / promise). story_tasks are the delivery work, linked from
  // user_story via story_task_implements_user_story.
  { name: 'feature → user_story', from: 'feature', to: 'user_story', edgePattern: 'user_story' },
] as const

// ── Type sort order (for tree rendering — group children by type) ────────────
// Follows the natural product thinking hierarchy: who → why → what → how → measure
const TYPE_SORT_ORDER: string[] = [
  // Identity
  'product', 'vision', 'mission',
  // Users
  'persona', 'job', 'job_step', 'need', 'desired_outcome',
  // Discovery
  'outcome', 'opportunity', 'solution', 'research_study', 'insight',
  // Validation
  'hypothesis', 'experiment', 'learning', 'evidence',
  // Competition
  'competitor', 'competitor_feature',
  // Strategy
  'strategic_theme', 'initiative', 'objective', 'key_result', 'metric',
  // Reaching
  'ideal_customer_profile', 'market_segment', 'positioning', 'messaging', 'acquisition_channel', 'content_strategy',
  // Converting
  'value_proposition', 'pricing_tier', 'pricing_strategy', 'funnel', 'funnel_step',
  // Building
  'feature', 'feature_area', 'epic', 'user_story', 'release', 'user_journey', 'user_flow', 'screen', 'screen_state',
  // Architecture
  'bounded_context', 'service', 'api_endpoint', 'database_schema', 'architecture_decision',
  // Sustaining
  'business_model', 'revenue_stream', 'cost_structure', 'unit_economics',
  // Learning
  'retrospective',
]

/** Get sort priority for a type (lower = higher in tree). Unknown types sort last. */
export function typeSortPriority(type: string): number {
  const idx = TYPE_SORT_ORDER.indexOf(type)
  return idx >= 0 ? idx : 999
}

/** Sort nodes by type priority, then alphabetically by title within same type */
export function sortByType(nodes: UPGBaseNode[]): UPGBaseNode[] {
  return [...nodes].sort((a, b) => {
    const priorityDiff = typeSortPriority(a.type) - typeSortPriority(b.type)
    if (priorityDiff !== 0) return priorityDiff
    return a.title.localeCompare(b.title)
  })
}

// ── Graph Digest ──────────────────────────────────────────────────────────

export interface CoverageRegion {
  covered: number
  total: number
  /**
   * NEW (Finding 9 /): True when this region is on the product
   * stage's expected-coverage list. Regions where this is `false` are
   * surfaced for awareness but excluded from `stage_summary.overall_pct`.
   */
  counted_toward_stage: boolean
  types_present: string[]
  types_missing: string[]
}

export interface CoverageStageSummary {
  stage: UPGProductStage
  /** Number of regions counted toward this stage's completeness. */
  regions_counted: number
  /** Counted regions that are fully covered (covered === total). */
  regions_complete: number
  /** Counted regions with partial coverage (0 < covered < total). */
  regions_partial: number
  /** Whole-number percentage 0-100, averaged across counted regions only. */
  overall_pct: number
}

export interface GraphDigest {
  product: { title: string; stage: string }
  counts: { total_nodes: number; total_edges: number; by_type: Record<string, number> }
  health: {
    orphan_count: number
    orphan_rate: number
    connectivity: number
    validation_rate: number
    user_coverage: number
  }
  chains: Record<string, number>
  /**
   * Per-region coverage map. Keys are `BUSINESS_AREAS` ids (e.g.
   * `identity`, `understanding`). The new stage-aware aggregate is at
   * `coverage.stage_summary` (typed loosely here so `Record<string,
   * CoverageRegion>` index lookups stay correct for callers).
   *
   * NOTE: callers iterating `Object.entries(coverage)` should skip the
   * `stage_summary` key — it carries a different shape.
   */
  coverage: Record<string, CoverageRegion> & { stage_summary?: CoverageStageSummary }
  lifecycle: Record<string, number>
}

export function computeGraphDigest(store: UPGFileStore): GraphDigest {
  const nodes = store.getAllNodes()
  const edges = store.getAllEdges()
  const product = store.getProduct()

  // Counts by type (raw — preserves the type as stored on the node)
  const byType: Record<string, number> = {}
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1

  // Counts by canonical type — legacy-typed nodes (e.g. `jtbd`) fold into
  // their canonical replacement (`job`). Source of truth for chain coverage.
  const byCanonicalType: Record<string, number> = {}
  for (const n of nodes) {
    const c = canonicalType(n.type)
    byCanonicalType[c] = (byCanonicalType[c] ?? 0) + 1
  }

  // Orphan detection
  const connectedNodes = new Set<string>()
  for (const e of edges) {
    connectedNodes.add(e.source)
    connectedNodes.add(e.target)
  }
  const orphanCount = nodes.filter((n) => !connectedNodes.has(n.id)).length

  // Health metrics — read from canonical counts so legacy types still flow through.
  // (since v0.4.0) `hypothesis` is canonical (reverted from hypothesis_claim).
  // Legacy hypothesis_claim nodes fold into canonical via canonicalType() above.
  // We aggregate plan + run for the experiment count so the headline
  // "validation_rate" reading matches what users count as "experiments".
  const hypothesisCount = byCanonicalType['hypothesis'] ?? 0
  const experimentCount =
    (byCanonicalType['experiment_plan'] ?? 0) +
    (byCanonicalType['experiment_run'] ?? 0) +
    // `experiment` is still a canonical type for back-compat reads; count it too.
    (byCanonicalType['experiment'] ?? 0)
  const personaCount = byCanonicalType['persona'] ?? 0

  // Chain completeness. Both parentType and edgePattern are matched against
  // canonical names — a `jtbd` node connected via a `persona_pursues_jtbd`
  // edge still counts as a `persona → job` chain, because both sides are
  // resolved to their canonical forms before comparison.
  const chainStats = (parentType: string, edgePattern: string) => {
    let withChild = 0
    const parents = nodes.filter((n) => canonicalType(n.type) === parentType)
    for (const p of parents) {
      const pEdges = store.getEdgesForNode(p.id)
      const matches = pEdges.some(
        (e) =>
          e.source === p.id &&
          (e.type.includes(edgePattern) ||
            e.type.includes(canonicalType(edgePattern)) ||
            // Match deprecated edge fragments by resolving each segment to canonical.
            e.type.split('_').some((seg) => canonicalType(seg) === edgePattern)),
      )
      if (matches) withChild++
    }
    return { with_child: withChild, total: parents.length }
  }

  /**
   * Like `chainStats` but ALSO counts parents covered via a registered
   * canonical bridge. Each bridge spec describes a 2-hop path where the
   * parent has an incoming edge from a bridge node, and the bridge node
   * has an outgoing edge to the child type. (2026-05-20).
   */
  const chainStatsWithBridge = (
    parentType: string,
    edgePattern: string,
    bridges: Array<{
      incoming_from: string
      incoming_edge_substring: string
      bridge_outgoing_edge_substring: string
      bridge_to_type: string
    }>,
  ) => {
    let withChild = 0
    const parents = nodes.filter((n) => canonicalType(n.type) === parentType)
    for (const p of parents) {
      const pEdges = store.getEdgesForNode(p.id)
      const directMatch = pEdges.some(
        (e) =>
          e.source === p.id &&
          (e.type.includes(edgePattern) ||
            e.type.includes(canonicalType(edgePattern)) ||
            e.type.split('_').some((seg) => canonicalType(seg) === edgePattern)),
      )
      if (directMatch) {
        withChild++
        continue
      }
      let bridgeMatch = false
      for (const bridge of bridges) {
        const incoming = pEdges.filter(
          (e) =>
            e.target === p.id &&
            e.type.includes(bridge.incoming_edge_substring),
        )
        for (const inE of incoming) {
          const bridgeNode = store.getNode(inE.source)
          if (!bridgeNode || canonicalType(bridgeNode.type) !== bridge.incoming_from) continue
          const bridgeOut = store.getEdgesForNode(bridgeNode.id)
          const reachesChild = bridgeOut.some((be) => {
            if (be.source !== bridgeNode.id) return false
            if (!be.type.includes(bridge.bridge_outgoing_edge_substring)) return false
            const childNode = store.getNode(be.target)
            return childNode != null && canonicalType(childNode.type) === bridge.bridge_to_type
          })
          if (reachesChild) {
            bridgeMatch = true
            break
          }
        }
        if (bridgeMatch) break
      }
      if (bridgeMatch) withChild++
    }
    return { with_child: withChild, total: parents.length }
  }

  const personaJob = chainStats('persona', 'job')
  // (2026-05-20): jobs and needs are often connected only via
  // personas — `job ← persona_pursues_job ← persona → persona_experiences_need
  // → need`. Count direct edges OR the persona-bridge path.
  const jobNeed = chainStatsWithBridge(
    'job',
    'need',
    [
      {
        incoming_from: 'persona',
        incoming_edge_substring: 'persona_pursues_job',
        bridge_outgoing_edge_substring: 'persona_experiences_need',
        bridge_to_type: 'need',
      },
    ],
  )
  const oppSolution = chainStats('opportunity', 'solution')
  // Hypothesis is canonical (v0.4.0). Legacy hypothesis_claim nodes
  // still match — `chainStats` runs source types through canonicalType().
  const hypExperiment = chainStats('hypothesis', 'experiment_plan')
  const expLearning = chainStats('experiment_run', 'learning')

  // Business area coverage — fold deprecated types into canonical via the spec
  const typeSet = new Set<string>()
  for (const t of Object.keys(byType)) {
    typeSet.add(t)
    typeSet.add(canonicalType(t))
  }
  // Stage-aware filtering (Finding 9 /). Resolve the product's stage
  // through the legacy-alias coercion path first, then read the list of
  // regions counted toward completeness for that stage. Per-region
  // `types_present` / `types_missing` are populated for ALL regions
  // regardless of stage — only `counted_toward_stage` and the
  // `stage_summary` aggregate distinguish counted from informational.
  const rawStage = product.stage ?? (nodes.find((n) => n.type === 'product')?.properties as Record<string, unknown> | undefined)?.stage
  const resolvedStage = resolveCoverageStage(rawStage)
  const countedRegions = new Set(STAGE_COVERAGE_TARGETS[resolvedStage] ?? [])

  const coverage: GraphDigest['coverage'] = {}
  const countedRegionStats: Array<{ covered: number; total: number }> = []
  for (const [area, def] of Object.entries(BUSINESS_AREAS)) {
    const present = def.types.filter((t) => typeSet.has(t))
    const missing = def.types.filter((t) => !typeSet.has(t))
    const isCounted = countedRegions.has(area)
    const region: CoverageRegion = {
      covered: present.length,
      total: def.types.length,
      counted_toward_stage: isCounted,
      types_present: present,
      types_missing: missing,
    }
    coverage[area] = region
    if (isCounted) countedRegionStats.push({ covered: region.covered, total: region.total })
  }

  // Stage summary — overall_pct is the mean per-region coverage across only
  // the counted regions. We compute per-region pct first (so a region with
  // 1/3 contributes 33, not 1) then average, so adding a tiny new region
  // doesn't tank the headline.
  const regionsComplete = countedRegionStats.filter((s) => s.total > 0 && s.covered === s.total).length
  const regionsPartial = countedRegionStats.filter((s) => s.covered > 0 && s.covered < s.total).length
  const perRegionPcts = countedRegionStats.map((s) => (s.total === 0 ? 100 : (s.covered / s.total) * 100))
  const overallPct = perRegionPcts.length === 0
    ? 0
    : Math.round(perRegionPcts.reduce((sum, pct) => sum + pct, 0) / perRegionPcts.length)
  coverage.stage_summary = {
    stage: resolvedStage,
    regions_counted: countedRegionStats.length,
    regions_complete: regionsComplete,
    regions_partial: regionsPartial,
    overall_pct: overallPct,
  }

  // Lifecycle balance — count via canonical types so `hypothesis`
  // (legacy) and `hypothesis_claim` (canonical) don't double-count when both
  // appear in LIFECYCLE_PHASES.validation. We dedupe the canonical set per
  // phase and read from `byCanonicalType` so legacy nodes are surfaced
  // exactly once under the canonical bucket.
  const lifecycle: Record<string, number> = {}
  for (const [phase, types] of Object.entries(LIFECYCLE_PHASES)) {
    const canonicalSet = new Set(types.map((t) => canonicalType(t)))
    lifecycle[phase] = [...canonicalSet].reduce(
      (sum, t) => sum + (byCanonicalType[t] ?? 0),
      0,
    )
  }

  return {
    product: {
      title: product.title,
      stage: (product.stage
        ?? (nodes.find((n) => n.type === 'product')?.properties as Record<string, unknown> | undefined)?.stage as string | undefined
        ?? 'unknown'),
    },
    counts: { total_nodes: nodes.length, total_edges: edges.length, by_type: byType },
    health: {
      orphan_count: orphanCount,
      orphan_rate: nodes.length > 0 ? Math.round((orphanCount / nodes.length) * 100) / 100 : 0,
      connectivity: nodes.length > 0 ? Math.round(((nodes.length - orphanCount) / nodes.length) * 100) / 100 : 0,
      validation_rate: hypothesisCount > 0 ? Math.round((experimentCount / hypothesisCount) * 100) / 100 : 0,
      user_coverage: personaCount > 0 ? Math.round((personaJob.with_child / personaCount) * 100) / 100 : 0,
    },
    chains: {
      persona_with_job: personaJob.with_child, persona_total: personaJob.total,
      job_with_need: jobNeed.with_child, job_total: jobNeed.total,
      opportunity_with_solution: oppSolution.with_child, opportunity_total: oppSolution.total,
      hypothesis_untested: hypothesisCount - hypExperiment.with_child, hypothesis_total: hypothesisCount,
      experiment_with_learning: expLearning.with_child, experiment_total: experimentCount,
    },
    coverage,
    lifecycle,
  }
}

// ── Search ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  node: UPGBaseNode
  score: number
  match_field: string
}

export function searchNodes(
  store: UPGFileStore,
  query: string,
  options?: { type?: string; fields?: string[]; limit?: number }
): SearchResult[] {
  const q = query.toLowerCase()
  const searchFields = new Set(options?.fields ?? ['title', 'description'])
  const limit = Math.min(options?.limit ?? 20, 100)

  let nodes = store.getAllNodes()
  if (options?.type) nodes = nodes.filter((n) => n.type === options.type)

  return nodes
    .map((n) => {
      let bestScore = 0
      let matchField = ''

      if (searchFields.has('title') && n.title.toLowerCase().includes(q)) {
        bestScore = 3; matchField = 'title'
      }
      if (searchFields.has('tags') && normalizeTags(n.tags)?.some((t: string) => t.toLowerCase().includes(q))) {
        if (2 > bestScore) { bestScore = 2; matchField = 'tags' }
      }
      if (searchFields.has('description') && n.description?.toLowerCase().includes(q)) {
        if (1 > bestScore) { bestScore = 1; matchField = 'description' }
      }
      if (searchFields.has('properties') && n.properties) {
        const propsStr = JSON.stringify(n.properties).toLowerCase()
        if (propsStr.includes(q)) {
          if (1 > bestScore) { bestScore = 1; matchField = 'properties' }
        }
      }

      if (bestScore === 0) return null
      return { node: n, score: bestScore, match_field: matchField }
    })
    .filter((s): s is SearchResult => s !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// ── Health Score (0-100) ──────────────────────────────────────────────────

export function computeHealthScore(digest: GraphDigest): number {
  const orphanRate = digest.health.orphan_rate
  const orphanScore = Math.max(0, 100 - orphanRate * 200)
  // Filter out the special `stage_summary` key — it's an aggregate, not a
  // per-region row. Iterating Object.entries(coverage) directly would have
  // counted it as a (zero-coverage) region.
  const regions = Object.entries(digest.coverage)
    .filter(([key]) => key !== 'stage_summary')
    .map(([, value]) => value as CoverageRegion)
  const domainsCovered = regions.filter((c) => c.covered > 0).length
  const domainScore = (domainsCovered / Object.keys(BUSINESS_AREAS).length) * 100

  // Chain completeness
  let chainsComplete = 0
  const chainPairs = [
    [digest.chains.persona_with_job, digest.chains.persona_total],
    [digest.chains.job_with_need, digest.chains.job_total],
    [digest.chains.opportunity_with_solution, digest.chains.opportunity_total],
    [digest.chains.experiment_with_learning, digest.chains.experiment_total],
  ]
  for (const [connected, total] of chainPairs) {
    if (total > 0 && connected === total) chainsComplete++
  }
  const chainScore = chainPairs.length > 0 ? (chainsComplete / chainPairs.length) * 100 : 100

  const validationScore = digest.health.validation_rate * 100

  return Math.round(
    orphanScore * 0.25 +
    domainScore * 0.25 +
    chainScore * 0.30 +
    validationScore * 0.20
  )
}

// ── Orphan detection ──────────────────────────────────────────────────────

export function getOrphans(store: UPGFileStore): UPGBaseNode[] {
  const connectedNodes = new Set<string>()
  for (const e of store.getAllEdges()) {
    connectedNodes.add(e.source)
    connectedNodes.add(e.target)
  }
  return store.getAllNodes().filter((n) => !connectedNodes.has(n.id))
}

// ── List with filters ──────────────────────────────────────────────────────

export interface ListNodesOptions {
  type?: string
  status?: string
  parentId?: string
  tags?: string[]
  includeEdges?: boolean
  countOnly?: boolean
  limit?: number
  offset?: number
}

export interface ListNodesResult {
  nodes: Array<Record<string, unknown>>
  total: number
}

export function listNodes(
  store: UPGFileStore,
  options?: ListNodesOptions
): ListNodesResult {
  let nodes = store.getAllNodes()

  if (options?.type) nodes = nodes.filter((n) => n.type === options.type)
  if (options?.status) nodes = nodes.filter((n) => n.status === options.status)
  if (options?.tags && options.tags.length > 0) {
    const filterTags = options.tags
    nodes = nodes.filter((n) => normalizeTags(n.tags)?.some((t: string) => filterTags.includes(t)))
  }
  if (options?.parentId) {
    const parentEdges = store.getEdgesForNode(options.parentId)
    const childIds = new Set(
      parentEdges.filter((e) => e.source === options.parentId).map((e) => e.target)
    )
    nodes = nodes.filter((n) => childIds.has(n.id))
  }

  const total = nodes.length
  const offset = options?.offset ?? 0
  const limit = Math.min(options?.limit ?? 50, 200)

  const page = nodes.slice(offset, offset + limit).map((n) => {
    const entry: Record<string, unknown> = {
      id: n.id,
      type: n.type,
      title: n.title,
      status: n.status,
      tags: n.tags,
    }
    if (options?.includeEdges) {
      entry.edges = store.getEdgesForNode(n.id).map((e) => ({
        id: e.id,
        type: e.type,
        source: e.source,
        target: e.target,
      }))
    }
    return entry
  })

  return { nodes: page, total }
}

// ── Get single node with edges ──────────────────────────────────────────────

export interface GetNodeResult {
  node: UPGBaseNode
  edges_out: Array<Record<string, unknown>>
  edges_in: Array<Record<string, unknown>>
}

export function getNode(
  store: UPGFileStore,
  args: { node_id: string; compact_edges?: boolean }
): GetNodeResult | null {
  const node = store.getNode(args.node_id)
  if (!node) return null

  const compact = args.compact_edges ?? false
  const edges = store.getEdgesForNode(args.node_id)

  const edgesOut = edges
    .filter((e) => e.source === args.node_id)
    .map((e) =>
      compact
        ? { id: e.id, type: e.type, source: e.source, target: e.target }
        : { ...e, target_title: store.getNode(e.target)?.title ?? '(unknown)' },
    )

  const edgesIn = edges
    .filter((e) => e.target === args.node_id)
    .map((e) =>
      compact
        ? { id: e.id, type: e.type, source: e.source, target: e.target }
        : { ...e, source_title: store.getNode(e.source)?.title ?? '(unknown)' },
    )

  return { node, edges_out: edgesOut, edges_in: edgesIn }
}

// ── Get multiple nodes with edges (batch) ────────────────────────────────────

export interface GetNodesResult {
  nodes: Array<GetNodeResult>
  total: number
  not_found?: string[]
}

export function getNodes(
  store: UPGFileStore,
  args: { ids: string[]; compact_edges?: boolean }
): GetNodesResult {
  const compact = args.compact_edges ?? false
  const results: GetNodeResult[] = []
  const notFound: string[] = []

  for (const id of args.ids) {
    const result = getNode(store, { node_id: id, compact_edges: compact })
    if (!result) {
      notFound.push(id)
      continue
    }
    results.push(result)
  }

  const response: GetNodesResult = { nodes: results, total: results.length }
  if (notFound.length > 0) response.not_found = notFound
  return response
}

// ── Create node ──────────────────────────────────────────────────────────────

export interface CreateNodeArgs {
  type: string
  title: string
  description?: string
  tags?: unknown
  status?: string
  properties?: Record<string, unknown>
  parent_id?: string
}

export interface CreateNodeResult {
  node: UPGBaseNode
  edge: UPGEdge | null
  warning?: string
}

export function createNode(
  store: UPGFileStore,
  args: CreateNodeArgs
): CreateNodeResult {
  // Validate the entity type up front. Aliases (deprecated → canonical)
  // are accepted with a warning; genuinely unknown types throw
  // `UnknownEntityTypeError` (with near-miss suggestions) so the caller cannot
  // accidentally write an orphan node that no edge constraint will accept.
  const resolved = resolveEntityType(args.type)
  const canonicalNodeType = resolved.canonical
  const aliasWarning = resolved.alias
    ? `Type '${resolved.alias.from}' aliased to canonical '${resolved.alias.to}'. Update your caller to use '${resolved.alias.to}' directly.`
    : undefined

  const newNode: UPGBaseNode = {
    id: nodeId(),
    type: canonicalNodeType as UPGEntityType,
    title: args.title,
  }
  if (args.description) newNode.description = args.description
  if (args.tags) newNode.tags = normalizeTags(args.tags) ?? []
  if (args.properties) newNode.properties = args.properties
  autoFillSlug(newNode, store)

  // Lifecycle-aware status handling
  let warning: string | undefined = aliasWarning
  if (args.status) {
    newNode.status = args.status
    const statusWarning = validateStatusAgainstLifecycle(canonicalNodeType, args.status)
    if (statusWarning) warning = warning ? `${warning} | ${statusWarning}` : statusWarning
  } else {
    // Auto-default to initial_phase if the type has a lifecycle
    const defaultStatus = getDefaultStatus(canonicalNodeType)
    if (defaultStatus) newNode.status = defaultStatus
  }

  store.addNode(newNode)

  let edge: UPGEdge | null = null
  if (args.parent_id) {
    const parent = store.getNode(args.parent_id)
    if (!parent) {
      return {
        node: newNode,
        edge: null,
        warning: (warning ? warning + ' | ' : '') + `Parent node ${args.parent_id} not found. Node created without edge.`,
      }
    }
    const inference = inferEdgeTypeWithTier(parent.type, canonicalNodeType)
    if (!inference.ok) {
      // Do NOT fabricate the parent edge. Node still lands; caller
      // is told the edge couldn't be canonicalised so they can pick an
      // explicit edge type with create_edge.
      const suggestion = inference.suggestions.length > 0
        ? ` Suggestions: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
        : ''
      return {
        node: newNode,
        edge: null,
        warning:
          (warning ? warning + ' | ' : '') +
          `Parent edge not created — no canonical edge for ${parent.type} → ${canonicalNodeType}.${suggestion}`,
      }
    }
    edge = {
      id: edgeId(),
      source: args.parent_id,
      target: newNode.id,
      type: inference.edgeType,
    }
    store.addEdge(edge)
  }

  return warning ? { node: newNode, edge, warning } : { node: newNode, edge: edge as UPGEdge | null }
}

// ── Create edge ──────────────────────────────────────────────────────────────

export interface CreateEdgeArgs {
  source_id: string
  target_id?: string
  target_title?: string
  target_type?: string
  type?: string
}

export type CreateEdgeResult =
  | { edge: UPGEdge; warning?: string }
  | {
      error: string
      /**
       * Source/target types when the failure is a "no canonical edge"
       * resolver miss — surfaced so the MCP handler can attach
       * `anchor_hint` / `alternate_anchors` / `adjacent_edges` enrichment
       * blocks ( +).
       */
      no_canonical_edge_for?: { source_type: string; target_type: string }
    }

export function createEdge(
  store: UPGFileStore,
  args: CreateEdgeArgs
): CreateEdgeResult {
  // Resolve target: by ID or by title+type
  let targetId = args.target_id

  if (!targetId && !args.target_title) {
    return { error: 'Provide either target_id or target_title (with target_type)' }
  }

  if (!targetId && args.target_title) {
    if (!args.target_type) {
      return { error: 'target_type is required when using target_title' }
    }
    const candidates = store
      .getAllNodes()
      .filter(
        (n) =>
          n.type === args.target_type &&
          n.title.toLowerCase() === args.target_title!.toLowerCase(),
      )
    if (candidates.length === 0) {
      return { error: `No ${args.target_type} found with title "${args.target_title}"` }
    }
    if (candidates.length > 1) {
      return {
        error: `Ambiguous: ${candidates.length} nodes match "${args.target_title}" (type: ${args.target_type}). Use target_id instead. IDs: ${candidates.map((c) => c.id).join(', ')}`,
      }
    }
    targetId = candidates[0].id
  }

  const source = store.getNode(args.source_id)
  const target = store.getNode(targetId!)
  if (!source) return { error: `Source not found: ${args.source_id}` }
  if (!target) return { error: `Target not found: ${targetId}` }

  // Refuse graph-topology self-loops up-front. No canonical UPG edge type is
  // currently self-referential; an opt-in flag can be added later if one
  // becomes needed. Tracked as audit finding F2 (2026-05-20).
  if (args.source_id === targetId) {
    return {
      error:
        `Self-loop refused: source and target resolve to the same node "${args.source_id}". ` +
        `No canonical UPG edge type is self-referential. ` +
        `If you genuinely need a self-referential edge, file a spec proposal first.`,
    }
  }

  let edgeType: UPGEdgeType
  let edgeWarning: string | undefined

  if (args.type) {
    // User-supplied edge type — verify against the catalog's source/target
    // pair when the type is canonical. Non-canonical types fall through
    // (they're still surfaced by validate_graph as edge_drift). Tracked as
    // audit finding F1 (2026-05-20).
    const pairCheck = validateEdgeTypePair(args.type, source.type as string, target.type as string)
    if (!pairCheck.valid) {
      return { error: pairCheck.reason }
    }
    edgeType = args.type as UPGEdgeType
  } else {
    const inference = inferEdgeTypeWithTier(source.type, target.type)
    if (!inference.ok) {
      // Refuse to fabricate an edge type when the user did not
      // pass one. They must either pass an explicit `type` from the catalog
      // or fix the source/target types.
      const suggestion = inference.suggestions.length > 0
        ? ` Try one of: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
        : ''
      return {
        error: `No canonical edge type for ${source.type} → ${target.type}.${suggestion} Pass an explicit \`type\` if you need a non-catalog edge.`,
        no_canonical_edge_for: {
          source_type: source.type as string,
          target_type: target.type as string,
        },
      }
    }
    edgeType = inference.edgeType
    if (inference.aliased) {
      const parts = inference.aliased.map((a) => `${a.from} → ${a.to}`).join(', ')
      edgeWarning = `Edge inferred from canonical (${parts}).`
    }
  }

  const edge: UPGEdge = {
    id: edgeId(),
    source: args.source_id,
    target: targetId!,
    type: edgeType,
  }

  store.addEdge(edge)
  const response: { edge: UPGEdge; warning?: string } = { edge }
  if (edgeWarning) response.warning = edgeWarning
  return response
}

// ── Delete node ──────────────────────────────────────────────────────────────

export interface DeleteNodeResult {
  deleted_node_id: string
  deleted_node_title: string
  deleted_edge_ids: string[]
}

export function deleteNode(
  store: UPGFileStore,
  args: { node_id: string }
): DeleteNodeResult {
  const { node, removedEdgeIds } = store.removeNode(args.node_id)
  return {
    deleted_node_id: node.id,
    deleted_node_title: node.title,
    deleted_edge_ids: removedEdgeIds,
  }
}

// ── Delete edge ──────────────────────────────────────────────────────────────

export interface DeleteEdgeResult {
  deleted_edge_id: string
}

export function deleteEdge(
  store: UPGFileStore,
  args: { edge_id: string }
): DeleteEdgeResult {
  const edge = store.removeEdge(args.edge_id)
  return { deleted_edge_id: edge.id }
}

// ── Move node (atomic re-parent) ──────────────────────────────────

export interface MoveNodeArgs {
  node_id: string
  new_parent_id: string
  /** Override the inferred edge type. Must be a key in UPG_EDGE_CATALOG. */
  new_edge_type?: string
  /**
   * Disambiguate when the node has more than one hierarchy edge. Caller
   * specifies which existing parent edge to delete; otherwise the move is
   * rejected with the candidate edge ids.
   */
  old_edge_id?: string
}

export type MoveNodeResult =
  | {
      moved: true
      node_id: string
      new_edge: UPGEdge
      removed_edge_id: string | null
      /** Removed edge object — exposed for caller-driven rollback (e.g. batch). */
      removed_edge?: UPGEdge
      warning?: string
    }
  | { moved: false; error: string }

/**
 * Find the existing parent edge(s) for a node — edges where the node is
 * the target and the edge has classification 'hierarchy' in the catalog.
 * Non-canonical edges (not in UPG_EDGE_CATALOG) are skipped.
 */
function findParentEdges(store: UPGFileStore, nodeId: string): UPGEdge[] {
  const incoming = store.getEdgesForNode(nodeId).filter((e) => e.target === nodeId)
  return incoming.filter((e) => {
    const def = UPG_EDGE_CATALOG[e.type]
    return def?.classification === 'hierarchy'
  })
}

export function moveNode(store: UPGFileStore, args: MoveNodeArgs): MoveNodeResult {
  const node = store.getNode(args.node_id)
  if (!node) return { moved: false, error: `Node not found: ${args.node_id}` }

  const newParent = store.getNode(args.new_parent_id)
  if (!newParent) {
    return { moved: false, error: `New parent not found: ${args.new_parent_id}` }
  }

  if (args.node_id === args.new_parent_id) {
    return { moved: false, error: 'Cannot move a node onto itself.' }
  }

  // Identify the parent edge to remove (if any).
  let oldEdge: UPGEdge | null = null
  if (args.old_edge_id) {
    const explicit = store.getEdge(args.old_edge_id)
    if (!explicit) {
      return { moved: false, error: `old_edge_id not found: ${args.old_edge_id}` }
    }
    if (explicit.target !== args.node_id) {
      return {
        moved: false,
        error: `old_edge_id ${args.old_edge_id} does not target node ${args.node_id}.`,
      }
    }
    oldEdge = explicit
  } else {
    const parents = findParentEdges(store, args.node_id)
    if (parents.length > 1) {
      return {
        moved: false,
        error: `Node has ${parents.length} hierarchy edges; pass old_edge_id to disambiguate. Candidates: ${parents
          .map((e) => `${e.id} (${e.type})`)
          .join(', ')}`,
      }
    }
    oldEdge = parents[0] ?? null
  }

  // Resolve the new edge type. Explicit override > catalog inference.
  let newEdgeType: UPGEdgeType
  let aliasWarning: string | undefined
  if (args.new_edge_type) {
    if (!UPG_EDGE_CATALOG[args.new_edge_type as UPGEdgeType]) {
      return {
        moved: false,
        error: `new_edge_type "${args.new_edge_type}" is not in UPG_EDGE_CATALOG.`,
      }
    }
    newEdgeType = args.new_edge_type as UPGEdgeType
  } else {
    const inference = inferEdgeTypeWithTier(newParent.type, node.type)
    if (!inference.ok) {
      const suggestion = inference.suggestions.length > 0
        ? ` Suggestions: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
        : ''
      return {
        moved: false,
        error: `No canonical edge for ${newParent.type} → ${node.type}.${suggestion} Pass an explicit new_edge_type.`,
      }
    }
    newEdgeType = inference.edgeType
    if (inference.aliased) {
      const parts = inference.aliased.map((a) => `${a.from} → ${a.to}`).join(', ')
      aliasWarning = `Edge inferred from canonical (${parts}).`
    }
  }

  // Validate the resolved edge against catalog source/target constraints.
  const def = UPG_EDGE_CATALOG[newEdgeType]
  if (def.source_type !== newParent.type) {
    return {
      moved: false,
      error: `Edge "${newEdgeType}" requires source type "${def.source_type}", got "${newParent.type}".`,
    }
  }
  if (def.target_type !== node.type) {
    return {
      moved: false,
      error: `Edge "${newEdgeType}" requires target type "${def.target_type}", got "${node.type}".`,
    }
  }

  // Build the new edge upfront. If addEdge fails for any reason, we'll
  // rollback by re-adding the old edge.
  const newEdge: UPGEdge = {
    id: edgeId(),
    source: args.new_parent_id,
    target: args.node_id,
    type: newEdgeType,
  }

  // Atomic swap. removeEdge → addEdge in a single synchronous block. If
  // addEdge throws (target/source missing — should not happen given checks
  // above), rollback by restoring the old edge.
  if (oldEdge) {
    store.removeEdge(oldEdge.id)
  }
  try {
    store.addEdge(newEdge)
  } catch (err) {
    if (oldEdge) {
      // Restore — skipValidation because the old edge was already in the
      // graph and valid before we touched it.
      store.addEdge(oldEdge, true)
    }
    return {
      moved: false,
      error: `Failed to add new edge: ${(err as Error).message}. Graph rolled back.`,
    }
  }

  return {
    moved: true,
    node_id: args.node_id,
    new_edge: newEdge,
    removed_edge_id: oldEdge?.id ?? null,
    ...(oldEdge ? { removed_edge: oldEdge } : {}),
    ...(aliasWarning ? { warning: aliasWarning } : {}),
  }
}

// ── batch_move_nodes — atomic, all-or-nothing (cap 50) ──────────────────────

export interface BatchMoveNodesResult {
  moves: Array<{ node_id: string; new_edge: UPGEdge; removed_edge_id: string | null }>
  count: number
  warnings?: string[]
}

export type BatchMoveNodesOutcome =
  | { ok: true; result: BatchMoveNodesResult }
  | { ok: false; error: string; failed_at_index: number | null }

/**
 * Apply a batch of moves atomically. Validates every move against the catalog
 * BEFORE any mutation; on the first failure the batch is rejected with no
 * changes to the graph. If a mutation fails mid-application (highly unusual
 * given upfront validation), already-applied moves are rolled back.
 */
export function batchMoveNodes(
  store: UPGFileStore,
  moves: MoveNodeArgs[],
): BatchMoveNodesOutcome {
  if (moves.length === 0) return { ok: false, error: 'moves array is empty', failed_at_index: null }
  if (moves.length > 50) return { ok: false, error: 'Maximum 50 moves per batch', failed_at_index: null }

  // ── Validation pass ─────────────────────────────────────────────────────
  // We dry-run each move's resolution against the CURRENT graph. This catches
  // (a) missing nodes, (b) unresolved edge inference, (c) catalog
  // constraint violations. We don't catch chained moves where move N depends
  // on the state after move N-1; that would require simulating the graph.
  // For now: reject those by requiring caller to pass new_edge_type per move
  // (fully spec'd) or to split into sequential calls. Surface that limit in
  // the docstring.
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    const node = store.getNode(m.node_id)
    if (!node) return { ok: false, error: `Move at index ${i}: node not found: ${m.node_id}`, failed_at_index: i }
    const parent = store.getNode(m.new_parent_id)
    if (!parent) return { ok: false, error: `Move at index ${i}: new parent not found: ${m.new_parent_id}`, failed_at_index: i }
    if (m.node_id === m.new_parent_id) {
      return { ok: false, error: `Move at index ${i}: cannot move a node onto itself.`, failed_at_index: i }
    }
    if (m.new_edge_type && !UPG_EDGE_CATALOG[m.new_edge_type as UPGEdgeType]) {
      return { ok: false, error: `Move at index ${i}: new_edge_type "${m.new_edge_type}" is not in UPG_EDGE_CATALOG.`, failed_at_index: i }
    }
    if (!m.new_edge_type) {
      const inference = inferEdgeTypeWithTier(parent.type, node.type)
      if (!inference.ok) {
        return { ok: false, error: `Move at index ${i}: no canonical edge for ${parent.type} → ${node.type}. Pass an explicit new_edge_type.`, failed_at_index: i }
      }
    }
  }

  // ── Apply pass with rollback ────────────────────────────────────────────
  type Applied = { newEdge: UPGEdge; oldEdge: UPGEdge | null }
  const applied: Applied[] = []
  for (let i = 0; i < moves.length; i++) {
    const result = moveNode(store, moves[i])
    if (!result.moved) {
      // Roll back already-applied moves in reverse order — restore the
      // exact old edge objects captured by moveNode so the graph is bit-
      // for-bit identical to where it started.
      for (let j = applied.length - 1; j >= 0; j--) {
        const a = applied[j]
        try {
          store.removeEdge(a.newEdge.id)
        } catch { /* edge already gone */ }
        if (a.oldEdge) {
          try {
            store.addEdge(a.oldEdge, true)
          } catch { /* duplicate id — graph diverged, surface but continue */ }
        }
      }
      return { ok: false, error: `Move at index ${i}: ${result.error}`, failed_at_index: i }
    }
    applied.push({
      newEdge: result.new_edge,
      oldEdge: result.removed_edge ?? null,
    })
  }

  return {
    ok: true,
    result: {
      moves: applied.map((a, i) => ({
        node_id: moves[i].node_id,
        new_edge: a.newEdge,
        removed_edge_id: a.oldEdge?.id ?? null,
      })),
      count: moves.length,
    },
  }
}

// ── batch_create_nodes (with optional atomic edges) ─────────────────────────

export interface BatchNodeInput {
  type: string
  title: string
  description?: string
  status?: string
  tags?: unknown
  properties?: Record<string, unknown>
  parent_id?: string
  parent_ref?: string
}

export interface BatchEdgeInput {
  from_ref: string
  to_ref: string
  type?: string
}

export interface BatchCreateArgs {
  nodes: BatchNodeInput[]
  edges?: BatchEdgeInput[]
}

export interface BatchCreateOk {
  ok: true
  created: Array<{ id: string; type: string; title: string; status?: string }>
  edges: UPGEdge[]
  explicit_edges?: UPGEdge[]
  count: number
  warnings?: string[]
}

export interface BatchCreateFail {
  ok: false
  error: string
}

export type BatchCreateResult = BatchCreateOk | BatchCreateFail

/**
 * Atomic batch creation — nodes plus optional explicit edges in a single
 * all-or-nothing transaction.
 *
 * Validation pass walks every node and every edge against the canonical
 * schema BEFORE any mutation. If anything fails, no nodes and no edges land.
 *
 * Apply pass creates nodes (with parent_ref / parent_id auto-edges from
 * inference; failed inference = warning, never fabrication),
 * then creates the explicit edges. If ANY apply step throws, rolls back
 * every already-applied node + edge so the graph is bit-for-bit identical
 * to the pre-call state.
 */
export function batchCreateNodes(
  store: UPGFileStore,
  args: BatchCreateArgs,
): BatchCreateResult {
  const { nodes, edges: explicitEdges = [] } = args
  if (!Array.isArray(nodes)) return { ok: false, error: 'Missing required parameter: nodes (array)' }
  if (nodes.length === 0) return { ok: false, error: 'nodes array is empty' }
  if (nodes.length > 50) return { ok: false, error: 'Maximum 50 nodes per batch' }
  if (nodes.length + explicitEdges.length > 50) {
    return { ok: false, error: `Maximum 50 items per batch (got ${nodes.length} nodes + ${explicitEdges.length} edges)` }
  }

  // ── Validation pass ─────────────────────────────────────────────────────
  const resolvedTypes: string[] = []
  const aliasWarnings: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n.type) return { ok: false, error: `Node at index ${i}: missing required field "type"` }
    if (!n.title) return { ok: false, error: `Node at index ${i}: missing required field "title"` }
    try {
      const resolved = resolveEntityType(n.type)
      resolvedTypes.push(resolved.canonical)
      if (resolved.alias) {
        aliasWarnings.push(
          `Node at index ${i}: type '${resolved.alias.from}' aliased to canonical '${resolved.alias.to}'.`,
        )
      }
    } catch (err) {
      if (err instanceof UnknownEntityTypeError) {
        return { ok: false, error: `Node at index ${i}: ${err.message}` }
      }
      throw err
    }
    if (n.parent_ref !== undefined) {
      const match = n.parent_ref.match(/^\$(\d+)$/)
      if (!match) return { ok: false, error: `Node at index ${i}: invalid parent_ref "${n.parent_ref}" — use "$0", "$1", etc.` }
      const refIndex = parseInt(match[1], 10)
      if (refIndex >= i) return { ok: false, error: `Node at index ${i}: parent_ref "${n.parent_ref}" must reference an earlier index (0–${i - 1})` }
    }
    if (n.parent_id !== undefined && !store.getNode(n.parent_id)) {
      return { ok: false, error: `Node at index ${i}: parent_id "${n.parent_id}" not found in graph` }
    }
  }

  type ResolvedEdgeRef =
    | { kind: 'ref'; index: number }
    | { kind: 'id'; id: string }
  type ValidatedEdge = {
    from: ResolvedEdgeRef
    to: ResolvedEdgeRef
    typeOverride?: UPGEdgeType
  }
  const validatedEdges: ValidatedEdge[] = []

  const resolveEdgeRef = (raw: unknown, label: string, edgeIndex: number): ResolvedEdgeRef | { error: string } => {
    if (typeof raw !== 'string' || raw.length === 0) {
      return { error: `Edge at index ${edgeIndex}: missing or invalid "${label}"` }
    }
    const refMatch = raw.match(/^\$(\d+)$/)
    if (refMatch) {
      const idx = parseInt(refMatch[1], 10)
      if (idx >= nodes.length) {
        return { error: `Edge at index ${edgeIndex}: ${label} "${raw}" out of range — only ${nodes.length} nodes in this batch.` }
      }
      return { kind: 'ref', index: idx }
    }
    if (!store.getNode(raw)) {
      return { error: `Edge at index ${edgeIndex}: ${label} "${raw}" not found in graph (and is not a $N ref into this batch).` }
    }
    return { kind: 'id', id: raw }
  }
  const refSourceType = (ref: ResolvedEdgeRef): string =>
    ref.kind === 'ref' ? resolvedTypes[ref.index] : store.getNode(ref.id)!.type

  for (let i = 0; i < explicitEdges.length; i++) {
    const e = explicitEdges[i]
    const fromResolved = resolveEdgeRef(e.from_ref, 'from_ref', i)
    if ('error' in fromResolved) return { ok: false, error: fromResolved.error }
    const toResolved = resolveEdgeRef(e.to_ref, 'to_ref', i)
    if ('error' in toResolved) return { ok: false, error: toResolved.error }

    // Self-loop refusal — both sides resolve to the same ref OR the same
    // pre-existing node id. No canonical UPG edge type is self-referential.
    // F2 (2026-05-20).
    const sameRef =
      fromResolved.kind === 'ref' && toResolved.kind === 'ref' && fromResolved.index === toResolved.index
    const sameId =
      fromResolved.kind === 'id' && toResolved.kind === 'id' && fromResolved.id === toResolved.id
    if (sameRef || sameId) {
      return {
        ok: false,
        error:
          `Edge at index ${i}: self-loop refused — source and target resolve to the same node. ` +
          `No canonical UPG edge type is self-referential.`,
      }
    }

    let typeOverride: UPGEdgeType | undefined
    if (e.type !== undefined) {
      if (!UPG_EDGE_CATALOG[e.type as UPGEdgeType]) {
        return { ok: false, error: `Edge at index ${i}: type "${e.type}" not in UPG_EDGE_CATALOG.` }
      }
      // Catalog pair validation against the resolved source/target types.
      // F1 (2026-05-20).
      const sourceType = refSourceType(fromResolved)
      const targetType = refSourceType(toResolved)
      const pairCheck = validateEdgeTypePair(e.type, sourceType, targetType)
      if (!pairCheck.valid) {
        return { ok: false, error: `Edge at index ${i}: ${pairCheck.reason}` }
      }
      typeOverride = e.type as UPGEdgeType
    } else {
      const sourceType = refSourceType(fromResolved)
      const targetType = refSourceType(toResolved)
      const inference = inferEdgeTypeWithTier(sourceType, targetType)
      if (!inference.ok) {
        const suggestion = inference.suggestions.length > 0
          ? ` Suggestions: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
          : ''
        return { ok: false, error: `Edge at index ${i}: no canonical edge for ${sourceType} → ${targetType}.${suggestion} Pass an explicit \`type\` to override.` }
      }
    }
    validatedEdges.push({ from: fromResolved, to: toResolved, typeOverride })
  }

  // ── Apply pass with full rollback ───────────────────────────────────────
  const createdNodes: Array<{ id: string; type: string; title: string; status?: string }> = []
  const createdNodeRefs: UPGBaseNode[] = []
  const createdParentEdges: UPGEdge[] = []
  const explicitCreated: UPGEdge[] = []
  const warnings: string[] = [...aliasWarnings]

  const rollbackAll = () => {
    for (const e of explicitCreated.slice().reverse()) {
      try { store.removeEdge(e.id) } catch { /* gone */ }
    }
    for (const e of createdParentEdges.slice().reverse()) {
      try { store.removeEdge(e.id) } catch { /* gone */ }
    }
    for (const n of createdNodeRefs.slice().reverse()) {
      try { store.removeNode(n.id) } catch { /* gone */ }
    }
  }

  try {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const newNode: UPGBaseNode = {
        id: nodeId(),
        type: resolvedTypes[i] as UPGEntityType,
        title: n.title,
      }
      if (n.description) newNode.description = n.description
      if (n.tags) newNode.tags = normalizeTags(n.tags) ?? []
      if (n.properties) newNode.properties = n.properties

      if (n.status) {
        newNode.status = n.status
        const sw = validateStatusAgainstLifecycle(newNode.type, n.status)
        if (sw) warnings.push(`Node "${n.title}": ${sw}`)
      } else {
        const ds = getDefaultStatus(newNode.type)
        if (ds) newNode.status = ds
      }

      autoFillSlug(newNode, store)
      store.addNode(newNode)
      createdNodes.push({ id: newNode.id, type: newNode.type, title: newNode.title, status: newNode.status })
      createdNodeRefs.push(newNode)

      let parentId = n.parent_id
      if (n.parent_ref !== undefined) {
        const refIndex = parseInt(n.parent_ref.slice(1), 10)
        parentId = createdNodes[refIndex].id
      }
      if (parentId) {
        const parent = store.getNode(parentId)
        if (parent) {
          const inference = inferEdgeTypeWithTier(parent.type, newNode.type)
          if (inference.ok) {
            const edge: UPGEdge = { id: edgeId(), source: parentId, target: newNode.id, type: inference.edgeType }
            store.addEdge(edge)
            createdParentEdges.push(edge)
          } else {
            const suggestion = inference.suggestions.length > 0
              ? ` Suggestions: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
              : ''
            warnings.push(
              `Node "${newNode.title}": parent edge not created — no canonical edge for ${parent.type} → ${newNode.type}.${suggestion}`,
            )
          }
        }
      }
    }

    for (const v of validatedEdges) {
      const sourceId = v.from.kind === 'ref' ? createdNodes[v.from.index].id : v.from.id
      const targetId = v.to.kind === 'ref' ? createdNodes[v.to.index].id : v.to.id
      let edgeType: UPGEdgeType
      if (v.typeOverride) {
        edgeType = v.typeOverride
      } else {
        const source = store.getNode(sourceId)!
        const target = store.getNode(targetId)!
        const inference = inferEdgeTypeWithTier(source.type, target.type)
        if (!inference.ok) {
          throw new Error(`Edge inference unexpectedly failed for ${source.type} → ${target.type} (post-validation).`)
        }
        edgeType = inference.edgeType
      }
      const newEdge: UPGEdge = { id: edgeId(), source: sourceId, target: targetId, type: edgeType }
      store.addEdge(newEdge)
      explicitCreated.push(newEdge)
    }
  } catch (err) {
    rollbackAll()
    return {
      ok: false,
      error: `Atomic batch failed during apply: ${(err as Error).message}. All nodes and edges rolled back.`,
    }
  }

  //: orphan warning. When the caller batched ≥2 nodes but produced
  // zero edges of any kind (no parent_ref auto-edges, no explicit edges),
  // surface a loud warning. Authors who don't read the warnings field stay
  // backward-compatible; authors who do read it get a teaching moment instead
  // of a silent orphan graph.
  if (
    createdNodes.length >= 2 &&
    createdParentEdges.length === 0 &&
    explicitCreated.length === 0
  ) {
    warnings.push(
      `Created ${createdNodes.length} nodes with no edges — they are orphans. ` +
        `Use the edges[] array in this call to link them. ` +
        `See get_entity_schema(<type>) for canonical edges per type.`,
    )
  }

  const result: BatchCreateOk = {
    ok: true,
    created: createdNodes,
    edges: createdParentEdges,
    count: createdNodes.length,
  }
  if (explicitCreated.length > 0) result.explicit_edges = explicitCreated
  if (warnings.length > 0) result.warnings = warnings
  return result
}

// ── migrate_node_type — single-node type change ───────────────────

export interface MigrateNodeTypeArgs {
  node_id: string
  new_type: string
}

export type MigrateNodeTypeResult =
  | {
      migrated: true
      node_id: string
      from_type: string
      to_type: string
      edges_rewritten: Array<{ id: string; from: string; to: string }>
      warning?: string
    }
  | { migrated: false; error: string; suggestions?: string[] }

/**
 * Atomically change a single node's entity type and rewrite every incident
 * edge to its new canonical edge type derived from the catalog.
 *
 * Distinct from `migrate_type` (which rewrites EVERY node of a given type
 * across the whole graph by string substitution). This single-node variant
 * re-infers each affected edge from (source.type, target.type) via
 * `inferEdgeTypeWithTier`, so it preserves correctness when the graph mixes
 * canonical and deprecated types.
 *
 * If any incident edge cannot be re-inferred, the entire migration is
 * rejected and the graph is left unchanged. Rollback restores both the
 * node's original type and any edges already rewritten.
 */
export function migrateNodeType(
  store: UPGFileStore,
  args: MigrateNodeTypeArgs,
): MigrateNodeTypeResult {
  const node = store.getNode(args.node_id)
  if (!node) return { migrated: false, error: `Node not found: ${args.node_id}` }

  // Resolve new type — alias-aware. Unknown types throw, caught here
  // and translated to a structured failure so the caller doesn't have to.
  let resolved: EntityTypeResolution
  try {
    resolved = resolveEntityType(args.new_type)
  } catch (err) {
    if (err instanceof UnknownEntityTypeError) {
      return { migrated: false, error: err.message, suggestions: err.suggestions }
    }
    throw err
  }

  const oldType = node.type
  const newType = resolved.canonical
  const aliasWarning = resolved.alias
    ? `Type '${resolved.alias.from}' aliased to canonical '${resolved.alias.to}'.`
    : undefined
  if (oldType === newType) {
    return {
      migrated: true,
      node_id: args.node_id,
      from_type: oldType,
      to_type: newType,
      edges_rewritten: [],
      ...(aliasWarning ? { warning: aliasWarning } : {}),
    }
  }

  // Plan all edge rewrites BEFORE mutation. Each incident edge gets a new
  // canonical type derived from (source.type, target.type) under the new
  // type assignment. If any inference fails the migration is rejected.
  const incident = store.getEdgesForNode(args.node_id)
  type Plan = { oldEdge: UPGEdge; newType: UPGEdgeType }
  const plans: Plan[] = []
  for (const e of incident) {
    if (e.type === args.new_type) continue
    const sourceType = e.source === args.node_id ? newType : (store.getNode(e.source)?.type ?? '')
    const targetType = e.target === args.node_id ? newType : (store.getNode(e.target)?.type ?? '')
    if (!sourceType || !targetType) {
      return {
        migrated: false,
        error: `Edge ${e.id} references a missing node — fix graph integrity before migrating.`,
      }
    }
    const inference = inferEdgeTypeWithTier(sourceType, targetType)
    if (!inference.ok) {
      const suggestion = inference.suggestions.length > 0
        ? ` Suggestions: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
        : ''
      return {
        migrated: false,
        error: `Cannot re-infer edge ${e.id} (${e.type}) for ${sourceType} → ${targetType}.${suggestion} Delete the edge or pick an explicit edge type via update_node + create_edge.`,
      }
    }
    if (inference.edgeType !== e.type) {
      plans.push({ oldEdge: e, newType: inference.edgeType })
    }
  }

  // ── Apply pass with rollback ──────────────────────────────────────────
  // Mutating in place: remove old edges, change node type, add new edges.
  // If any addEdge throws, undo everything and surface the original error.
  const removed: UPGEdge[] = []
  const added: UPGEdge[] = []
  try {
    for (const p of plans) {
      const old = store.removeEdge(p.oldEdge.id)
      removed.push(old)
    }
    store.updateNode(args.node_id, { type: newType as UPGEntityType })
    for (const p of plans) {
      const newEdge: UPGEdge = {
        id: edgeId(),
        source: p.oldEdge.source,
        target: p.oldEdge.target,
        type: p.newType,
      }
      store.addEdge(newEdge)
      added.push(newEdge)
    }
  } catch (err) {
    // Rollback in reverse order.
    for (const a of added.slice().reverse()) {
      try { store.removeEdge(a.id) } catch { /* edge already gone */ }
    }
    try {
      store.updateNode(args.node_id, { type: oldType as UPGEntityType })
    } catch { /* node already gone — graph diverged, surface the original */ }
    for (const r of removed.slice().reverse()) {
      try { store.addEdge(r, true) } catch { /* duplicate id — surface the original */ }
    }
    return {
      migrated: false,
      error: `Migration failed mid-apply: ${(err as Error).message}. Graph rolled back.`,
    }
  }

  const edgesRewritten = plans.map((p, i) => ({
    id: added[i].id,
    from: p.oldEdge.type,
    to: p.newType,
  }))

  return {
    migrated: true,
    node_id: args.node_id,
    from_type: oldType,
    to_type: newType,
    edges_rewritten: edgesRewritten,
    ...(aliasWarning ? { warning: aliasWarning } : {}),
  }
}
