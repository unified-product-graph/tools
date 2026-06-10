/**
 * Spec introspection handlers. Read-only snapshot of `@unified-product-graph/core`
 * compiled at server boot: playbooks, approaches, domain guides, frameworks,
 * edge catalogue, regions, lenses, type labels, entity meta, anti-patterns,
 * benchmarks, lifecycles, scales, migrations.
 *
 * Every handler is atomic and ignores `CloudContext`; the parameter satisfies
 * `ToolHandler<CloudContext>`. See `TOOLS.md` for the generated per-tool reference.
 */

import {
  UPG_PLAYBOOKS,
  UPG_APPROACHES,
  UPG_APPROACHES_BY_ID,
  REFLECT_MODES,
  UPG_DOMAIN_GUIDES,
  UPG_DOMAINS,
  UPG_FRAMEWORKS,
  UPG_FRAMEWORKS_BY_ID,
  UPG_EDGE_CATALOG,
  UPG_REGIONS,
  UPG_REGION_MAP,
  UPG_REGION_COUNT,
  UPG_LENSES,
  UPG_TYPE_LABELS,
  UPG_TYPE_LABELS_MAP,
  UPG_VALID_CHILDREN,
  UPG_CROSS_EDGE_TYPES,
  UPG_VERSION,
  MARKDOWN_FORMAT_VERSION,
  UPG_ENTITY_COUNT,
  UPG_DOMAIN_COUNT,
  UPG_EDGE_COUNT,
  UPG_ENTITY_META,
  UPG_ENTITY_META_BY_NAME,
  UPG_ENTITY_TO_DOMAIN,
  UPG_ANTI_PATTERNS,
  UPG_COUNT_BENCHMARKS,
  UPG_RELATIONSHIP_BENCHMARKS,
  UPG_RATIO_BENCHMARKS,
  UPG_DOMAIN_ACTIVATION,
  UPG_PRODUCT_STAGES,
  UPG_MIGRATIONS,
  UPG_EDGE_MIGRATIONS,
  UPG_SPLIT_MIGRATIONS,
  UPG_LIFECYCLES,
  UPG_LIFECYCLE_FREE_TYPES,
  UPG_LIFECYCLE_PLANNED_TYPES,
  UPG_SCALES,
  UPG_FRAMEWORK_CATEGORIES,
  UPG_STRUCTURE_PATTERNS,
  UPG_DOMAIN_RINGS,
  resolveContainmentEdge,
  resolveLabel,
  getRegionForEntityType,
  getLens,
  getVisibleTypes,
  getValidChildren,
  type UPGPlaybook,
  type UPGApproach,
  type UPGApproachId,
  type ReflectMode,
  type UPGRegion,
  type UPGDomainUsageGuide,
  type UPGFramework,
  type UPGEdgeDefinition,
  type UPGLens,
  type UPGTypeLabel,
  type EntityTypeMeta,
  type UPGEntityTypeMaturity,
  type UPGCuratedAntiPattern,
  type UPGAntiPatternSeverity,
  type UPGProductStage,
  type CountBenchmark,
  type RelationshipBenchmark,
  type RatioBenchmark,
  type DomainActivation,
  type UPGLifecycle,
  type UPGScaleDefinition,
  type UPGDomainRing,
} from '@unified-product-graph/core'

import type { ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'

// ── Pagination helpers (mirror list_nodes convention) ───────────────────────

const FRAMEWORKS_DEFAULT_LIMIT = 50
const FRAMEWORKS_MAX_LIMIT = 200

function clampLimit(raw: unknown, def: number, max: number): number {
  const n = typeof raw === 'number' ? raw : def
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.floor(n), max)
}

function decodeCursor(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0
  // Cursor format: base64-encoded "offset:N". Tolerant: fall back to 0 on
  // malformed input rather than erroring (matches `list_nodes` UX).
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8')
    const m = decoded.match(/^offset:(\d+)$/)
    if (!m) return 0
    return Number.parseInt(m[1], 10)
  } catch {
    return 0
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf-8').toString('base64')
}

// ── Playbooks ─────────────────────────────────────────────────────

/**
 * List every canonical UPGPlaybook shipped with `@unified-product-graph/core`,
 * optionally narrowed by region, canonical-only flag, or framework_id.
 * Returns full playbook records: id, name, version, description, region,
 * is_canonical, framework_id, target_anchor_entity, and the ordered
 * creation_sequence.
 *
 * - region: exact-match filter on `UPGPlaybook.region` (a UPGRegionId).
 * - canonical_only: when true, return only playbooks with `is_canonical: true`
 * (exactly one per region, restating W1 invariant).
 * - framework_id: exact-match filter on `UPGPlaybook.framework_id`. 3 playbooks
 *   are framework-anchored at v0.3.0 (BMC, AARRR, build-measure-learn).
 *
 * Filters AND together. Result is the canonical array order from `UPG_PLAYBOOKS`
 * (canonical first within each region).
 *
 * @returns JSON: `{ count, playbooks: UPGPlaybook[] }`
 * @atomicity atomic (read-only)
 * @see get_playbook
 * @see list_regions
 * @see list_approaches
 * @see list_frameworks
 */
export const listPlaybooks: ToolHandler = (args): ToolResult => {
  const region = args.region as string | undefined
  const canonicalOnly = args.canonical_only as boolean | undefined
  const frameworkId = args.framework_id as string | undefined

  let playbooks: readonly UPGPlaybook[] = UPG_PLAYBOOKS
  if (region) playbooks = playbooks.filter((p) => p.region === region)
  if (canonicalOnly === true) playbooks = playbooks.filter((p) => p.is_canonical === true)
  if (frameworkId) playbooks = playbooks.filter((p) => p.framework_id === frameworkId)

  return text(JSON.stringify({ count: playbooks.length, playbooks }, null, 2))
}

/**
 * Return one canonical UPGPlaybook by id (e.g. "playbook:strategy-outcomes",
 * "playbook:business-gtm-growth"). Includes the ordered creation_sequence with
 * full step kinds and prompts.
 *
 * IDs are namespace-prefixed (`playbook:*`). Calling with an `approach:*` id
 * (or one of the 5 bare-verb approach ids) returns null; route via
 * `get_approach` for the approach catalog.
 *
 * @returns JSON: the full `UPGPlaybook` record.
 * @throws textError when `id` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see list_playbooks
 * @see get_approach
 * @see get_framework
 * @see get_region
 */
export const getPlaybook: ToolHandler = (args): ToolResult => {
  const id = args.id as string | undefined
  if (!id) return textError('Missing required parameter: id')
  const playbook = UPG_PLAYBOOKS.find((p) => p.id === id)
  if (!playbook) return textError(`Unknown playbook id: ${id}`)
  return text(JSON.stringify(playbook, null, 2))
}

// ── Approaches ────────────────────────────────────────────────────

/**
 * List the five canonical UPGApproach records shipped with
 * `@unified-product-graph/core`: Plan / Inspect / Prioritise / Trace /
 * Reflect. Returns the full approach record per entry (id, label,
 * description with cartographic framing, question_answered, signature_hint,
 * framework_id_examples).
 *
 * **Cartographic framing**: an approach is the *path of arrival* to a
 * region of the graph (final approach to an airport, coastline approach),
 * distinct from the strategy-meeting sense ("what's our approach to this
 * problem?").
 *
 * Optional `framework_id` filter narrows to approaches whose
 * `framework_id_examples` include the given id (discoverability surface;
 * full reverse lookup is on `UPGFramework.approach_ids`).
 *
 * @returns JSON: `{ count, approaches: UPGApproach[] }`
 * @atomicity atomic (read-only)
 * @see get_approach
 * @see plan
 * @see inspect
 * @see prioritise
 * @see trace
 * @see reflect
 * @see list_playbooks
 */
export const listApproaches: ToolHandler = (args): ToolResult => {
  const frameworkId = args.framework_id as string | undefined

  let approaches: readonly UPGApproach[] = UPG_APPROACHES
  if (frameworkId) {
    approaches = approaches.filter((a) =>
      a.framework_id_examples?.includes(frameworkId) ?? false,
    )
  }

  return text(JSON.stringify({ count: approaches.length, approaches }, null, 2))
}

