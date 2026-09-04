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
  validateProductStageStrict,
  collectSlugsForType,
  generateSlug,
  getLifecycleForType,
  getReplacementType,
  resolveSlugCollision,
  UPG_EDGE_CATALOG,
  edgeCarriesProperties,
  getScalarToEdgeMigrations,
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
// single `UnknownEntityTypeError` class; an `instanceof` thrown by the SDK
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
import { validateNodeWrite, validateExplicitEdgeType } from './write-validation.js'

/**
 * Thrown by single-node write tools (createNode / updateNode) when the unified
 * validation pass rejects an input on a STRICT dimension (unknown
 * status, or — in `strict` mode — an unknown property). Unknown entity TYPES
 * still throw `UnknownEntityTypeError` (a subclass-free sibling) so existing
 * `instanceof UnknownEntityTypeError` handlers keep working. Batch tools return
 * the same messages in their structured `{ ok: false, error }` envelope, so
 * single and batch agree for the same input.
 */
export class WriteValidationError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join(' | '))
    this.name = 'WriteValidationError'
    this.issues = issues
  }
}

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
  // is deprecated; use `evidence` + hypothesis_has_evidence edge instead.
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
  // Operations is a maintenance-stage concern: incidents, postmortems, error
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
//   Learning, the retrospective).
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
  // Sunset products are winding down; Identity stays (the product still has
  // a name + vision) and Learning becomes the priority (capture the
  // retrospective + reasons for sunsetting). Everything else is informational.
  sunset: ['identity', 'learning'],
}

/**
 * Resolve the canonical UPGProductStage for digest coverage. Returns
 * `'concept'` as the default when stage is missing or unrecognised; concept
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

/**
 * (S-07): map a `CHAINS` entry to the keys it occupies in
 * `computeGraphDigest(...).chains`. The two public vocabularies disagree —
 * `CHAINS[i].name` is `'persona → job'` while `digest.chains` is keyed
 * `persona_with_job` / `persona_total` — so `digest.chains[chain.name]` was
 * always `undefined`. Use this helper to bridge them:
 *
 * ```ts
 * const { with_child, total } = chainDigestKeys(CHAINS[0])
 * const connected = digest.chains[with_child]   // persona_with_job
 * const totalN    = digest.chains[total]        // persona_total
 * ```
 *
 * Returns `null` for chains not surfaced in the digest (only the five
 * persona/job/opportunity/hypothesis/experiment chains are computed).
 */
export function chainDigestKeys(
  chain: { from: string; to: string },
): { with_child: string; total: string } | null {
  const map: Record<string, { with_child: string; total: string }> = {
    'persona→job': { with_child: 'persona_with_job', total: 'persona_total' },
    'job→need': { with_child: 'job_with_need', total: 'job_total' },
    'opportunity→solution': { with_child: 'opportunity_with_solution', total: 'opportunity_total' },
    'hypothesis→experiment_plan': { with_child: 'hypothesis_untested', total: 'hypothesis_total' },
    'experiment_run→learning': { with_child: 'experiment_with_learning', total: 'experiment_total' },
  }
  return map[`${chain.from}→${chain.to}`] ?? null
}

// ── Type sort order (for tree rendering: group children by type) ─────────────
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

// ── Meaning-aware ordering ──────────────────────────────────────────────────
//
// The intra-type tiebreaker. A plain `title.localeCompare` orders a release
// series as `v5.1.0, v5.10.0, … v5.2.0` (lexical, not sequential). This ladder
// orders by MEANING, trying each rung in turn and returning the first that
// separates the pair:
//   1. an explicit order field (`<type>_order`, or order/sequence/position/...)
//   2. a semantic version detected in the title or a `version` property
//   3. the status's position in the type's lifecycle (state-machine order)
//   4. a provenance timestamp (`created_at` / `created`)
//   5. a numeric-aware locale compare of the title (so `v5.2.0` precedes
//      `v5.10.0` even with no other signal)
// Lives in the SDK so every surface that renders a node list (the CLI `list` /
// `tree`, get_tree child ordering, the cloud) shares one notion of order.

const ORDER_KEYS = ['order', 'sequence', 'position', 'rank', 'index', 'sort_order'] as const