/**
 * Return one canonical UPGApproach by id. Valid ids are the bare verbs
 * `'plan' | 'inspect' | 'prioritise' | 'trace' | 'reflect'`: the same
 * names as the verb-led MCP tools.
 *
 * @returns JSON: the full `UPGApproach` record.
 * @throws textError when `id` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see list_approaches
 * @see plan
 * @see inspect
 * @see prioritise
 * @see trace
 * @see reflect
 */
export const getApproach: ToolHandler = (args): ToolResult => {
  const id = args.id as string | undefined
  if (!id) return textError('Missing required parameter: id')
  const approach = UPG_APPROACHES_BY_ID[id]
  if (!approach) {
    return textError(
      `Unknown approach id: ${id}. Valid ids: plan, inspect, prioritise, trace, reflect.`,
    )
  }
  return text(JSON.stringify(approach, null, 2))
}

// ── Approach verb handlers ────────────────────────────────────────
//
// Five bare-verb handlers (`plan`, `inspect`, `prioritise`, `trace`,
// `reflect`) exposed as direct MCP tools (no `apply_*` prefix). At v0.3.0
// every handler is a **definition lookup**: it validates inputs, looks up
// the approach record, and returns the family-resemblance envelope
// `{ approach_id, scope, generated_at, ...payload }` where `payload` echoes
// the caller's invocation parameters plus the approach record. The LLM is
// the executor; it reads the signature_hint and synthesises the structured
// projection (Plan's coverage_score, Inspect's violations[], etc.).

function approachEnvelope(
  approachId: UPGApproachId,
  scope: unknown,
  payload: Record<string, unknown>,
): ReturnType<typeof text> {
  const approach = UPG_APPROACHES_BY_ID[approachId]
  return text(
    JSON.stringify(
      {
        approach_id: approachId,
        scope,
        generated_at: new Date().toISOString(),
        approach,
        ...payload,
      },
      null,
      2,
    ),
  )
}

/**
 * `plan`: the path of arrival to "what should I build next?".
 *
 * v0.3.0 ships as a definition lookup. Returns the Plan approach record
 * wrapped in the family-resemblance envelope, with the caller's `region`
 * echoed in `scope` and surfaced in `params`. The LLM consumes the
 * approach record's `signature_hint` and synthesises
 * `{ missing_entities, coverage_score }` against the live graph.
 *
 * @returns JSON envelope: `{ approach_id: 'plan', scope, generated_at, approach, params }`
 * @atomicity atomic (read-only)
 * @warning v0.3.0 returns the approach record only; the caller (LLM) is
 *   the executor. Structured execution (compute coverage_score from
 *   canonical region playbooks) lands in v0.3.x.
 * @see get_approach
 * @see list_playbooks
 * @see get_region
 * @see inspect
 * @see prioritise
 */
export const plan: ToolHandler = (args): ToolResult => {
  const region = args.region as string | undefined
  return approachEnvelope('plan', region ?? null, {
    params: { region: region ?? null },
    execution_mode: 'definition_lookup_v0_3_0',
  })
}

/**
 * `inspect`: the path of arrival to "what's broken?".
 *
 * v0.3.0 ships as a definition lookup. Returns the Inspect approach record
 * wrapped in the family-resemblance envelope. The LLM consumes the
 * `signature_hint` and synthesises `{ violations: [...] }` against
 * `UPG_ANTI_PATTERNS` and the live graph.
 *
 * @returns JSON envelope: `{ approach_id: 'inspect', scope, generated_at, approach, params }`
 * @atomicity atomic (read-only)
 * @warning v0.3.0 returns the approach record only; the caller (LLM) is
 *   the executor. Structured execution (run anti-pattern matchers plus
 *   structural lints) lands in v0.3.x.
 * @see get_approach
 * @see list_anti_patterns
 * @see get_anti_pattern
 * @see validate_graph
 * @see plan
 * @see reflect
 */
export const inspect: ToolHandler = (args): ToolResult => {
  const region = args.region as string | undefined
  const entities = args.entities as string[] | undefined
  const scope = region ?? entities ?? null
  return approachEnvelope('inspect', scope, {
    params: {
      region: region ?? null,
      entities: Array.isArray(entities) ? entities : null,
    },
    execution_mode: 'definition_lookup_v0_3_0',
  })
}

/**
 * `prioritise`: the path of arrival to "what's most important?".
 *
 * v0.3.0 ships as a definition lookup. Both `candidates` and `framework_id`
 * are required; prioritisation without an explicit candidate set or a
 * declared scoring lens is incoherent. Returns the Prioritise approach
 * record wrapped in the family-resemblance envelope.
 *
 * @returns JSON envelope: `{ approach_id: 'prioritise', scope, generated_at, approach, params }`
 * @throws textError when `candidates` or `framework_id` are missing/empty.
 * @atomicity atomic (read-only)
 * @warning v0.3.0 returns the approach record plus framework lookup only.
 *   Structured execution (apply framework's `computed_properties` to each
 *   candidate, return ranked output) lands in v0.3.x.
 * @see get_approach
 * @see list_frameworks
 * @see get_framework
 * @see plan
 * @see trace
 */
export const prioritise: ToolHandler = (args): ToolResult => {
  const candidates = args.candidates as string[] | undefined
  const frameworkId = args.framework_id as string | undefined
  if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
    return textError('Missing required parameter: candidates (entity_id[])')
  }
  if (!frameworkId) {
    return textError(
      'Missing required parameter: framework_id (e.g. "rice-scoring", "ice-scoring", "kano-model")',
    )
  }
  const framework = UPG_FRAMEWORKS_BY_ID[frameworkId]
  return approachEnvelope('prioritise', candidates, {
    params: { candidates, framework_id: frameworkId },
    framework_resolved: framework
      ? { id: framework.id, name: framework.name, category: framework.category }
      : null,
    execution_mode: 'definition_lookup_v0_3_0',
  })
}

/**
 * `trace`: the path of arrival to "walk a meaningful path through existing
 * graph". Path is type-shorthand: `["persona", "job", "feature"]` walks
 * persona→job→feature using the canonical edge for each pair (resolve via
 * `resolve_edge_for_pair`). Optional `edges_override` selects non-canonical
 * edges per hop; element `null` means "use canonical". The path expression
 * is the UPGEntityType[] shorthand itself (no DSL).
 *
 * v0.3.0 ships as a definition lookup.
 *
 * @returns JSON envelope: `{ approach_id: 'trace', scope, generated_at, approach, params }`
 * @throws textError when `anchor` or `path` are missing/invalid.
 * @atomicity atomic (read-only)
 * @warning v0.3.0 returns the approach record only; the LLM composes the
 *   actual traversal via `query()`. Structured execution (BFS walker that
 *   returns `{ trail, reached }`) lands in v0.3.x.
 * @see get_approach
 * @see resolve_edge_for_pair
 * @see query
 * @see get_node
 * @see plan
 * @see prioritise
 */
export const trace: ToolHandler = (args): ToolResult => {
  const anchor = args.anchor as string | undefined
  const path = args.path as string[] | undefined
  const edgesOverride = args.edges_override as (string | null)[] | undefined
  if (!anchor) {
    return textError('Missing required parameter: anchor (entity_id)')
  }
  if (!path || !Array.isArray(path) || path.length === 0) {
    return textError('Missing required parameter: path (UPGEntityType[])')
  }
  if (edgesOverride && edgesOverride.length !== path.length) {
    return textError(
      `edges_override length (${edgesOverride.length}) must match path length (${path.length})`,
    )
  }
  return approachEnvelope('trace', anchor, {
    params: {
      anchor,
      path,
      edges_override: edgesOverride ?? null,
    },
    execution_mode: 'definition_lookup_v0_3_0',
  })
}