/** An explicit numeric order from `<type>_order` or a generic order property. */
function orderValue(n: UPGBaseNode): number | undefined {
  const props = (n.properties ?? {}) as Record<string, unknown>
  const keys = [`${n.type}_order`, ...ORDER_KEYS]
  for (const k of keys) {
    const v = props[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return undefined
}

/** A semver [major, minor, patch] from the title or a `version` property. */
function semverKey(n: UPGBaseNode): [number, number, number] | undefined {
  const version = (n.properties as Record<string, unknown> | undefined)?.version
  const src = `${n.title} ${typeof version === 'string' ? version : ''}`
  const m = src.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return undefined
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
}

/** A millisecond timestamp from a provenance property. */
function timeValue(n: UPGBaseNode): number | undefined {
  const props = (n.properties ?? {}) as Record<string, unknown>
  const raw = props.created_at ?? props.created ?? (n as { created_at?: unknown }).created_at
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const t = Date.parse(raw)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

/**
 * Compare two nodes by meaning (the ladder above). Intended for nodes of the
 * same entity type, but safe across types: rungs that do not apply fall through.
 */
export function compareNodesWithinType(a: UPGBaseNode, b: UPGBaseNode): number {
  // 1. explicit order field
  const oa = orderValue(a)
  const ob = orderValue(b)
  if (oa !== undefined && ob !== undefined && oa !== ob) return oa - ob

  // 2. semantic version
  const va = semverKey(a)
  const vb = semverKey(b)
  if (va && vb) {
    for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] - vb[i]
  }

  // 3. lifecycle/status sequence
  if (a.status && b.status) {
    const lc = getLifecycleForType(a.type)
    if (lc) {
      const ia = lc.phases.findIndex((p) => p.id === a.status)
      const ib = lc.phases.findIndex((p) => p.id === b.status)
      if (ia >= 0 && ib >= 0 && ia !== ib) return ia - ib
    }
  }

  // 4. provenance time
  const ta = timeValue(a)
  const tb = timeValue(b)
  if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb

  // 5. numeric-aware locale fallback
  return a.title.localeCompare(b.title, undefined, { numeric: true })
}

/** Sort nodes by type priority, then by meaning (see compareNodesWithinType) within a type. */
export function sortByType(nodes: UPGBaseNode[]): UPGBaseNode[] {
  return [...nodes].sort((a, b) => {
    const priorityDiff = typeSortPriority(a.type) - typeSortPriority(b.type)
    if (priorityDiff !== 0) return priorityDiff
    return compareNodesWithinType(a, b)
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

/**
 * Batch-4 #22: coverage scored against a caller-chosen region set instead of
 * the product stage's default. Lets a deliberately-scoped product (e.g. a
 * structural spine) read its parity without GTM / pricing / business regions
 * dragging the headline down. Same per-region-pct-then-average math as
 * `CoverageStageSummary`, restricted to `regions`.
 */
export interface CoverageProfileSummary {
  /** The region ids that were scored (the intersection of the request and known regions). */
  regions: string[]
  regions_counted: number
  regions_complete: number
  regions_partial: number
  /** Whole-number percentage 0-100, averaged across the profile regions only. */
  overall_pct: number
  /** Requested ids that are not known coverage regions (ignored in the score). */
  unknown_regions?: string[]
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
   * `stage_summary` key; it carries a different shape.
   */
  coverage: Record<string, CoverageRegion> & {
    stage_summary?: CoverageStageSummary
    profile_summary?: CoverageProfileSummary
  }
  lifecycle: Record<string, number>
}

export function computeGraphDigest(
  store: UPGFileStore,
  opts?: { coverageProfile?: string[] },
): GraphDigest {
  const nodes = store.getAllNodes()
  const edges = store.getAllEdges()
  const product = store.getProduct()

  // Counts by type (raw; preserves the type as stored on the node)
  const byType: Record<string, number> = {}
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1

  // Counts by canonical type; legacy-typed nodes (e.g. `jtbd`) fold into
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

  // Health metrics: read from canonical counts so legacy types still flow through.
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
  // canonical names; a `jtbd` node connected via a `persona_pursues_jtbd`
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
  // personas: `job ← persona_pursues_job ← persona → persona_experiences_need
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
  // still match; `chainStats` runs source types through canonicalType().
  const hypExperiment = chainStats('hypothesis', 'experiment_plan')
  const expLearning = chainStats('experiment_run', 'learning')

  // Business area coverage: fold deprecated types into canonical via the spec
  const typeSet = new Set<string>()
  for (const t of Object.keys(byType)) {
    typeSet.add(t)
    typeSet.add(canonicalType(t))
  }
  // Stage-aware filtering (Finding 9 /). Resolve the product's stage
  // through the legacy-alias coercion path first, then read the list of
  // regions counted toward completeness for that stage. Per-region
  // `types_present` / `types_missing` are populated for ALL regions
  // regardless of stage; only `counted_toward_stage` and the
  // `stage_summary` aggregate distinguish counted from informational.
  // Node-first, header fallback ( §B): a product node's own stage is the
  // live value; the $upg.product.stage header can lag in legacy/desynced files.
  // update_node / update_product now write every carrier, so for fresh writes
  // they agree. Resolution order matches canonical.ts `effectiveRootProduct`
  // exactly — `properties.stage`, then `status`, then the header — because two
  // different precedence orders in one system is how the 2026-08-16 silent
  // stage no-op survived.
  //
  // Only the ROOT product node — the one whose id equals `product.id` — is
  // authoritative. A graph may hold other `type:'product'` nodes (portfolio
  // siblings, watched competitors, a decoy created by hand), and `find` by type
  // alone can return one of those. `status` in particular must never be read off
  // a non-root product node: `createNode` seeds a product's status with the
  // lifecycle's `initial_phase` (`concept`), so any unrelated product node in the
  // graph would silently drag a launch-stage product back to concept. The
  // by-type fallback is kept for `properties.stage` ALONE, preserving the exact
  // pre-0.30.1 behaviour for graphs whose product node was minted with an
  // unrelated id.
  const rootProductNode = nodes.find((n) => n.type === 'product' && n.id === product.id)
  const legacyProductNode = rootProductNode ?? nodes.find((n) => n.type === 'product')
  // `status` is only consulted when it IS a stage: a product node may legitimately
  // carry a non-stage status in a legacy graph, and coercing that to `concept`
  // would under-grade a product whose header knows better.
  const nodeStatusStage =
    typeof rootProductNode?.status === 'string' && coerceProductStage(rootProductNode.status).canonical
      ? rootProductNode.status
      : undefined
  const rawStage =
    ((legacyProductNode?.properties as Record<string, unknown> | undefined)?.stage as string | undefined) ??
    nodeStatusStage ??
    product.stage
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

  // Stage summary: overall_pct is the mean per-region coverage across only
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

  // Batch-4 #22: optional target-profile coverage. Re-average the headline over
  // a caller-chosen region set so an intentionally-scoped product reads its
  // parity without out-of-scope regions dragging it down. Same per-region-pct
  // then-average math as stage_summary.
  if (opts?.coverageProfile && opts.coverageProfile.length > 0) {
    const profileAreas: string[] = []
    const unknown: string[] = []
    for (const id of opts.coverageProfile) {
      if (id !== 'stage_summary' && id !== 'profile_summary' && id in coverage) profileAreas.push(id)
      else unknown.push(id)
    }
    const stats = profileAreas.map((id) => coverage[id] as CoverageRegion)
    const pComplete = stats.filter((s) => s.total > 0 && s.covered === s.total).length
    const pPartial = stats.filter((s) => s.covered > 0 && s.covered < s.total).length
    const pPcts = stats.map((s) => (s.total === 0 ? 100 : (s.covered / s.total) * 100))
    const pPct = pPcts.length === 0 ? 0 : Math.round(pPcts.reduce((a, b) => a + b, 0) / pPcts.length)
    coverage.profile_summary = {
      regions: profileAreas,
      regions_counted: profileAreas.length,
      regions_complete: pComplete,
      regions_partial: pPartial,
      overall_pct: pPct,
      ...(unknown.length > 0 ? { unknown_regions: unknown } : {}),
    }
  }

  // Lifecycle balance: count via canonical types so `hypothesis`
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
      // Same resolution as `rawStage` above — one order, one answer.
      stage: rawStage ?? 'unknown',
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
  // Filter out the special `stage_summary` key; it's an aggregate, not a
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

  // Meaning-aware order (type priority, then the within-type ladder: order
  // field / semver / lifecycle / time / numeric-locale) before paginating, so a
  // release series reads sequentially instead of `v5.1.0, v5.10.0, … v5.2.0`.
  nodes = sortByType(nodes)

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

/**
 * Count `product`-typed nodes already in the graph ( / DT-SIM-2).
 * Used to warn when a write would create a SECOND product node in one .upg.
 */
function countProductNodes(store: UPGFileStore): number {
  let n = 0
  for (const node of store.getAllNodes()) {
    if (node.type === 'product') n++
  }
  return n
}

export interface CreateNodeArgs {
  type: string
  title: string
  description?: string
  tags?: unknown
  status?: string
  properties?: Record<string, unknown>
  parent_id?: string
  /**
   * Caller-supplied citable key (e.g. `"LTN-311"`). Accepted here and REFUSED
   * on every update path, mirroring `graph-service`'s `assertKeyNotMutated`:
   * a key arrives at create or not at all.
   *
   * NEVER MINTED HERE. Deriving the next key is `max(existing) + 1` over every
   * keyed node in the product, which requires PAGED reads: PostgREST silently
   * caps `select()` at 1,000 rows, so an unpaged derivation computes `max` over
   * a truncated set and hands a live node a duplicate key with no error. That
   * paging lives in `packages/graph-service/src/keys.ts` and is the only code
   * that does it. A second minter is a duplicate-key generator, so this path
   * accepts a key and never invents one.
   *
   * `properties.key` IS DELIBERATELY UNGUARDED HERE, and the asymmetry with the
   * update paths is a decision rather than an oversight. On update the front
   * door is closed, so the side door is the only way through and a caller who
   * finds it has routed around a refusal. On create both doors are open, so a
   * key in `properties` is not a bypass, it is a duplicate. Refusing a duplicate
   * of something this path already accepts would be the surface saying no to a
   * caller who did nothing wrong. graph-service does not guard its create path
   * either, and mirroring it exactly cuts both ways.
   */
  key?: string
  /** Swept out of default views. Orthogonal to `status` (0.32.0 C3). */
  archived?: boolean
  /** ISO timestamp archived. Pairs with `archived === true`. */
  archived_at?: string
  /**
   * (Seam 1): authoring-time strictness. When true, unknown-property
   * WARNINGS are promoted to rejections (throws). Strict dimensions (type,
   * status) reject regardless. Same flag, same effect, on every write tool.
   */
  strict?: boolean
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
  // (Seam 1): ONE shared validation pass, identical for single + batch.
  // Posture: STRICT on type (unknown → throw UnknownEntityTypeError; alias →
  // warn) and status (must ∈ lifecycle phases → reject); PERMISSIVE on
  // properties (unknown keys → warn, store) unless `strict: true` promotes
  // them to rejections. Unknown types still throw `UnknownEntityTypeError` so
  // existing `instanceof` handlers keep working.
  if (args.type !== undefined) {
    try {
      resolveEntityType(args.type)
    } catch (err) {
      if (err instanceof UnknownEntityTypeError) throw err
      throw err
    }
  }
  const validation = validateNodeWrite(
    { type: args.type, status: args.status, properties: args.properties },
    { strict: args.strict },
  )
  if (validation.errors.length > 0) {
    throw new WriteValidationError(validation.errors)
  }
  const canonicalNodeType = validation.canonicalType
  const warnings = [...validation.warnings]

  // ── two-product guard ( / DT-SIM-2) ────────────────────────────────
  // A single .upg holds ONE product. Creating a second `product` node silently
  // pollutes the active graph (the user usually wanted product ISOLATION via
  // init_workspace + a separate file). We do not hard-reject (a multi-product
  // workspace legitimately creates products via createProduct, and we should
  // not break recovery paths), but we warn loudly so an unaware caller does not
  // orphan nodes into the wrong graph.
  if (canonicalNodeType === 'product' && countProductNodes(store) >= 1) {
    warnings.push(
      'A `product` node already exists in this .upg. A single graph models ONE product; ' +
        'this creates a SECOND product node in the active graph rather than an isolated product. ' +
        'For a separate product, run `init_workspace` then `create_product` (each product lives in its own .upg file).',
    )
  }

  const newNode: UPGBaseNode = {
    id: nodeId(),
    type: canonicalNodeType as UPGEntityType,
    title: args.title,
  }
  if (args.description) newNode.description = args.description
  if (args.tags) newNode.tags = normalizeTags(args.tags) ?? []
  if (args.properties) newNode.properties = args.properties
  if (args.key !== undefined) newNode.key = args.key
  if (args.archived !== undefined) newNode.archived = args.archived
  if (args.archived_at !== undefined) newNode.archived_at = args.archived_at
  autoFillSlug(newNode, store)

  // Status: validated above (reject on invalid). Apply or default.
  if (args.status) {
    newNode.status = args.status
  } else {
    const defaultStatus = getDefaultStatus(canonicalNodeType)
    if (defaultStatus) newNode.status = defaultStatus
  }

  let warning: string | undefined = warnings.length > 0 ? warnings.join(' | ') : undefined

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
    const inference = inferEdgeTypeWithTier(parent.type, canonicalNodeType, { forAutoNest: true })
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
          `Parent edge not created; no canonical edge for ${parent.type} → ${canonicalNodeType}.${suggestion}`,
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
  /** Target node id. Prefer this; the title/type pair is a convenience lookup. */
  target_id?: string
  /**
   * (S-11): LOOK UP an EXISTING node by title (does NOT create one).
   * Combined with `target_type`, resolves to a single existing node of that
   * type whose title matches (case-insensitive). Errors `No <type> found with
   * title "<x>"` when absent, or an ambiguity error when > 1 match — pass
   * `target_id` to disambiguate. This is resolve-on-connect, not
   * create-on-connect.
   */
  target_title?: string
  /** Required with `target_title`: the entity type to look the title up within. */
  target_type?: string
  /** Explicit canonical edge type. Omit to infer from (source.type → target.type). */
  type?: string
  /**
   * Edge-scoped properties. Permitted ONLY on edge types whose catalog
   * definition sets `carries_properties` (currently
   * `framework_exercise_includes_node`); rejected on any other edge. Used to
   * store a framework exercise's per-entity result on the includes edge.
   */
  properties?: Record<string, unknown>
}

export type CreateEdgeResult =
  | { edge: UPGEdge; warning?: string }
  | {
      error: string
      /**
       * Source/target types when the failure is a "no canonical edge"
       * resolver miss; surfaced so the MCP handler can attach
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
    // User-supplied edge type. (Seam 1): STRICT — the type must be in
    // UPG_EDGE_CATALOG *and* match the catalog's declared source/target pair.
    // This matches what batch `edges[]` already enforced; single create_edge
    // previously skipped catalog-membership and silently accepted any string
    // (the master single↔batch inconsistency). One shared validator now.
    const typeCheck = validateExplicitEdgeType(args.type, source.type as string, target.type as string)
    if (typeCheck.errors.length > 0) {
      return { error: typeCheck.errors.join(' ') }
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

  // Gated edge properties: only edge types that opt in (carries_properties) may
  // carry a payload. Reject otherwise — keeps plain semantic edges pure, so the
  // only place an exercise's per-entity value can live is the includes edge.
  const hasProps = args.properties !== undefined && Object.keys(args.properties).length > 0
  if (hasProps && !edgeCarriesProperties(edgeType)) {
    return {
      error:
        `Edge type "${edgeType}" does not carry properties. Only edges declared ` +
        `with carries_properties (currently framework_exercise_includes_node) may ` +
        `hold a payload: a value that belongs to the relationship, not the endpoints.`,
    }
  }

  const edge: UPGEdge = {
    id: edgeId(),
    source: args.source_id,
    target: targetId!,
    type: edgeType,
    ...(hasProps ? { properties: args.properties } : {}),
  }

  //: addEdge is idempotent on (source, target, type). On a duplicate it
  // returns the EXISTING edge (not the fresh `edge` we minted above), so we
  // report the id that actually lives in the graph. Re-running `connect P J`
  // therefore returns the same edge id every time instead of appending dupes.
  const stored = store.addEdge(edge)
  const response: { edge: UPGEdge; warning?: string } = { edge: stored }
  if (edgeWarning) response.warning = edgeWarning
  return response
}

// ── Scalar → edge promotions (P14 conformance) ───────────────────────────────
//
// The graph-level apply ENGINE for `UPG_SCALAR_TO_EDGE_MIGRATIONS` (declared in
// `@unified-product-graph/core`). For each rule it walks every `from_type` node
// carrying the scalar, find-or-creates the referenced `target_type` entity by
// normalized title, links it with the canonical edge (orientation per `reverse`),
// and drops the now-redundant scalar (unless it's a kept actor display-cache).
//
// Lossless (Path B): the scalar's value becomes/links a real node — nothing is
// discarded. Idempotent: `addEdge` dedups on (source,target,type) and the title
// index prevents minting a duplicate target, so re-running is a no-op. The caller
// should snapshot the .upg first (reversible-by-snapshot).

/** Normalized title key for find-or-create dedup (lowercase, trimmed, ws-collapsed). */
function normalizeTitleKey(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ')
}

/** Per-rule application summary. */
export interface ScalarToEdgePerRule {
  from_type: string
  scalar_property: string
  edge_type: string
  /** Target nodes newly minted by this rule. */
  minted: Array<{ id: string; title: string; type: string }>
  /** Edges created or already present (source → target after orientation). */
  linked: Array<{ source: string; target: string; type: string }>
  /** Source node ids whose scalar was dropped. */
  dropped_from: string[]
  /** Values that could not be promoted, with the reason. */
  skipped: Array<{ node_id: string; value: string; reason: string }>
}

export interface ApplyScalarToEdgeResult {
  rules_applied: number
  per_rule: ScalarToEdgePerRule[]
  total_minted: number
  total_linked: number
  total_dropped: number
}

/**
 * Apply every scalar→edge promotion between two versions to the store's graph.
 * Mirrors `UPGFileStore.applyPropertyMigrations` but graph-level (mints + links).
 *
 * @example
 * applyScalarToEdgeMigrations(store, '0.11.6', '0.12.0')
 * // business_model{north_star_metric:"Weekly active editors"}
 * //   → metric{title:"Weekly active editors", designation:"north_star"}
 * //   + business_model_guided_by_metric edge; scalar dropped.
 */
export function applyScalarToEdgeMigrations(
  store: UPGFileStore,
  fromVersion: string,
  toVersion: string,
  opts: { dryRun?: boolean } = {},
): ApplyScalarToEdgeResult {
  return applyScalarToEdgeRules(store, getScalarToEdgeMigrations(fromVersion, toVersion), opts)
}

/**
 * Apply an explicit list of scalar→edge rules (the version-agnostic engine that
 * `applyScalarToEdgeMigrations` delegates to). Exposed for targeted testing of
 * orientation / multi / find-or-create branches with synthetic rules.
 *
 * `dryRun` previews the full plan (what would be minted/linked/dropped) without
 * mutating the store — the same shape the real pass returns.
 */
export function applyScalarToEdgeRules(
  store: UPGFileStore,
  rules: readonly import('@unified-product-graph/core').UPGScalarToEdgeMigration[],
  opts: { dryRun?: boolean } = {},
): ApplyScalarToEdgeResult {
  const dryRun = opts.dryRun ?? false
  const per_rule: ScalarToEdgePerRule[] = []

  // Existing-edge presence (for idempotency accounting in BOTH modes).
  const edgeKey = (s: string, t: string, ty: string) => `${s} ${t} ${ty}`
  const existingEdges = new Set(store.getAllEdges().map((e) => edgeKey(e.source, e.target, e.type)))
  let dryMintCounter = 0

  for (const rule of rules) {
    const summary: ScalarToEdgePerRule = {
      from_type: rule.from_type,
      scalar_property: rule.scalar_property,
      edge_type: rule.edge_type,
      minted: [],
      linked: [],
      dropped_from: [],
      skipped: [],
    }
    const matchBy = rule.target_match ?? 'title'

    // Index existing target_type nodes for find-or-create (title mode).
    // Value is `{ id, minted }` so dry-run can type a previewed mint correctly.
    const titleIndex = new Map<string, { id: string; minted: boolean }>()
    if (matchBy === 'title') {
      for (const n of store.getAllNodes()) {
        if (n.type === rule.target_type) {
          const key = normalizeTitleKey(n.title)
          if (!titleIndex.has(key)) titleIndex.set(key, { id: n.id, minted: false })
        }
      }
    }

    // Snapshot from_type nodes up-front; we mutate the graph as we go.
    const sources = store.getAllNodes().filter((n) => n.type === rule.from_type)

    for (const src of sources) {
      const raw = rule.top_level
        ? (src as unknown as Record<string, unknown>)[rule.scalar_property]
        : src.properties?.[rule.scalar_property]
      if (raw === undefined || raw === null) continue
      const values = rule.multi && Array.isArray(raw) ? raw : [raw]

      let resolvedAll = true
      for (const v of values) {
        const value = typeof v === 'string' ? v : String(v)
        if (!value.trim()) {
          summary.skipped.push({ node_id: src.id, value, reason: 'blank' })
          resolvedAll = false
          continue
        }

        // Resolve target id (find-or-create). `mintedNow` lets dry-run type it.
        let targetId: string | undefined
        let targetType = rule.target_type
        let mintedNow = false
        if (matchBy === 'id') {
          const found = store.getNode(value)
          if (!found) {
            summary.skipped.push({ node_id: src.id, value, reason: 'id not found' })
            resolvedAll = false
            continue
          }
          targetId = value
          targetType = found.type
        } else {
          const key = normalizeTitleKey(value)
          const hit = titleIndex.get(key)
          if (hit) {
            targetId = hit.id
            mintedNow = false
          } else if (dryRun) {
            targetId = `dry_mint_${dryMintCounter++}`
            titleIndex.set(key, { id: targetId, minted: true })
            summary.minted.push({ id: targetId, title: value, type: rule.target_type })
            mintedNow = true
          } else {
            const created = createNode(store, {
              type: rule.target_type,
              title: value,
              properties: rule.target_defaults ? { ...rule.target_defaults } : undefined,
            })
            targetId = created.node.id
            titleIndex.set(key, { id: targetId, minted: true })
            summary.minted.push({ id: targetId, title: value, type: rule.target_type })
            mintedNow = true
          }
        }

        // Orientation: default from→target; reverse means target→from.
        const edgeSource = rule.reverse ? targetId : src.id
        const edgeTarget = rule.reverse ? src.id : targetId
        if (edgeSource === edgeTarget) {
          summary.skipped.push({ node_id: src.id, value, reason: 'self-loop' })
          resolvedAll = false
          continue
        }
        // Self-protect against a mis-authored rule (e.g. wrong `reverse`).
        // Types come from known info so the check works for previewed mints too.
        const srcType = rule.reverse ? targetType : src.type
        const tgtType = rule.reverse ? src.type : targetType
        const check = validateExplicitEdgeType(rule.edge_type, srcType as string, tgtType as string)
        if (check.errors.length > 0) {
          summary.skipped.push({ node_id: src.id, value, reason: check.errors.join(' ') })
          resolvedAll = false
          continue
        }

        // Link (idempotent on the triple). A previewed mint is always a new edge.
        const k = edgeKey(edgeSource, edgeTarget, rule.edge_type)
        if (!mintedNow && existingEdges.has(k)) continue // already linked — no-op
        if (dryRun) {
          summary.linked.push({ source: edgeSource, target: edgeTarget, type: rule.edge_type })
        } else {
          const stored = store.addEdge({ id: edgeId(), source: edgeSource, target: edgeTarget, type: rule.edge_type as UPGEdgeType })
          summary.linked.push({ source: stored.source, target: stored.target, type: stored.type })
        }
        existingEdges.add(k)
      }

      // Drop the scalar once every value resolved (orphans + shadows; kept for
      // actor display-caches). Only drop when the scalar is fully promoted.
      if (rule.drop_scalar && resolvedAll && raw !== undefined) {
        if (!dryRun) {
          if (rule.top_level) {
            delete (src as unknown as Record<string, unknown>)[rule.scalar_property]
          } else {
            store.unsetNodeProperties(src.id, [rule.scalar_property])
          }
        }
        summary.dropped_from.push(src.id)
      }
    }
    per_rule.push(summary)
  }

  return {
    rules_applied: rules.length,
    per_rule,
    total_minted: per_rule.reduce((a, r) => a + r.minted.length, 0),
    total_linked: per_rule.reduce((a, r) => a + r.linked.length, 0),
    total_dropped: per_rule.reduce((a, r) => a + r.dropped_from.length, 0),
  }
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
      /** Removed edge object; exposed for caller-driven rollback (e.g. batch). */
      removed_edge?: UPGEdge
      warning?: string
    }
  | { moved: false; error: string }

/**
 * Find the existing parent edge(s) for a node: edges where the node is
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
    const inference = inferEdgeTypeWithTier(newParent.type, node.type, { forAutoNest: true })
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
  // addEdge throws (target/source missing; should not happen given checks
  // above), rollback by restoring the old edge.
  if (oldEdge) {
    store.removeEdge(oldEdge.id)
  }
  //: capture the stored edge — on the rare dedup hit (a same-triple edge
  // already existed under a different parent path), report the real one.
  let storedEdge: UPGEdge
  try {
    storedEdge = store.addEdge(newEdge)
  } catch (err) {
    if (oldEdge) {
      // Restore: skipValidation because the old edge was already in the
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
    new_edge: storedEdge,
    removed_edge_id: oldEdge?.id ?? null,
    ...(oldEdge ? { removed_edge: oldEdge } : {}),
    ...(aliasWarning ? { warning: aliasWarning } : {}),
  }
}

// ── batch_move_nodes: atomic, all-or-nothing (cap 50) ───────────────────────

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
      const inference = inferEdgeTypeWithTier(parent.type, node.type, { forAutoNest: true })
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
      // Roll back already-applied moves in reverse order: restore the
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
          } catch { /* duplicate id; graph diverged, surface but continue */ }
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
  /**
   * Caller-supplied citable key. Same posture as `createNode`: accepted on
   * create, refused on every update, and NEVER minted here. The minter stays in
   * `packages/graph-service/src/keys.ts` because `max(existing) + 1` needs
   * paged reads (PostgREST caps `select()` at 1,000 rows silently) and a second
   * unpaged minter is a duplicate-key generator.
   */
  key?: string
  /** Swept out of default views. Orthogonal to `status` (0.32.0 C3). */
  archived?: boolean
  /** ISO timestamp archived. Pairs with `archived === true`. */
  archived_at?: string
  /**: per-node strictness — promote unknown-property warnings to a batch rejection. */
  strict?: boolean
  /**
   * Batch-4 #16: a batch-local alias for this node, referenceable by
   * `parent_ref` and by `edges[].from_ref` / `to_ref` instead of a positional
   * `$N`. Removes the index-counting that was the #1 cause of failed batches.
   * Aliases must be unique within the batch and must not look like a positional
   * ref (`$0`, `$1`, ...).
   */
  ref?: string
}

export interface BatchEdgeInput {
  from_ref: string
  to_ref: string
  type?: string
}

export interface BatchCreateArgs {
  nodes: BatchNodeInput[]
  edges?: BatchEdgeInput[]
  /**
   * Batch-4 #15: dry-run. Run the FULL validation pass (types, status, refs,
   * edge directions/pairs) and report every would-be error WITHOUT writing, so
   * an agent can self-correct a whole batch before committing instead of losing
   * it to the first bad item.
   */
  validateOnly?: boolean
}

export interface BatchCreateOk {
  ok: true
  /**
   * The created nodes. `properties` is echoed (0.40.0) so a caller can key the
   * results by whatever it wrote — the field case keyed 163 design tokens by
   * `css_variable` and had to RE-READ THE FILE to do it, because the response
   * carried only id/type/title. Echoing what the caller just sent costs nothing
   * and removes a whole read from the documented batch workflow.
   */
  created: Array<{ id: string; type: string; title: string; status?: string; properties?: Record<string, unknown> }>
  edges: UPGEdge[]
  explicit_edges?: UPGEdge[]
  count: number
  /**
   * Alias/positional ref resolutions (0.40.0 on the SUCCESS path; it was already
   * emitted on dry-run and on failure). Without it a caller that chained by
   * `ref` had no way to map its own tokens onto the returned ids except by
   * re-reading, which is the same round trip `properties` above removes.
   */
  ref_map?: BatchRefMapEntry[]
  warnings?: string[]
}

/**
 * Batch-4 #16: a resolved alias/positional ref, echoed on dry-run, on failure,
 * and (0.40.0) on success, so the author can see what each token maps to —
 * whether debugging a mis-count or mapping chained refs onto created ids.
 */
export interface BatchRefMapEntry {
  token: string
  index: number
  type: string
  title: string
}

/** Batch-4 #15: dry-run result. No mutation occurred. */
export interface BatchValidateResult {
  ok: true
  validate_only: true
  valid: boolean
  errors: string[]
  would_create_nodes: number
  would_create_edges: number
  ref_map?: BatchRefMapEntry[]
  warnings?: string[]
}

export interface BatchCreateFail {
  ok: false
  error: string
  /** Batch-4 #15: every validation error found (error === errors[0]). Present only when more than one fired. */
  errors?: string[]
  /** Batch-4 #16: declared alias → {index, type, title} map, to debug a ref mis-count. */
  ref_map?: BatchRefMapEntry[]
}

export type BatchCreateResult = BatchCreateOk | BatchCreateFail | BatchValidateResult

/**
 * Atomic batch creation: nodes plus optional explicit edges in a single
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
 *
 * Batch-4 #15 (`validateOnly`): run the full validation pass and return a
 * `BatchValidateResult` (`valid`, the complete `errors` list, would-be counts)
 * WITHOUT touching the graph — for self-correcting a batch before committing.
 * Batch-4 #16: a node may declare a batch-local `ref` alias, usable from
 * `parent_ref` / `edges[].from_ref` / `to_ref` in place of a positional `$N`;
 * stray `$`-prefixed tokens that resolve to nothing are now rejected, not
 * silently treated as node ids. Failures echo the alias `ref_map`.
 */
export function batchCreateNodes(
  store: UPGFileStore,
  args: BatchCreateArgs,
): BatchCreateResult {
  const { nodes, edges: explicitEdges = [], validateOnly = false } = args
  if (!Array.isArray(nodes)) return { ok: false, error: 'Missing required parameter: nodes (array)' }
  if (nodes.length === 0) return { ok: false, error: 'nodes array is empty' }
  if (nodes.length > 50) return { ok: false, error: 'Maximum 50 nodes per batch' }
  if (nodes.length + explicitEdges.length > 50) {
    return { ok: false, error: `Maximum 50 items per batch (got ${nodes.length} nodes + ${explicitEdges.length} edges)` }
  }

  // Batch-4 #15: errors accumulate across the whole batch instead of returning
  // on the first, so a dry-run (or a failed commit) reports the full fix list.
  const errors: string[] = []

  // ── Pass 0: collect ref aliases (Batch-4 #16) ───────────────────────────
  // Aliases are batch-local names a node declares via `ref`, usable in place of
  // positional `$N` from parent_ref / edges. Built first so an edge may target
  // any aliased node regardless of declaration order.
  const aliasToIndex = new Map<string, number>()
  for (let i = 0; i < nodes.length; i++) {
    const ref = nodes[i].ref
    if (ref === undefined) continue
    if (typeof ref !== 'string' || ref.length === 0) {
      errors.push(`Node at index ${i}: "ref" must be a non-empty string`)
      continue
    }
    if (/^\$\d+$/.test(ref)) {
      errors.push(`Node at index ${i}: "ref" alias "${ref}" must not look like a positional $N ref`)
      continue
    }
    const prior = aliasToIndex.get(ref)
    if (prior !== undefined) {
      errors.push(`Node at index ${i}: duplicate ref alias "${ref}" (already declared at index ${prior})`)
      continue
    }
    aliasToIndex.set(ref, i)
  }

  // Resolve a parent_ref token to an earlier node index. Accepts a positional
  // `$N` or a declared `ref` alias; NOT an existing graph id (use parent_id).
  const resolveParentRef = (raw: string, i: number): { index: number } | { error: string } => {
    const m = raw.match(/^\$(\d+)$/)
    if (m) {
      const idx = parseInt(m[1], 10)
      if (idx >= i) return { error: `Node at index ${i}: parent_ref "${raw}" must reference an earlier index (0–${i - 1})` }
      return { index: idx }
    }
    const aliasIdx = aliasToIndex.get(raw)
    if (aliasIdx !== undefined) {
      if (aliasIdx >= i) return { error: `Node at index ${i}: parent_ref alias "${raw}" must reference a node declared earlier in this batch` }
      return { index: aliasIdx }
    }
    if (raw.startsWith('$')) {
      return { error: `Node at index ${i}: parent_ref "${raw}" looks like a positional ref but is not "$0".."$${i - 1}"; use a valid index or a declared ref alias.` }
    }
    return { error: `Node at index ${i}: invalid parent_ref "${raw}"; use "$0"/"$1" (positional) or a ref alias declared earlier. For an existing graph node, pass parent_id instead.` }
  }

  // ── Validation pass (accumulating, side-effect-free) ─────────────────────
  // (Seam 1): identical posture to single createNode. STRICT on type
  // (unknown → reject) and status (invalid → reject); PERMISSIVE on properties
  // (unknown keys → warning), promoted to a rejection by per-node `strict`.
  // `resolvedTypes` stays index-aligned (sentinel '' for an invalid node) so
  // edge refs still resolve; `parentIndexOf` caches the resolved parent index
  // for the apply pass.
  const resolvedTypes: string[] = []
  const parentIndexOf: Array<number | null> = []
  const aliasWarnings: string[] = []
  /** Keys claimed by EARLIER entries of this batch: key → index. */
  const batchKeys = new Map<string, number>()
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    parentIndexOf.push(null)
    if (!n.type) { errors.push(`Node at index ${i}: missing required field "type"`); resolvedTypes.push(''); continue }
    if (!n.title) { errors.push(`Node at index ${i}: missing required field "title"`); resolvedTypes.push(''); continue }
    const validation = validateNodeWrite(
      { type: n.type, status: n.status, properties: n.properties },
      { strict: n.strict },
    )
    if (validation.errors.length > 0) {
      errors.push(`Node at index ${i}: ${validation.errors.join(' ')}`)
      resolvedTypes.push('')
    } else {
      resolvedTypes.push(validation.canonicalType)
      for (const w of validation.warnings) aliasWarnings.push(`Node at index ${i}: ${w}`)
    }
    if (n.parent_ref !== undefined) {
      const pr = resolveParentRef(n.parent_ref, i)
      if ('error' in pr) errors.push(pr.error)
      else parentIndexOf[i] = pr.index
    }
    if (n.parent_id !== undefined && !store.getNode(n.parent_id)) {
      errors.push(`Node at index ${i}: parent_id "${n.parent_id}" not found in graph`)
    }
    // Within-product key uniqueness, checked UP FRONT so the caller gets every
    // collision in one `errors` list rather than one per rolled-back attempt.
    // `addNode` refuses the same thing at the store; this is the batch's
    // promise that nothing is even attempted, not a second source of truth.
    if (n.key !== undefined) {
      const holder = store.getNodeByKey(n.key)
      if (holder) {
        errors.push(
          `Node at index ${i}: key "${n.key}" is already held by node ${holder.id} ("${holder.title}"). ` +
            `A key identifies one node within a product across entity types and is never reused.`,
        )
      } else {
        // Two entries of THIS batch naming one key. Nothing on disk holds it,
        // so only the batch can see this collision.
        const twin = batchKeys.get(n.key)
        if (twin !== undefined) {
          errors.push(
            `Node at index ${i}: key "${n.key}" is already claimed by node at index ${twin} in this batch.`,
          )
        } else {
          batchKeys.set(n.key, i)
        }
      }
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
        return { error: `Edge at index ${edgeIndex}: ${label} "${raw}" out of range; only ${nodes.length} nodes in this batch (valid $0–$${nodes.length - 1}).` }
      }
      return { kind: 'ref', index: idx }
    }
    const aliasIdx = aliasToIndex.get(raw)
    if (aliasIdx !== undefined) return { kind: 'ref', index: aliasIdx }
    // Batch-4 #16: a stray `$`-prefixed token that is neither a valid $N nor a
    // declared alias was previously treated as a node id and surfaced a vague
    // "not found"; reject it explicitly so the mis-typed ref is obvious.
    if (raw.startsWith('$')) {
      return { error: `Edge at index ${edgeIndex}: ${label} "${raw}" looks like a positional ref but is not "$0".."$${nodes.length - 1}", and is not a declared ref alias.` }
    }
    if (!store.getNode(raw)) {
      return { error: `Edge at index ${edgeIndex}: ${label} "${raw}" not found in graph (and is not a $N ref or ref alias into this batch).` }
    }
    return { kind: 'id', id: raw }
  }
  const refType = (ref: ResolvedEdgeRef): string =>
    ref.kind === 'ref' ? resolvedTypes[ref.index] : (store.getNode(ref.id)?.type ?? '')

  for (let i = 0; i < explicitEdges.length; i++) {
    const e = explicitEdges[i]
    const fromResolved = resolveEdgeRef(e.from_ref, 'from_ref', i)
    if ('error' in fromResolved) { errors.push(fromResolved.error); continue }
    const toResolved = resolveEdgeRef(e.to_ref, 'to_ref', i)
    if ('error' in toResolved) { errors.push(toResolved.error); continue }

    // Self-loop refusal: both sides resolve to the same ref OR the same
    // pre-existing node id. No canonical UPG edge type is self-referential.
    // F2 (2026-05-20).
    const sameRef =
      fromResolved.kind === 'ref' && toResolved.kind === 'ref' && fromResolved.index === toResolved.index
    const sameId =
      fromResolved.kind === 'id' && toResolved.kind === 'id' && fromResolved.id === toResolved.id
    if (sameRef || sameId) {
      errors.push(`Edge at index ${i}: self-loop refused; source and target resolve to the same node. No canonical UPG edge type is self-referential.`)
      continue
    }

    const sourceType = refType(fromResolved)
    const targetType = refType(toResolved)
    // Skip the type/pair check when an endpoint references a node that itself
    // failed validation (sentinel ''); its real error is already recorded and a
    // secondary "no edge for '' → x" would only be noise.
    if (sourceType === '' || targetType === '') {
      validatedEdges.push({ from: fromResolved, to: toResolved })
      continue
    }

    let typeOverride: UPGEdgeType | undefined
    if (e.type !== undefined) {
      if (!UPG_EDGE_CATALOG[e.type as UPGEdgeType]) {
        errors.push(`Edge at index ${i}: type "${e.type}" not in UPG_EDGE_CATALOG.`)
        continue
      }
      // Catalog pair validation against the resolved source/target types.
      // F1 (2026-05-20).
      const pairCheck = validateEdgeTypePair(e.type, sourceType, targetType)
      if (!pairCheck.valid) { errors.push(`Edge at index ${i}: ${pairCheck.reason}`); continue }
      typeOverride = e.type as UPGEdgeType
    } else {
      const inference = inferEdgeTypeWithTier(sourceType, targetType)
      if (!inference.ok) {
        const suggestion = inference.suggestions.length > 0
          ? ` Suggestions: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
          : ''
        errors.push(`Edge at index ${i}: no canonical edge for ${sourceType} → ${targetType}.${suggestion} Pass an explicit \`type\` to override.`)
        continue
      }
    }
    validatedEdges.push({ from: fromResolved, to: toResolved, typeOverride })
  }

  // Build the declared-alias → {index, type, title} map echoed on dry-run and
  // failure (Batch-4 #16). Positional `$N` refs are implicit and omitted.
  const buildRefMap = (): BatchRefMapEntry[] => {
    const out: BatchRefMapEntry[] = []
    for (const [token, index] of aliasToIndex) {
      out.push({
        token,
        index,
        type: resolvedTypes[index] || nodes[index]?.type || '',
        title: nodes[index]?.title ?? '',
      })
    }
    return out
  }

  // ── Dry-run (Batch-4 #15): report, never write ───────────────────────────
  if (validateOnly) {
    const parentLinks =
      parentIndexOf.filter((p) => p !== null).length +
      nodes.filter((n) => n.parent_id !== undefined && store.getNode(n.parent_id)).length
    const refMap = buildRefMap()
    const dryResult: BatchValidateResult = {
      ok: true,
      validate_only: true,
      valid: errors.length === 0,
      errors,
      would_create_nodes: nodes.length,
      would_create_edges: validatedEdges.length + parentLinks,
    }
    if (refMap.length > 0) dryResult.ref_map = refMap
    if (aliasWarnings.length > 0) dryResult.warnings = aliasWarnings
    return dryResult
  }

  if (errors.length > 0) {
    const refMap = buildRefMap()
    const fail: BatchCreateFail = { ok: false, error: errors[0] }
    if (errors.length > 1) fail.errors = errors
    if (refMap.length > 0) fail.ref_map = refMap
    return fail
  }

  // ── Apply pass with full rollback ───────────────────────────────────────
  const createdNodes: Array<{ id: string; type: string; title: string; status?: string; properties?: Record<string, unknown> }> = []
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
      if (n.key !== undefined) newNode.key = n.key
      if (n.archived !== undefined) newNode.archived = n.archived
      if (n.archived_at !== undefined) newNode.archived_at = n.archived_at

      // Status validated in the validation pass above (invalid → batch
      // rejected). Apply the caller's status or default to initial_phase.
      if (n.status) {
        newNode.status = n.status
      } else {
        const ds = getDefaultStatus(newNode.type)
        if (ds) newNode.status = ds
      }

      autoFillSlug(newNode, store)
      store.addNode(newNode)
      // `properties` echoed (0.40.0) so a caller can key results by what it wrote
    // instead of re-reading the file; omitted when empty so the common case
    // stays as small on the wire as it was.
    const echoed: { id: string; type: string; title: string; status?: string; properties?: Record<string, unknown> } =
      { id: newNode.id, type: newNode.type, title: newNode.title, status: newNode.status }
    if (newNode.properties && Object.keys(newNode.properties).length > 0) {
      echoed.properties = newNode.properties as Record<string, unknown>
    }
    createdNodes.push(echoed)
      createdNodeRefs.push(newNode)

      let parentId = n.parent_id
      // Batch-4 #16: parent_ref (positional $N or a declared alias) was resolved
      // to an earlier node index during validation; map it to the created id.
      const pIdx = parentIndexOf[i]
      if (pIdx !== null) {
        parentId = createdNodes[pIdx].id
      }
      if (parentId) {
        const parent = store.getNode(parentId)
        if (parent) {
          const inference = inferEdgeTypeWithTier(parent.type, newNode.type, { forAutoNest: true })
          if (inference.ok) {
            const edge: UPGEdge = { id: edgeId(), source: parentId, target: newNode.id, type: inference.edgeType }
            //: report the stored edge (existing on a dedup hit; new node
            // ids never collide here, but stay truthful).
            createdParentEdges.push(store.addEdge(edge))
          } else {
            const suggestion = inference.suggestions.length > 0
              ? ` Suggestions: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
              : ''
            warnings.push(
              `Node "${newNode.title}": parent edge not created; no canonical edge for ${parent.type} → ${newNode.type}.${suggestion}`,
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
      //: explicit edges[] can connect PRE-EXISTING nodes, so a duplicate
      // triple is genuinely possible. Report the stored edge (existing on a dedup
      // hit) so batch_create_edges is idempotent like single create_edge.
      explicitCreated.push(store.addEdge(newEdge))
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
      `Created ${createdNodes.length} nodes with no edges; they are orphans. ` +
        `Use the edges[] array in this call to link them. ` +
        `See get_entity_schema(<type>) for canonical edges per type.`,
    )
  }

  const successRefMap = buildRefMap()
  const result: BatchCreateOk = {
    ok: true,
    created: createdNodes,
    edges: createdParentEdges,
    count: createdNodes.length,
  }
  if (successRefMap.length > 0) result.ref_map = successRefMap
  if (explicitCreated.length > 0) result.explicit_edges = explicitCreated
  if (warnings.length > 0) result.warnings = warnings
  return result
}

// ── migrate_node_type: single-node type change ────────────────────

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

  // Resolve new type (alias-aware). Unknown types throw, caught here
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
        error: `Edge ${e.id} references a missing node; fix graph integrity before migrating.`,
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
    } catch { /* node already gone; graph diverged, surface the original */ }
    for (const r of removed.slice().reverse()) {
      try { store.addEdge(r, true) } catch { /* duplicate id; surface the original */ }
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

/**
 * §B (hardened 0.30.1): keep a product's stage SINGLE-VALUED across all
 * three of its carriers, so no reader can disagree with any other.
 *
 * A product's stage lives on the `type:'product'` node — in `properties.stage`
 * (the spec's declared carrier; the `properties.stage → status` lift was
 * deliberately retired in 0.9.10 #33 because product stage is its own 9-phase
 * axis) and in `status` (the grammar's product-lifecycle phase, the same axis) —
 * and is PROJECTED into `$upg.product.stage`, which `get_graph_digest` reads and
 * which canonical.ts `effectiveRootProduct` re-derives from the node on every
 * serialize. The node is authoritative; the header is its projection.
 *
 * Precedence is **"the carrier the caller just wrote wins"**: a caller passing
 * `status: "growth"` means growth, even when a stale `properties.stage` sits
 * beside it. The old block preferred `properties.stage` unconditionally, which
 * both clobbered such a write and left the two node carriers disagreeing — and
 * since the serialiser then overlaid `status` back over the header, an
 * `update_node(product, { properties: { stage } })` was a SILENT no-op on disk:
 * the same defect `updateProduct({ stage })` carried (found 2026-08-16, Geordi).
 * Writing the resolved value to every carrier removes the class — there is
 * nothing left to disagree.
 *
 * Sibling carriers are written ONLY when the call actually wrote a stage
 * carrier. An unrelated edit (a title change) must not resurrect a carrier the
 * graph does not have, and an explicit `unset_properties: ['stage']` must stay
 * unset; both would be a write the caller never asked for. The header sync runs
 * either way, as it always has. Callers have already scheduled a save, so these
 * mutations ride the same flush.
 */
function reconcileProductStageCarriers(
  store: UPGFileStore,
  node: UPGBaseNode,
  written: {
    patchedProperties?: Record<string, unknown>
    patchedStatus?: string
    unsetProperties?: string[]
  },
): void {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const patchedProp = written.patchedProperties?.stage
  const nodeProp = (node.properties as Record<string, unknown> | undefined)?.stage
  const candidate = str(patchedProp) ?? str(written.patchedStatus) ?? str(nodeProp) ?? str(node.status)
  if (candidate === undefined || validateProductStageStrict(candidate) !== null) return

  const header = store.getProduct() as { stage?: string } | undefined
  if (header && header.stage !== candidate) header.stage = candidate

  const unsetStage = written.unsetProperties?.includes('stage') === true
  const wroteStageCarrier = patchedProp !== undefined || written.patchedStatus !== undefined
  if (!wroteStageCarrier || unsetStage) return
  if (node.status !== candidate) node.status = candidate
  if (nodeProp !== candidate) node.properties = { ...(node.properties ?? {}), stage: candidate }
}

// ── update_node ( unified validation + property unset) ─────────

/**
 * Thrown when a caller tries to set or change a node key through an update.
 *
 * A minted key is immutable by contract and never reused, so there is no update
 * that legitimately carries one: a key arrives at create or not at all.
 * Refusing rather than ignoring matters because a silently dropped `key` in an
 * update patch looks to the caller exactly like a successful rename, and a form
 * that appears to work and does not is worse than one that says no.
 *
 * Mirrors `KeyImmutableError` in `packages/graph-service/src/keys.ts`. Two write
 * paths over one store must not be tellable apart by which one lets a rename
 * through.
 */
export class NodeKeyImmutableError extends Error {
  constructor(readonly nodeId: string) {
    super(
      `Node key is immutable and cannot be set or changed through an update (node ${nodeId}). ` +
        `Keys are minted once, on create, and are never reused. ` +
        `Pass "key" to create_node or batch_create_nodes instead. See UPG 0.32.0 C1.`,
    )
    this.name = 'NodeKeyImmutableError'
  }
}

/** The shape every update door is checked against: both ways a key can arrive. */
export interface NodeKeyMutationCheck {
  key?: unknown
  properties?: Record<string, unknown> | null
}

/**
 * Both doors a key can come through, checked once.
 *
 * TWO DOORS, deliberately, mirroring `assertKeyNotMutated` in
 * `packages/graph-service/src/keys.ts`. The typed `key` field is the obvious
 * one. `properties.key` is the door that is harder to spot and worse to miss:
 * property writes are PERMISSIVE about unknown keys, so a caller refused at the
 * front door learns that the side door works, and a key parked in `properties`
 * is worse than no key at all. It reads as a key to a human and to nothing
 * else. No query resolves it, no citation follows it, and no uniqueness check
 * sees it. graph-service guards its `data` bag for exactly this reason, and
 * that bag is this `properties` object one adapter down.
 *
 * The spec declares no entity property named `key` on any type, so the guard
 * cannot collide with a legitimate write. This is a mirror, not over-reach.
 *
 * Returns the refusal message, or `null` when the patch is clean, so the
 * throwing doors and the result-returning doors share one answer.
 */
export function nodeKeyMutationRefusal(nodeId: string, patch: NodeKeyMutationCheck): string | null {
  if (patch.key !== undefined) return new NodeKeyImmutableError(nodeId).message
  if (patch.properties && Object.prototype.hasOwnProperty.call(patch.properties, 'key')) {
    return new NodeKeyImmutableError(nodeId).message
  }
  return null
}

/**
 * Guard every throwing update path with this.
 *
 * `key` is deliberately ABSENT from `UpdateNodeArgs` / `BatchUpdateInput`, so a
 * typed caller cannot reach the first door at all. The guard exists for the
 * runtime-shaped input that can (an MCP argument bag, parsed JSON) and for the
 * second door, which a typed caller CAN reach because `properties` is an open
 * record by contract.
 */
export function assertNodeKeyNotMutated(nodeId: string, patch: NodeKeyMutationCheck): void {
  if (nodeKeyMutationRefusal(nodeId, patch) !== null) throw new NodeKeyImmutableError(nodeId)
}

export interface UpdateNodeArgs {
  node_id: string
  title?: string
  description?: string
  tags?: unknown
  status?: string
  /**
   * Swept out of default views. Orthogonal to `status` (0.32.0 C3), so a node
   * can be done and live, or done and archived.
   */
  archived?: boolean
  /**
   * ISO timestamp archived. Pairs with `archived === true`. `null` CLEARS the
   * field, matching the seam `graph-service` already relies on: the spec shape
   * is absent-never-null on disk and the store omits a null at serialization.
   */
  archived_at?: string | null
  /** Properties to set/merge (deep-merge over existing). */
  properties?: Record<string, unknown>
  /**
   *: property keys to DELETE. Permissive writes (store unknown keys)
   * require a permissive unset; writing `{ key: null }` only stores a literal
   * null, it can't remove the key. Applied AFTER `properties` merge, so you can
   * set some keys and drop others in one call. Unknown keys are ignored.
   */
  unset_properties?: string[]
  /**: promote unknown-property warnings to a rejection. */
  strict?: boolean
}

export interface UpdateNodeResult {
  node: UPGBaseNode
  /** Property keys removed by `unset_properties`. */
  unset?: string[]
  warning?: string
}

/**
 * Update a node with the SAME validation posture as createNode and
 * permissive property unset.
 *
 * - `status` (when provided): must ∈ the node type's lifecycle phases → throws
 *   `WriteValidationError` (single↔batch identical; batch returns the message).
 * - `properties`: deep-merged; unknown keys → warning (or rejection in strict).
 * - `unset_properties`: deletes keys after the merge.
 *
 * Throws `Error` if the node does not exist.
 */
export function updateNode(
  store: UPGFileStore,
  args: UpdateNodeArgs,
): UpdateNodeResult {
  // Immutable once assigned, never reused, so no update carries a key, through
  // either door. Checked BEFORE the existence lookup so the answer is the same
  // whichever node id was named: an update path never writes a key.
  assertNodeKeyNotMutated(args.node_id, args as NodeKeyMutationCheck)

  const existing = store.getNode(args.node_id)
  if (!existing) throw new Error(`Node not found: ${args.node_id}`)

  // Validate against the node's FIXED type (update doesn't change type here;
  // migrateNodeType owns retyping). Status + properties get the same posture
  // as createNode.
  const validation = validateNodeWrite(
    { knownType: existing.type as string, status: args.status, properties: args.properties },
    { strict: args.strict },
  )
  if (validation.errors.length > 0) {
    throw new WriteValidationError(validation.errors)
  }

  const patch: Partial<Omit<UPGBaseNode, 'archived_at'>> & { archived_at?: string | null } = {}
  if (args.title !== undefined) patch.title = args.title
  if (args.description !== undefined) patch.description = args.description
  if (args.tags !== undefined) patch.tags = normalizeTags(args.tags) ?? []
  if (args.status !== undefined) patch.status = args.status
  if (args.properties !== undefined) patch.properties = args.properties
  // The archive axis is a DECLARED base-node field (0.32.0 C3), writable on
  // create and on update. `key` is not: it is refused above.
  if (args.archived !== undefined) patch.archived = args.archived
  if (args.archived_at !== undefined) patch.archived_at = args.archived_at

  let node = store.updateNode(
    args.node_id,
    patch as Partial<UPGBaseNode>,
  )

  let removed: string[] | undefined
  if (args.unset_properties && args.unset_properties.length > 0) {
    const r = store.unsetNodeProperties(args.node_id, args.unset_properties)
    node = r.node
    if (r.removed.length > 0) removed = r.removed
  }

  if (existing.type === 'product') {
    reconcileProductStageCarriers(store, node, {
      patchedProperties: args.properties,
      patchedStatus: args.status,
      unsetProperties: args.unset_properties,
    })
  }

  const warning = validation.warnings.length > 0 ? validation.warnings.join(' | ') : undefined
  return {
    node,
    ...(removed ? { unset: removed } : {}),
    ...(warning ? { warning } : {}),
  }
}

// ── batch_update_nodes ( unified validation + unset) ───────────

export interface BatchUpdateInput {
  node_id: string
  title?: string
  description?: string
  tags?: unknown
  status?: string
  /** Swept out of default views. Orthogonal to `status` (0.32.0 C3). */
  archived?: boolean
  /** ISO timestamp archived. `null` CLEARS the field. */
  archived_at?: string | null
  properties?: Record<string, unknown>
  unset_properties?: string[]
  strict?: boolean
}

export interface BatchUpdateOk {
  ok: true
  updated: Array<{ id: string; unset?: string[] }>
  count: number
  warnings?: string[]
}

export interface BatchUpdateFail {
  ok: false
  error: string
}

export type BatchUpdateResult = BatchUpdateOk | BatchUpdateFail

/**
 * Atomic batch update with the SAME validation posture as updateNode /
 * createNode. Validates EVERY update against the canonical schema
 * BEFORE any mutation; on the first rejection nothing is applied. If a mutation
 * fails mid-apply (should not happen post-validation) the already-applied
 * updates are NOT auto-rolled-back (property merges are not losslessly
 * reversible) — instead the call fails loud with the failing index so the
 * caller can re-read and reconcile. Validation is the real guard; the apply
 * pass should never throw.
 */
export function batchUpdateNodes(
  store: UPGFileStore,
  updates: BatchUpdateInput[],
): BatchUpdateResult {
  if (!Array.isArray(updates)) return { ok: false, error: 'Missing required parameter: updates (array)' }
  if (updates.length === 0) return { ok: false, error: 'updates array is empty' }
  if (updates.length > 50) return { ok: false, error: 'Maximum 50 updates per batch' }

  // ── Validation pass ─────────────────────────────────────────────────────
  const warnings: string[] = []
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i]
    if (!u.node_id) return { ok: false, error: `Update at index ${i}: missing required field "node_id"` }
    // Immutable once assigned, never reused, through either door. Refused in
    // the VALIDATION pass so a batch carrying a key lands nothing at all,
    // rather than half its updates and then a refusal.
    const keyRefusal = nodeKeyMutationRefusal(u.node_id, u as NodeKeyMutationCheck)
    if (keyRefusal !== null) {
      return { ok: false, error: `Update at index ${i}: ${keyRefusal}` }
    }
    const node = store.getNode(u.node_id)
    if (!node) return { ok: false, error: `Update at index ${i}: node not found: ${u.node_id}` }
    const validation = validateNodeWrite(
      { knownType: node.type as string, status: u.status, properties: u.properties },
      { strict: u.strict },
    )
    if (validation.errors.length > 0) {
      return { ok: false, error: `Update at index ${i}: ${validation.errors.join(' ')}` }
    }
    for (const w of validation.warnings) warnings.push(`Update at index ${i}: ${w}`)
  }

  // ── Apply pass ────────────────────────────────────────────────────────────
  const updated: Array<{ id: string; unset?: string[] }> = []
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i]
    const patch: Partial<Omit<UPGBaseNode, 'archived_at'>> & { archived_at?: string | null } = {}
    if (u.title !== undefined) patch.title = u.title
    if (u.description !== undefined) patch.description = u.description
    if (u.tags !== undefined) patch.tags = normalizeTags(u.tags) ?? []
    if (u.status !== undefined) patch.status = u.status
    if (u.properties !== undefined) patch.properties = u.properties
    // Same archive axis as the single-node door, same refusal on `key` above.
    // One posture, both doors, so they cannot drift apart again.
    if (u.archived !== undefined) patch.archived = u.archived
    if (u.archived_at !== undefined) patch.archived_at = u.archived_at
    try {
      let node = store.updateNode(u.node_id, patch as Partial<UPGBaseNode>)
      let removed: string[] | undefined
      if (u.unset_properties && u.unset_properties.length > 0) {
        const r = store.unsetNodeProperties(u.node_id, u.unset_properties)
        node = r.node
        if (r.removed.length > 0) removed = r.removed
      }
      // Same §B reconcile as the single-node path. The batch door had NO header
      // sync at all, so a batched product-stage write left the header stale until
      // the serializer's overlay happened to re-derive it — and once the overlay
      // prefers `properties.stage`, a batched `status` write beside a stale
      // `properties.stage` would have been discarded outright. One helper, both
      // doors, so they cannot drift apart again.
      if (node.type === 'product') {
        reconcileProductStageCarriers(store, node, {
          patchedProperties: u.properties,
          patchedStatus: u.status,
          unsetProperties: u.unset_properties,
        })
      }
      updated.push({ id: u.node_id, ...(removed ? { unset: removed } : {}) })
    } catch (err) {
      return {
        ok: false,
        error: `Update at index ${i} failed during apply: ${(err as Error).message}. ${updated.length} update(s) already applied; re-read to reconcile.`,
      }
    }
  }

  const result: BatchUpdateOk = { ok: true, updated, count: updated.length }
  if (warnings.length > 0) result.warnings = warnings
  return result
}