/**
 * `reflect`: the path of arrival to "what should I be questioning?".
 *
 * Optional `mode` is one of the 4 canonical nouns:
 * `'assumptions' | 'alternatives' | 'blind-spots' | 'load-bearing'`.
 * Absence of mode means open reflection (undefined IS the open case;
 * there's no `'open'` literal). Optional `scope` accepts a region id,
 * an entity id, or `null` for whole-graph reflection.
 *
 * v0.3.0 ships as a definition lookup.
 *
 * @returns JSON envelope: `{ approach_id: 'reflect', scope, generated_at, approach, params }`
 * @throws textError when `mode` is provided but not one of the 4 canonical nouns.
 * @atomicity atomic (read-only)
 * @warning v0.3.0 returns the approach record only; the caller (LLM)
 *   emits the prompts. Structured execution (template-driven prompt
 *   generation per mode plus targeted entity selection) lands in v0.3.x.
 * @see get_approach
 * @see inspect
 * @see plan
 * @see get_anti_pattern
 */
export const reflect: ToolHandler = (args): ToolResult => {
  const scope = args.scope as string | null | undefined
  const mode = args.mode as string | undefined
  if (mode !== undefined && !REFLECT_MODES.includes(mode as ReflectMode)) {
    return textError(
      `Invalid mode: ${mode}. Valid modes: ${REFLECT_MODES.join(', ')}. Omit mode for open reflection.`,
    )
  }
  return approachEnvelope('reflect', scope ?? null, {
    params: {
      scope: scope ?? null,
      mode: mode ?? null,
    },
    execution_mode: 'definition_lookup_v0_3_0',
  })
}

// ── Domains ─────────────────────────────────────────────────────────────────

/**
 * List every domain in `@unified-product-graph/core`.
 *
 * Two modes via `with_guide_only` (default `true`, preserving the
 * historical shape):
 *   - `with_guide_only: true` (default): returns only domains that have a
 *     canonical `UPGDomainUsageGuide`. Each row carries `{ domain_id,
 *     anchor_entity, creation_sequence }` (the surface needed before drilling
 *     into `get_domain_guide`). Order matches the canonical ring layout used
 *     by `UPG_DOMAIN_GUIDES`.
 * - `with_guide_only: false`: returns every atomic domain from
 *     `UPG_DOMAINS` (~36 at v0.3.0). Each row carries `{ domain_id, label,
 *     description, types, has_guide }`. Use this to enumerate the full
 *     catalog when authoring or auditing; `has_guide` flags whether a guide
 *     is available for `get_domain_guide`.
 *
 * @returns JSON: `{ count, domains: Array<{ domain_id, anchor_entity, creation_sequence } | { domain_id, label, description, types, has_guide }> }`
 * @atomicity atomic (read-only)
 * @see get_domain_guide
 * @see list_regions
 * @see list_entity_types
 */
export const listDomains: ToolHandler = (args): ToolResult => {
  const withGuideOnly = args.with_guide_only as boolean | undefined
  if (withGuideOnly === false) {
    const guideIds = new Set(UPG_DOMAIN_GUIDES.map((g) => g.domain_id))
    const domains = UPG_DOMAINS.map((d) => ({
      domain_id: d.id,
      label: d.label,
      description: d.description,
      types: d.types,
      has_guide: guideIds.has(d.id),
    }))
    return text(JSON.stringify({ count: domains.length, domains }, null, 2))
  }
  const domains = UPG_DOMAIN_GUIDES.map((g) => ({
    domain_id: g.domain_id,
    anchor_entity: g.anchor_entity,
    creation_sequence: g.creation_sequence,
  }))
  return text(JSON.stringify({ count: domains.length, domains }, null, 2))
}

/**
 * Return the full UPGDomainUsageGuide for a domain: anchor entity, creation
 * sequence, named patterns (entity and edge chains), required cross-domain
 * bridges, and anti-patterns. This is the canonical "how do I work in this
 * domain" surface for MCP agents.
 *
 * @returns JSON: the full `UPGDomainUsageGuide` record.
 * @throws textError when `domain_id` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see list_domains
 * @see list_anti_patterns
 * @see get_playbook
 */
export const getDomainGuide: ToolHandler = (args): ToolResult => {
  const domainId = args.domain_id as string | undefined
  if (!domainId) return textError('Missing required parameter: domain_id')
  const guide: UPGDomainUsageGuide | undefined = UPG_DOMAIN_GUIDES.find(
    (g) => g.domain_id === domainId,
  )
  if (!guide) return textError(`Unknown domain_id: ${domainId}`)
  return text(JSON.stringify(guide, null, 2))
}

// ── Frameworks ──────────────────────────────────────────────────────────────

/**
 * List the canonical UPGFramework definitions: the curated, famous product
 * frameworks that anchor the public catalog. Paginated (default `limit: 50`,
 * max 200) because the full payload is large enough to overflow MCP transports
 * if returned in one shot.
 *
 * Cursor is opaque base64 (`offset:N`). Pass the `next_cursor` from a previous
 * response to advance; omit to start from the first page. The optional
 * `category` filter is exact-match against `UPGFramework.category` (e.g.
 * "strategy", "prioritization", "discovery") and applied BEFORE pagination,
 * so `total` reflects the filtered count.
 *
 * @returns JSON: `{ total, count, next_cursor?, frameworks: UPGFramework[] }`
 * @atomicity atomic (read-only)
 * @see get_framework
 * @see prioritise
 * @see list_approaches
 */
export const listFrameworks: ToolHandler = (args): ToolResult => {
  const category = args.category as string | undefined
  const limit = clampLimit(args.limit, FRAMEWORKS_DEFAULT_LIMIT, FRAMEWORKS_MAX_LIMIT)
  const cursorOffset = decodeCursor(args.cursor)

  let pool: readonly UPGFramework[] = UPG_FRAMEWORKS
  if (category) pool = pool.filter((f) => f.category === category)

  const total = pool.length
  const slice = pool.slice(cursorOffset, cursorOffset + limit)
  const nextOffset = cursorOffset + slice.length
  const nextCursor = nextOffset < total ? encodeCursor(nextOffset) : undefined

  const body: Record<string, unknown> = {
    total,
    count: slice.length,
    frameworks: slice,
  }
  if (nextCursor) body.next_cursor = nextCursor

  return text(JSON.stringify(body, null, 2))
}

/**
 * Return one canonical UPGFramework by id (e.g. "rice-scoring",
 * "lean-canvas"). Includes all four layers: data, structure, presentation,
 * education.
 *
 * @returns JSON: the full `UPGFramework` record.
 * @throws textError when `id` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see list_frameworks
 * @see prioritise
 * @see get_playbook
 * @see get_approach
 */
export const getFramework: ToolHandler = (args): ToolResult => {
  const id = args.id as string | undefined
  if (!id) return textError('Missing required parameter: id')
  const framework = UPG_FRAMEWORKS_BY_ID[id]
  if (!framework) return textError(`Unknown framework id: ${id}`)
  return text(JSON.stringify(framework, null, 2))
}

// ── Edge catalogue ──────────────────────────────────────────────────────────

interface EdgeCatalogEntry extends UPGEdgeDefinition {
  type: string
}

function buildEdgeEntries(
  filterSource?: string,
  filterTarget?: string,
): EdgeCatalogEntry[] {
  const entries: EdgeCatalogEntry[] = []
  for (const [type, def] of Object.entries(UPG_EDGE_CATALOG) as Array<
    [string, UPGEdgeDefinition]
  >) {
    if (filterSource && def.source_type !== filterSource) continue
    if (filterTarget && def.target_type !== filterTarget) continue
    entries.push({ type, ...def })
  }
  return entries
}

/**
 * List every canonical edge type from `UPG_EDGE_CATALOG`, optionally narrowed
 * by source_type and/or target_type. Each entry carries the edge key (`type`),
 * its forward/reverse verbs, structural classification, and endpoint types.
 * The polymorphic wildcard `'node'` is preserved on edges that are registered
 * as polymorphic; callers should treat it as "matches any entity type".
 *
 * @returns JSON: `{ count, edges: Array<{ type, forward_verb, reverse_verb, classification, source_type, target_type }> }`
 * @atomicity atomic (read-only)
 * @see get_edge_type
 * @see resolve_edge_for_pair
 * @see list_cross_edge_types
 * @see create_edge
 */
export const listEdgeTypes: ToolHandler = (args): ToolResult => {
  const sourceType = args.source_type as string | undefined
  const targetType = args.target_type as string | undefined
  const edges = buildEdgeEntries(sourceType, targetType)
  return text(JSON.stringify({ count: edges.length, edges }, null, 2))
}

/**
 * Return one canonical edge catalogue entry by edge type key (e.g.
 * "persona_pursues_job", "feature_addresses_need").
 *
 * @returns JSON: `{ type, forward_verb, reverse_verb, classification, source_type, target_type }`
 * @throws textError when `type` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see list_edge_types
 * @see resolve_edge_for_pair
 * @see rename_edge_type
 */
export const getEdgeType: ToolHandler = (args): ToolResult => {
  const type = args.type as string | undefined
  if (!type) return textError('Missing required parameter: type')
  const def = (UPG_EDGE_CATALOG as Record<string, UPGEdgeDefinition>)[type]
  if (!def) return textError(`Unknown edge type: ${type}`)
  return text(JSON.stringify({ type, ...def }, null, 2))
}

// ── Regions ───────────────────────────────────────────────────────

/**
 * List every canonical UPGRegion shipped with `@unified-product-graph/core`.
 * Returns a compact summary per region (id, label, order, shape, mental_model,
 * anchor entity type, atomic-domain composition, entity / edge counts): the
 * minimum surface needed to decide whether to drill into `get_region`. The
 * region count is fixed (10) so this endpoint stays non-paginated.
 *
 * Order matches the canonical 1..10 ring sequence from `UPG_REGIONS`
 * (Strategy & Outcomes → Operations & Quality).
 *
 * @returns JSON: `{ count, regions: Array<{ id, label, order, shape, mental_model, anchor_type, composes_atomic_domains, entity_count, intra_edge_count, boundary_edge_count }> }`
 * @atomicity atomic (read-only)
 * @see get_region
 * @see get_region_for_entity_type
 * @see list_domains
 * @see list_playbooks
 */
export const listRegions: ToolHandler = (): ToolResult => {
  const regions = UPG_REGIONS.map((r) => ({
    id: r.id,
    label: r.label,
    order: r.order,
    shape: r.shape,
    mental_model: r.mental_model,
    anchor_type: r.anchor.type,
    composes_atomic_domains: r.composes_atomic_domains,
    entity_count: r.entities.length,
    intra_edge_count: r.intra_edges.length,
    boundary_edge_count: r.boundary_edges.length,
  }))
  return text(
    JSON.stringify({ count: UPG_REGION_COUNT, regions }, null, 2),
  )
}

/**
 * Return the full UPGRegion record by id: anchor entity (with rationale and
 * inbound/outbound cross-edge counts), entity memberships with structural
 * roles, intra-domain edge keys, boundary edges to other regions, shape
 * archetype, and the atomic-domain composition.
 *
 * @returns JSON: the full `UPGRegion` record.
 * @throws textError when `id` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see list_regions
 * @see get_region_for_entity_type
 * @see get_playbook
 * @see list_lenses
 */
export const getRegion: ToolHandler = (args): ToolResult => {
  const id = args.id as string | undefined
  if (!id) return textError('Missing required parameter: id')
  const region: UPGRegion | undefined = UPG_REGION_MAP[id]
  if (!region) return textError(`Unknown region id: ${id}`)
  return text(JSON.stringify(region, null, 2))
}

/**
 * Return the canonical UPGRegion that contains a given entity type. Wraps
 * `getRegionForEntityType`. Useful for adapters and copilots that need to
 * resolve "which super-domain does this type belong to" before deciding how
 * to render or route it.
 *
 * @returns JSON: the full `UPGRegion` record.
 * @throws textError when `entity_type` is missing or no region contains it.
 * @atomicity atomic (read-only)
 * @see get_region
 * @see list_regions
 * @see get_entity_meta
 * @see list_entity_types
 */
export const getRegionForEntity: ToolHandler = (args): ToolResult => {
  const entityType = args.entity_type as string | undefined
  if (!entityType) return textError('Missing required parameter: entity_type')
  const region = getRegionForEntityType(entityType)
  if (!region) return textError(`No region contains entity_type: ${entityType}`)
  return text(JSON.stringify(region, null, 2))
}

// ── Spec version ──────────────────────────────────────────────────

/**
 * Return spec-level metadata for adopter compatibility checks: the spec
 * version, markdown format version, and canonical counts (entity types, edge
 * types, atomic domains, super-domain regions). Standalone tool: adopters
 * read it cleaner than folding it into `get_workspace_info` (which is
 * graph-instance-scoped, not spec-scoped).
 *
 * The pair `(upg_version, markdown_format_version)` is the right thing to
 * pin against; counts are informational only and may shift between patch
 * releases.
 *
 * @returns JSON: `{ upg_version, markdown_format_version, entity_count, edge_count, domain_count, region_count }`
 * @atomicity atomic (read-only)
 * @see list_entity_types
 * @see list_edge_types
 * @see list_regions
 */
export const getSpecVersion: ToolHandler = (): ToolResult => {
  return text(
    JSON.stringify(
      {
        upg_version: UPG_VERSION,
        markdown_format_version: MARKDOWN_FORMAT_VERSION,
        entity_count: UPG_ENTITY_COUNT,
        edge_count: UPG_EDGE_COUNT,
        domain_count: UPG_DOMAIN_COUNT,
        region_count: UPG_REGION_COUNT,
        anti_patterns: {
          total: UPG_ANTI_PATTERNS.length,
          // Anti-patterns introduced in a tracked version (the `since` field
          // landed in 0.9.11). Lets a consumer see which validators are newer
          // than the version a graph was authored under, so a spec upgrade
          // doesn't silently flip a clean graph invalid with no heads-up
          // (batch-6 #36). Baseline patterns (no `since`) predate the tracking.
          versioned: UPG_ANTI_PATTERNS.filter((p) => p.since).map((p) => ({
            id: p.id,
            severity: p.severity,
            since: p.since,
          })),
        },
      },
      null,
      2,
    ),
  )
}

// ── Edge resolver ─────────────────────────────────────────────────

/**
 * Resolve the canonical UPGEdgeType for a `source_type` → `target_type`
 * containment pair. Wraps `resolveContainmentEdge` / `UPG_EDGE_PAIR_MAP`.
 *
 * Adapter-critical: every import adapter (Markdown, Notion, Linear, GitHub)
 * needs this when constructing `_contains_` edges. The catalog is closed,
 * so raw `${parent}_contains_${child}` template strings are unsafe because
 * most pairs are not registered. Use this tool to resolve the canonical
 * key, then fall back to a polymorphic edge (e.g. `node_informs_node`) or
 * skip when `edge_type` is `null`.
 *
 * @returns JSON: `{ source_type, target_type, edge_type: string | null }`
 * @throws textError when `source_type` or `target_type` is missing.
 * @atomicity atomic (read-only)
 * @warning Returns `edge_type: null` when no canonical pair is registered;
 *   adapters MUST fall back to a polymorphic edge or skip the relationship
 *   rather than synthesise a non-canonical key.
 * @see list_edge_types
 * @see get_edge_type
 * @see create_edge
 * @see trace
 */
export const resolveEdgeForPair: ToolHandler = (args): ToolResult => {
  const sourceType = args.source_type as string | undefined
  const targetType = args.target_type as string | undefined
  if (!sourceType) return textError('Missing required parameter: source_type')
  if (!targetType) return textError('Missing required parameter: target_type')
  const edgeType = resolveContainmentEdge(sourceType, targetType)
  return text(
    JSON.stringify(
      { source_type: sourceType, target_type: targetType, edge_type: edgeType },
      null,
      2,
    ),
  )
}

// ── Cross-edge types ──────────────────────────────────────────────

/**
 * List the canonical cross-product edge types from `UPG_CROSS_EDGE_TYPES`
 * (`shares_persona`, `shares_competitor`, `shares_metric`,
 * `depends_on_product`, `cannibalises`, `succeeds`, `hosts`, `contributes_to`,
 * `instance_of`). These are portfolio-level relationships between entities in
 * different products, separate from the within-product `UPG_EDGE_CATALOG` and
 * previously invisible to MCP.
 *
 * @returns JSON: `{ count, types: readonly UPGCrossEdgeType[] }`
 * @atomicity atomic (read-only)
 * @see list_edge_types
 * @see list_portfolio_cross_edges
 * @see migrate_cross_edges
 */
export const listCrossEdgeTypes: ToolHandler = (): ToolResult => {
  return text(
    JSON.stringify(
      { count: UPG_CROSS_EDGE_TYPES.length, types: UPG_CROSS_EDGE_TYPES },
      null,
      2,
    ),
  )
}

// ── Lenses ────────────────────────────────────────────────────────

/**
 * List every canonical UPGLens shipped with `@unified-product-graph/core`.
 * Returns a compact summary per lens (id, name, description, icon, audience,
 * perspective, framework_id, playbook_id, visible-domain count, intelligence-
 * prompt count): the minimum surface needed to choose a lens before drilling
 * into `get_lens`.
 *
 * @returns JSON: `{ count, lenses: Array<{ id, name, description, icon, audience, perspective, framework_id?, playbook_id?, visible_domain_count, intelligence_prompt_count }> }`
 * @atomicity atomic (read-only)
 * @see get_lens
 * @see list_regions
 * @see list_playbooks
 * @see list_frameworks
 */
export const listLenses: ToolHandler = (): ToolResult => {
  const lenses = UPG_LENSES.map((l) => ({
    id: l.id,
    name: l.name,
    description: l.description,
    icon: l.icon,
    audience: l.audience,
    perspective: l.perspective,
    framework_id: l.framework_id,
    playbook_id: l.playbook_id,
    visible_domain_count: l.visible_domains.length,
    intelligence_prompt_count: l.intelligence_prompts.length,
  }))
  return text(JSON.stringify({ count: UPG_LENSES.length, lenses }, null, 2))
}

/**
 * Return the full UPGLens record by id (e.g. `'product'`, `'ux_design'`,
 * `'engineering'`, `'full'`) plus the resolved list of entity types visible
 * through that lens (`getVisibleTypes` applies `visible_domains`,
 * `always_show_types`, `always_hide_types`).
 *
 * Combining the lens record with `visible_types` in one response avoids the
 * common "fetch lens, then resolve types" round-trip for renderers.
 *
 * @returns JSON: `{ ...UPGLens, visible_types: string[] }`
 * @throws textError when `id` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see list_lenses
 * @see get_playbook
 * @see get_framework
 * @see list_entity_types
 */
export const getLensTool: ToolHandler = (args): ToolResult => {
  const id = args.id as string | undefined
  if (!id) return textError('Missing required parameter: id')
  const lens: UPGLens | undefined = getLens(id)
  if (!lens) return textError(`Unknown lens id: ${id}`)
  const visibleTypes = getVisibleTypes(lens)
  return text(JSON.stringify({ ...lens, visible_types: visibleTypes }, null, 2))
}

// ── Type labels ───────────────────────────────────────────────────

const TYPE_LABELS_DEFAULT_LIMIT = 100
const TYPE_LABELS_MAX_LIMIT = 500

/**
 * List canonical UPGTypeLabel entries: every entity type's display label,
 * alt-labels (synonyms across frameworks plus common usage), per-framework
 * labels, and (where applicable) designation labels. Paginated (default
 * `limit: 100`, max 500) because the full list spans every active type
 * (~140+) and can balloon when alt_labels are dense.
 *
 * Cursor is opaque base64 (`offset:N`) following the `list_frameworks`
 * convention. Pass the `next_cursor` from a previous response to advance.
 *
 * @returns JSON: `{ total, count, next_cursor?, labels: UPGTypeLabel[] }`
 * @atomicity atomic (read-only)
 * @see get_type_label
 * @see list_entity_types
 * @see get_entity_meta
 */
export const listTypeLabels: ToolHandler = (args): ToolResult => {
  const limit = clampLimit(args.limit, TYPE_LABELS_DEFAULT_LIMIT, TYPE_LABELS_MAX_LIMIT)
  const cursorOffset = decodeCursor(args.cursor)

  const total = UPG_TYPE_LABELS.length
  const slice = UPG_TYPE_LABELS.slice(cursorOffset, cursorOffset + limit)
  const nextOffset = cursorOffset + slice.length
  const nextCursor = nextOffset < total ? encodeCursor(nextOffset) : undefined

  const body: Record<string, unknown> = {
    total,
    count: slice.length,
    labels: slice,
  }
  if (nextCursor) body.next_cursor = nextCursor

  return text(JSON.stringify(body, null, 2))
}

/**
 * Return one canonical UPGTypeLabel by entity type, plus the resolved display
 * label for an optional `framework_id` and/or `designation` (mirrors
 * `resolveLabel`). Lookup is exact-match against `UPG_TYPE_LABELS_MAP`.
 *
 * @returns JSON: `{ ...UPGTypeLabel, resolved_label: string }`
 * @throws textError when `entity_type` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see list_type_labels
 * @see get_entity_meta
 * @see list_frameworks
 */
export const getTypeLabel: ToolHandler = (args): ToolResult => {
  const entityType = args.entity_type as string | undefined
  if (!entityType) return textError('Missing required parameter: entity_type')
  const label: UPGTypeLabel | undefined = UPG_TYPE_LABELS_MAP.get(entityType)
  if (!label) return textError(`Unknown entity_type: ${entityType}`)
  const frameworkId = args.framework_id as string | undefined
  const designation = args.designation as string | undefined
  const resolved = resolveLabel(entityType, frameworkId, designation)
  return text(JSON.stringify({ ...label, resolved_label: resolved }, null, 2))
}

// ── Hierarchy ─────────────────────────────────────────────────────

/**
 * Return the list of valid direct-child entity types for a given parent
 * type. Wraps `getValidChildren` / `UPG_VALID_CHILDREN`. Returns an empty
 * array when the parent type has no registered children (or is unknown).
 *
 * @returns JSON: `{ parent_type, valid_children: string[] }`
 * @throws textError when `parent_type` is missing.
 * @atomicity atomic (read-only)
 * @see get_entity_schema
 * @see list_entity_types
 * @see get_entity_meta
 * @see create_node
 */
export const getValidChildrenTool: ToolHandler = (args): ToolResult => {
  const parentType = args.parent_type as string | undefined
  if (!parentType) return textError('Missing required parameter: parent_type')
  const validChildren = getValidChildren(parentType)
  return text(
    JSON.stringify(
      { parent_type: parentType, valid_children: validChildren },
      null,
      2,
    ),
  )
}

// ── Entity meta + types ───────────────────────────────────────────

const ENTITY_TYPES_DEFAULT_LIMIT = 50
const ENTITY_TYPES_MAX_LIMIT = 200

/**
 * List canonical entity types from `UPG_ENTITY_META`, the source of truth
 * for ontology evolution (every active, deprecated, or removed type with
 * its immutable `type_id`, maturity tier, and version metadata). Paginated
 * (default `limit: 50`, max 200) because the catalog is large (~348
 * entries at v0.3.0).
 *
 * Filters are AND-composed and applied **before** pagination, so `total`
 * reflects the filtered count:
 *   - `domain`: exact-match against `UPG_ENTITY_TO_DOMAIN[name]` (the type's
 *     atomic-domain id, e.g. `'user'`, `'market_intelligence'`).
 *   - `maturity`: exact-match against `EntityTypeMeta.maturity`
 *     (`'draft' | 'proposed' | 'stable' | 'deprecated' | 'removed'`).
 *   - `deprecated`: boolean shortcut. `true` keeps only deprecated types;
 *     `false` excludes deprecated and removed types (the active set).
 *     Composes with `maturity` via AND, so when both are passed the row
 *     must satisfy both.
 *
 * @returns JSON: `{ total, count, next_cursor?, types: Array<EntityTypeMeta & { domain_id: string | null }> }`
 * @atomicity atomic (read-only)
 * @see get_entity_meta
 * @see get_entity_schema
 * @see list_type_labels
 * @see list_domains
 */
export const listEntityTypes: ToolHandler = (args): ToolResult => {
  const domain = args.domain as string | undefined
  const maturity = args.maturity as UPGEntityTypeMaturity | undefined
  const deprecated = args.deprecated as boolean | undefined
  const limit = clampLimit(args.limit, ENTITY_TYPES_DEFAULT_LIMIT, ENTITY_TYPES_MAX_LIMIT)
  const cursorOffset = decodeCursor(args.cursor)

  // UPG_ENTITY_TO_DOMAIN is keyed by canonical type name → atomic-domain id.
  const typeToDomain = UPG_ENTITY_TO_DOMAIN as Readonly<Record<string, string>>

  let pool: readonly EntityTypeMeta[] = UPG_ENTITY_META
  if (maturity) pool = pool.filter((m) => m.maturity === maturity)
  if (deprecated === true) {
    pool = pool.filter((m) => m.maturity === 'deprecated')
  } else if (deprecated === false) {
    pool = pool.filter((m) => m.maturity !== 'deprecated' && m.maturity !== 'removed')
  }
  if (domain) {
    pool = pool.filter((m) => typeToDomain[m.name] === domain)
  }

  const total = pool.length
  const slice = pool.slice(cursorOffset, cursorOffset + limit).map((m) => ({
    ...m,
    domain_id: typeToDomain[m.name] ?? null,
  }))
  const nextOffset = cursorOffset + slice.length
  const nextCursor = nextOffset < total ? encodeCursor(nextOffset) : undefined

  const body: Record<string, unknown> = {
    total,
    count: slice.length,
    types: slice,
  }
  if (nextCursor) body.next_cursor = nextCursor

  return text(JSON.stringify(body, null, 2))
}

/**
 * Return one canonical `EntityTypeMeta` record by entity type name, plus the
 * resolved `domain_id` (or `null` if the type has no atomic-domain mapping).
 *
 * @returns JSON: `EntityTypeMeta & { domain_id: string | null }`
 * @throws textError when `name` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see list_entity_types
 * @see get_type_label
 * @see get_entity_schema
 */
export const getEntityMeta: ToolHandler = (args): ToolResult => {
  const name = args.name as string | undefined
  if (!name) return textError('Missing required parameter: name')
  const meta = UPG_ENTITY_META_BY_NAME.get(name)
  if (!meta) return textError(`Unknown entity type: ${name}`)
  const typeToDomain = UPG_ENTITY_TO_DOMAIN as Readonly<Record<string, string>>
  return text(
    JSON.stringify({ ...meta, domain_id: typeToDomain[name] ?? null }, null, 2),
  )
}

// ── Anti-patterns ─────────────────────────────────────────────────

const ANTI_PATTERNS_DEFAULT_LIMIT = 50
const ANTI_PATTERNS_MAX_LIMIT = 200

/**
 * List the curated cross-domain anti-patterns from `UPG_ANTI_PATTERNS`. Each
 * row pairs a memorable name with a machine-evaluable
 * `IntelligenceCondition`, the stages where it can fire, severity, and
 * remediation. These are graph-health patterns evaluated against the
 * **whole graph**, distinct from per-domain anti-patterns surfaced via
 * `get_domain_guide`.
 *
 * Paginated (default `limit: 50`, max 200) to leave headroom as the
 * catalog grows.
 *
 * Filters AND together and apply **before** pagination so `total` reflects
 * the filtered count:
 *   - `severity`: exact-match against `UPGAntiPatternSeverity`
 *     (`'high' | 'medium' | 'low'`).
 *   - `stage`: keep only patterns whose `stages[]` includes the given
 *     `UPGProductStage` (e.g. `'concept'`, `'launch'`).
 *
 * @returns JSON: `{ total, count, next_cursor?, anti_patterns: UPGCuratedAntiPattern[] }`
 * @atomicity atomic (read-only)
 * @see get_anti_pattern
 * @see validate_graph
 * @see inspect
 * @see get_domain_guide
 */
export const listAntiPatterns: ToolHandler = (args): ToolResult => {
  const severity = args.severity as UPGAntiPatternSeverity | undefined
  const stage = args.stage as UPGProductStage | undefined
  const limit = clampLimit(args.limit, ANTI_PATTERNS_DEFAULT_LIMIT, ANTI_PATTERNS_MAX_LIMIT)
  const cursorOffset = decodeCursor(args.cursor)

  let pool: readonly UPGCuratedAntiPattern[] = UPG_ANTI_PATTERNS
  if (severity) pool = pool.filter((p) => p.severity === severity)
  if (stage) pool = pool.filter((p) => p.stages.includes(stage))

  const total = pool.length
  const slice = pool.slice(cursorOffset, cursorOffset + limit)
  const nextOffset = cursorOffset + slice.length
  const nextCursor = nextOffset < total ? encodeCursor(nextOffset) : undefined

  const body: Record<string, unknown> = {
    total,
    count: slice.length,
    anti_patterns: slice,
  }
  if (nextCursor) body.next_cursor = nextCursor

  return text(JSON.stringify(body, null, 2))
}

/**
 * Return one curated anti-pattern by id (kebab-case slug, e.g.
 * `'features-without-hypotheses'`, `'personas-without-jobs'`). Includes the
 * full body: structured condition, why-it-matters, remediation, applicable
 * stages, severity, and optional source citation.
 *
 * IDs are stable URL fragments and remain frozen once published.
 *
 * @returns JSON: `UPGCuratedAntiPattern`
 * @throws textError when `id` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see list_anti_patterns
 * @see inspect
 * @see validate_graph
 */
export const getAntiPattern: ToolHandler = (args): ToolResult => {
  const id = args.id as string | undefined
  if (!id) return textError('Missing required parameter: id')
  const pattern = UPG_ANTI_PATTERNS.find((p) => p.id === id)
  if (!pattern) return textError(`Unknown anti-pattern id: ${id}`)
  return text(JSON.stringify(pattern, null, 2))
}

// ── Benchmarks ────────────────────────────────────────────────────

/**
 * Return one of the four canonical benchmark catalogs, the data behind
 * `get_graph_digest`'s health logic. The `kind` parameter is **required**
 * and routes to the matching source:
 *   - `'count'` → `UPG_COUNT_BENCHMARKS`: per-entity-type expected ranges
 *     across the canonical 9-stage product journey.
 *   - `'relationship'` → `UPG_RELATIONSHIP_BENCHMARKS`: minimum
 *     parent → child connection counts per stage.
 *   - `'ratio'` → `UPG_RATIO_BENCHMARKS`: expected ratios between entity-type
 *     counts (e.g. learnings / hypotheses ≥ 1).
 *   - `'domain_activation'` → `UPG_DOMAIN_ACTIVATION`: when each atomic
 *     domain is expected to "turn on" across the journey.
 *
 * Optional filters AND together; applied **after** the kind routes to a
 * catalog (so `total` reflects the filtered count).
 *
 * @returns JSON: `{ kind, total, count, benchmarks: ... }`
 * @throws textError when `kind` is missing or not one of the four supported values.
 * @atomicity atomic (read-only)
 * @see get_graph_digest
 * @see list_product_stages
 * @see list_domains
 * @see list_anti_patterns
 */
export const listBenchmarks: ToolHandler = (args): ToolResult => {
  const kind = args.kind as string | undefined
  if (!kind) return textError('Missing required parameter: kind')
  const stage = args.stage as UPGProductStage | undefined
  const domain = args.domain as string | undefined
  const typeToDomain = UPG_ENTITY_TO_DOMAIN as Readonly<Record<string, string>>

  if (kind === 'count') {
    let pool: readonly CountBenchmark[] = UPG_COUNT_BENCHMARKS
    if (domain) pool = pool.filter((b) => b.domain === domain)
    if (stage) pool = pool.filter((b) => b[stage] !== null)
    return text(
      JSON.stringify(
        { kind, total: UPG_COUNT_BENCHMARKS.length, count: pool.length, benchmarks: pool },
        null,
        2,
      ),
    )
  }

  if (kind === 'relationship') {
    let pool: readonly RelationshipBenchmark[] = UPG_RELATIONSHIP_BENCHMARKS
    if (stage) pool = pool.filter((b) => b.stages.includes(stage))
    if (domain) {
      pool = pool.filter(
        (b) =>
          typeToDomain[b.parent_type] === domain || typeToDomain[b.child_type] === domain,
      )
    }
    return text(
      JSON.stringify(
        {
          kind,
          total: UPG_RELATIONSHIP_BENCHMARKS.length,
          count: pool.length,
          benchmarks: pool,
        },
        null,
        2,
      ),
    )
  }

  if (kind === 'ratio') {
    let pool: readonly RatioBenchmark[] = UPG_RATIO_BENCHMARKS
    if (stage) pool = pool.filter((b) => b.stages.includes(stage))
    if (domain) {
      pool = pool.filter((b) => {
        const num = Array.isArray(b.numerator_type) ? b.numerator_type : [b.numerator_type]
        const den = Array.isArray(b.denominator_type) ? b.denominator_type : [b.denominator_type]
        return [...num, ...den].some((t) => typeToDomain[t] === domain)
      })
    }
    return text(
      JSON.stringify(
        { kind, total: UPG_RATIO_BENCHMARKS.length, count: pool.length, benchmarks: pool },
        null,
        2,
      ),
    )
  }

  if (kind === 'domain_activation') {
    let pool: readonly DomainActivation[] = UPG_DOMAIN_ACTIVATION
    if (domain) pool = pool.filter((b) => b.domain_id === domain)
    if (stage) {
      pool = pool.filter((b) => b.expected_from === stage || b.expected_mature === stage)
    }
    return text(
      JSON.stringify(
        {
          kind,
          total: UPG_DOMAIN_ACTIVATION.length,
          count: pool.length,
          benchmarks: pool,
        },
        null,
        2,
      ),
    )
  }

  return textError(
    `Unknown kind: ${kind}. Expected one of: count, relationship, ratio, domain_activation.`,
  )
}

// ── Product stages ────────────────────────────────────────────────

/**
 * Return the canonical 9-stage product journey from `UPG_PRODUCT_STAGES`:
 * the closed enum used by `create_product`, `get_graph_digest` health logic,
 * benchmark stage scoping, and anti-pattern stage filters.
 *
 * Order is canonical: earliest → latest (`concept`, `validation`, `build`,
 * `beta`, `launch`, `growth`, `mature`, `maintenance`, `sunset`).
 *
 * @returns JSON: `{ count, stages: readonly UPGProductStage[] }`
 * @atomicity atomic (read-only)
 * @see list_benchmarks
 * @see list_anti_patterns
 * @see create_product
 */
export const listProductStages: ToolHandler = (): ToolResult => {
  return text(
    JSON.stringify(
      { count: UPG_PRODUCT_STAGES.length, stages: UPG_PRODUCT_STAGES },
      null,
      2,
    ),
  )
}

// ── Spec introspection round 5 ──────────────────────────

// ── Migrations ──────────────────────────────────────────────────────────────

/**
 * List every type rename migration from `UPG_MIGRATIONS`: the version-scoped
 * map of deprecated `from` → canonical `to` renames (e.g. `pain_point → need`,
 * `hypothesis → hypothesis_claim`).
 *
 * Each row carries `{ from, to, since }` where `since` is the spec version
 * that introduced the migration. Optional `from_type` filter exact-matches
 * on the `from` field (useful for adopters checking whether a specific
 * legacy type is covered).
 *
 * @returns JSON: `{ migrations: [{ from, to, since }], total: number }`
 * @atomicity atomic (read-only)
 * @see list_edge_migrations
 * @see list_split_migrations
 * @see migrate_type
 * @see validate_graph
 * @see list_entity_types
 */
export const listTypeMigrations: ToolHandler = (args): ToolResult => {
  const fromType = args.from_type as string | undefined

  const migrations: Array<{ from: string; to: string; since: string }> = []
  for (const [since, entries] of Object.entries(UPG_MIGRATIONS)) {
    for (const m of entries) {
      if (!fromType || m.from === fromType) {
        migrations.push({ from: m.from, to: m.to, since })
      }
    }
  }

  return text(JSON.stringify({ migrations, total: migrations.length }, null, 2))
}

/**
 * List every edge-key migration from `UPG_EDGE_MIGRATIONS`: the
 * version-scoped map of renamed or dropped edge type keys (e.g.
 * `persona_has_jtbd → persona_pursues_job`).
 *
 * Each row carries `{ kind, from, to?, since }` where `kind` is `'rename'` or
 * `'drop'`. Optional `from_edge` filter exact-matches on the `from` field.
 *
 * @returns JSON: `{ migrations: [{ kind, from, to?, since }], total: number }`
 * @atomicity atomic (read-only)
 * @see list_type_migrations
 * @see list_split_migrations
 * @see rename_edge_type
 * @see list_edge_types
 * @see validate_graph
 */
export const listEdgeMigrations: ToolHandler = (args): ToolResult => {
  const fromEdge = args.from_edge as string | undefined

  const migrations: Array<{ kind: string; from: string; to?: string; since: string }> = []
  for (const [since, entries] of Object.entries(UPG_EDGE_MIGRATIONS)) {
    for (const m of entries) {
      if (!fromEdge || m.from === fromEdge) {
        migrations.push({
          kind: m.kind,
          from: m.from,
          ...(m.kind === 'rename' ? { to: m.to } : {}),
          since,
        })
      }
    }
  }

  return text(JSON.stringify({ migrations, total: migrations.length }, null, 2))
}

/**
 * List every 1→N split migration from `UPG_SPLIT_MIGRATIONS`: the
 * version-scoped registry of "one type became multiple types" rules (e.g.
 * `experiment → experiment_plan + experiment_run`, `hypothesis →
 * hypothesis_claim + hypothesis_evidence`).
 *
 * Each row carries the full `UPGSplitMigration` record plus `since` (the
 * introducing spec version). No filter arguments: the catalog is small
 * (≤ a handful of entries) and non-paginated.
 *
 * @returns JSON: `{ splits: [...], total: number }`
 * @atomicity atomic (read-only)
 * @see list_type_migrations
 * @see list_edge_migrations
 * @see migrate_type
 * @see validate_graph
 */
export const listSplitMigrations: ToolHandler = (): ToolResult => {
  const splits: Array<Record<string, unknown>> = []
  for (const [since, entries] of Object.entries(UPG_SPLIT_MIGRATIONS)) {
    for (const m of entries) {
      splits.push({ ...m, since })
    }
  }

  return text(JSON.stringify({ splits, total: splits.length }, null, 2))
}

// ── Lifecycles ──────────────────────────────────────────────────────────────

/**
 * List lifecycle definitions from `UPG_LIFECYCLES`.
 *
 * Top-level response includes `lifecycles`, `free_types` (from
 * `UPG_LIFECYCLE_FREE_TYPES`: static types with no phase progression),
 * and `planned_types` (from `UPG_LIFECYCLE_PLANNED_TYPES`: lifecycle
 * planned but not yet authored). Filters: `entity_type` (exact-match);
 * `lifecycle_only` (when true, omits free/planned lists).
 *
 * @returns JSON: `{ lifecycles, total, free_types: string[], planned_types: string[] }`
 * @atomicity atomic (read-only)
 * @see get_lifecycle
 * @see list_entity_types
 * @see get_entity_meta
 */
export const listLifecycles: ToolHandler = (args): ToolResult => {
  const entityType = args.entity_type as string | undefined
  const lifecycleOnly = args.lifecycle_only as boolean | undefined

  let pool: readonly UPGLifecycle[] = UPG_LIFECYCLES
  if (entityType) pool = pool.filter((l) => l.entity_type === entityType)

  // When `lifecycle_only` is true, omit the free/planned blocks
  // entirely (matches the wire-shape `description`). The earlier version
  // returned empty arrays, which added wire bloat for callers asking for
  // lifecycle-only output.
  return text(
    JSON.stringify(
      {
        total: pool.length,
        lifecycles: pool,
        ...(lifecycleOnly === true
          ? {}
          : {
              free_types: Array.from(UPG_LIFECYCLE_FREE_TYPES).sort(),
              planned_types: Array.from(UPG_LIFECYCLE_PLANNED_TYPES).sort(),
            }),
      },
      null,
      2,
    ),
  )
}

/**
 * Return the full `UPGLifecycle` definition for one entity type: initial
 * phase, terminal phases, and the ordered array of phases with their
 * transitions and core states. Returns a descriptive text message (not an
 * error) when the type is lifecycle-free or lifecycle-planned.
 *
 * @returns JSON: the full `UPGLifecycle` record, or a descriptive message.
 * @throws textError when `entity_type` is missing, lifecycle-free,
 *   lifecycle-planned, or unknown.
 * @atomicity atomic (read-only)
 * @see list_lifecycles
 * @see get_entity_meta
 * @see get_entity_schema
 */
export const getLifecycle: ToolHandler = (args): ToolResult => {
  const entityType = args.entity_type as string | undefined
  if (!entityType) return textError('Missing required parameter: entity_type')
  const lifecycle = UPG_LIFECYCLES.find((l) => l.entity_type === entityType)
  if (!lifecycle) {
    if (UPG_LIFECYCLE_FREE_TYPES.has(entityType)) {
      return textError(`No lifecycle defined for entity type: ${entityType} (lifecycle-free: static type with no phase progression)`)
    }
    if (UPG_LIFECYCLE_PLANNED_TYPES.has(entityType)) {
      return textError(`No lifecycle defined for entity type: ${entityType} (lifecycle planned but not yet authored in this spec version)`)
    }
    return textError(`No lifecycle defined for entity type: ${entityType}`)
  }
  return text(JSON.stringify(lifecycle, null, 2))
}

/**
 * List the valid `status` values a node of `entity_type` can hold — the
 * pre-flight lookup batch-6 #35 asked for, so an author no longer learns the
 * set only by submitting a wrong one and reading the reject. For a
 * lifecycle-bearing type, returns each phase as a status value (with label +
 * `terminal` flag), the `initial_status`, and the `terminal_statuses`. For an
 * intentionally lifecycle-free type, returns `lifecycle_free: true` with an
 * empty `values` (status is not state-machine-validated). Sources
 * `UPG_LIFECYCLES` — exactly what the write validator checks — so it is the
 * focused, low-token sibling of `get_lifecycle` / `get_entity_schema`.
 *
 * @returns JSON: `{ entity_type, lifecycle_free, initial_status?, terminal_statuses?, values: [{ status, label, terminal }], note? }`.
 * @atomicity atomic (read-only)
 * @see get_lifecycle
 * @see get_entity_schema
 */
export const listStatusValues: ToolHandler = (args): ToolResult => {
  const entityType = args.entity_type as string | undefined
  if (!entityType) return textError('Missing required parameter: entity_type')
  const lifecycle = UPG_LIFECYCLES.find((l) => l.entity_type === entityType)
  if (!lifecycle) {
    const free = UPG_LIFECYCLE_FREE_TYPES.has(entityType)
    const planned = UPG_LIFECYCLE_PLANNED_TYPES.has(entityType)
    return text(
      JSON.stringify(
        {
          entity_type: entityType,
          lifecycle_free: free,
          values: [],
          note: free
            ? `${entityType} is lifecycle-free: status is not state-machine-validated (a static type with no phase progression).`
            : planned
              ? `${entityType} has a lifecycle planned but not yet authored in this spec version.`
              : `No lifecycle defined for entity type: ${entityType}.`,
        },
        null,
        2,
      ),
    )
  }
  const terminal = new Set(lifecycle.terminal_phases)
  return text(
    JSON.stringify(
      {
        entity_type: entityType,
        lifecycle_free: false,
        initial_status: lifecycle.initial_phase,
        terminal_statuses: lifecycle.terminal_phases,
        values: lifecycle.phases.map((p) => ({
          status: p.id,
          label: p.label,
          terminal: terminal.has(p.id),
        })),
      },
      null,
      2,
    ),
  )
}

// ── Scales ──────────────────────────────────────────────────────────────────

/**
 * List every spec-defined assessment scale from `UPG_SCALES`. Scales define
 * the vocabulary for human judgments stored as `UPGAssessment` values:
 * numeric encoding, qualitative labels, and per-point descriptions.
 *
 * Non-paginated (the catalog is small). External scales in
 * `scale_extensions` are graph-instance–scoped and stay outside this
 * surface.
 *
 * @returns JSON: `{ scales: UPGScaleDefinition[], total: number }`
 * @atomicity atomic (read-only)
 * @see get_scale
 * @see get_entity_schema
 */
export const listScales: ToolHandler = (): ToolResult => {
  const scales: UPGScaleDefinition[] = Object.values(UPG_SCALES)
  return text(JSON.stringify({ scales, total: scales.length }, null, 2))
}

/**
 * Return one spec-defined assessment scale by id (e.g. `'reach_5'`,
 * `'severity_5'`).
 *
 * @returns JSON: the full `UPGScaleDefinition` record including all points.
 * @throws textError when `id` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see list_scales
 * @see get_entity_schema
 */
export const getScale: ToolHandler = (args): ToolResult => {
  const id = args.id as string | undefined
  if (!id) return textError('Missing required parameter: id')
  const scale = UPG_SCALES[id]
  if (!scale) return textError(`Scale not found: ${id}`)
  return text(JSON.stringify(scale, null, 2))
}

// ── Framework metadata ────────────────────────────────────────────

/**
 * List all valid framework category values from `UPG_FRAMEWORK_CATEGORIES`.
 * Use as valid values for the `category` filter on `list_frameworks`.
 *
 * @returns JSON: `{ categories: string[], total: number }`
 * @atomicity atomic (read-only)
 * @see list_frameworks
 * @see list_framework_structure_patterns
 */
export const listFrameworkCategories: ToolHandler = (): ToolResult => {
  return text(
    JSON.stringify(
      { categories: UPG_FRAMEWORK_CATEGORIES, total: UPG_FRAMEWORK_CATEGORIES.length },
      null,
      2,
    ),
  )
}

/**
 * List all valid framework structure pattern values from
 * `UPG_STRUCTURE_PATTERNS` (tree, table, matrix, funnel, collection,
 * quadrant, flow). Mirrors `UPGFramework.structure.pattern`.
 *
 * @returns JSON: `{ patterns: string[], total: number }`
 * @atomicity atomic (read-only)
 * @see list_frameworks
 * @see list_framework_categories
 * @see get_framework
 */
export const listFrameworkStructurePatterns: ToolHandler = (): ToolResult => {
  return text(
    JSON.stringify(
      { patterns: UPG_STRUCTURE_PATTERNS, total: UPG_STRUCTURE_PATTERNS.length },
      null,
      2,
    ),
  )
}

// ── Domain rings ──────────────────────────────────────────────────

/**
 * List every `UPGDomainRing` from `UPG_DOMAIN_RINGS` in canonical order
 * (Nucleus → Understand → Define → Build → Grow → Operate → Extend). Rings
 * are the 7 concentric groupings of the 36 UPG atomic domains.
 *
 * @returns JSON: `{ rings: UPGDomainRing[], total: number }`
 * @atomicity atomic (read-only)
 * @see get_domain_ring
 * @see list_domains
 * @see get_domain_guide
 */
export const listDomainRings: ToolHandler = (): ToolResult => {
  return text(
    JSON.stringify(
      { rings: UPG_DOMAIN_RINGS, total: UPG_DOMAIN_RINGS.length },
      null,
      2,
    ),
  )
}

/**
 * Return one `UPGDomainRing` by id (e.g. `'nucleus'`, `'understand'`,
 * `'define'`, `'build'`, `'grow'`, `'operate'`, `'extend'`).
 *
 * @returns JSON: the full `UPGDomainRing` record.
 * @throws textError when `id` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see list_domain_rings
 * @see list_domains
 * @see get_domain_guide
 */
export const getDomainRing: ToolHandler = (args): ToolResult => {
  const id = args.id as string | undefined
  if (!id) return textError('Missing required parameter: id')
  const ring: UPGDomainRing | undefined = UPG_DOMAIN_RINGS.find((r) => r.id === id)
  if (!ring) return textError(`Domain ring not found: ${id}`)
  return text(JSON.stringify(ring, null, 2))
}
