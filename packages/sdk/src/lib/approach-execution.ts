/**
 * Approach execution helpers: pure functions powering the five approach
 * verb tools (`plan`, `inspect`, `prioritise`, `trace`, `reflect`).
 *
 * Each helper consumes the live graph (via `UPGFileStore`) plus the spec
 * catalog and emits a concrete structured projection. The verb handlers in
 * `tools/spec.ts` are thin wrappers that validate inputs, call into here,
 * and wrap the result in the family-resemblance envelope.
 *
 * Why a separate module:
 *   - Keeps `tools/spec.ts` slim; handler authoring stays declarative.
 *   - Lets the executors be unit-tested directly without the MCP envelope.
 *   - Provides a clear contract: every function returns the structured
 *     projection the verb's `signature_hint` documents.
 */

import {
  UPG_DOMAIN_GUIDES,
  UPG_REGION_MAP,
  UPG_REGIONS,
  UPG_ENTITY_TO_DOMAIN,
  UPG_ANTI_PATTERNS,
  getRegionForEntityType,
  resolveContainmentEdge,
  type UPGEdgeType,
  type UPGEntityType,
} from '@unified-product-graph/core'
import { evaluateExpression } from './expression.js'
import type { UPGFileStore } from '../store.js'
import type { UPGFramework } from '@unified-product-graph/frameworks'

// ─── prioritise ──────────────────────────────────────────────────────────────

export interface PrioritiseRankedRow {
  entity_id: string
  /** Numeric score; null when the formula could not be evaluated. */
  score: number | null
  /** Human-readable explanation: formula + substituted values or failure reason. */
  rationale: string
  /** When score is null, the missing property keys that prevented evaluation. */
  missing_properties?: string[]
}

export interface PrioritiseExecutionResult {
  kind: 'execution'
  ranked: PrioritiseRankedRow[]
  framework_used: { id: string; name: string; category: string; expression: string }
  /** Properties the formula consumed (variable identifiers). */
  required_properties: string[]
}

export interface PrioritiseFallbackResult {
  kind: 'fallback'
  framework_used: { id: string; name: string; category: string }
  /** Why we couldn't execute (no computed expression, etc.). */
  hint: string
}

export interface PrioritiseTypeMismatchResult {
  kind: 'type_mismatch'
  framework_used: { id: string; name: string; category: string }
  /** The entity type(s) the framework scores. */
  target_entity_types: string[]
  /** Per-candidate type breakdown for the mismatching candidates. */
  mismatched: Array<{ entity_id: string; entity_type: string }>
  /** Clear, actionable explanation. */
  hint: string
}

/**
 * Resolve the entity type(s) a framework's scoring is defined over.:
 * a framework's computed expression is written against ONE entity type's
 * properties (RICE → feature.reach/impact/confidence/effort). Running it on a
 * candidate of a different type produced a confusing "Division by zero" when a
 * property happened to be missing/zero. We read the target type from the most
 * precise source first:
 *   1. `data.computed_properties[].entity_type` (the type the formula scores)
 *   2. `data.required_properties` keys
 *   3. `data.entity_types[].type`
 * Returns the de-duplicated set, or `[]` when the framework declares none
 * (then we skip the guard and compute permissively).
 */
export function frameworkTargetTypes(framework: UPGFramework): string[] {
  const out = new Set<string>()
  const data = framework.data as
    | {
        computed_properties?: Array<{ entity_type?: string }>
        required_properties?: Record<string, unknown>
        entity_types?: Array<{ type?: string }>
      }
    | undefined
  for (const c of data?.computed_properties ?? []) {
    if (typeof c.entity_type === 'string' && c.entity_type) out.add(c.entity_type)
  }
  if (out.size === 0 && data?.required_properties) {
    for (const k of Object.keys(data.required_properties)) out.add(k)
  }
  if (out.size === 0) {
    for (const e of data?.entity_types ?? []) {
      if (typeof e.type === 'string' && e.type) out.add(e.type)
    }
  }
  return [...out]
}

/**
 * Execute a framework's first numeric `computed_properties` expression over a
 * candidate set. Returns either ranked rows (when the framework defines an
 * expression) or a fallback envelope (when it doesn't; caller should
 * surface the framework's slots / classification as LLM substrate).
 *
 * Resolution per candidate:
 *   - Look up the node in the store; missing nodes get `score: null` with a
 *     "node not found" rationale.
 *   - Resolve each identifier in the expression as a numeric property:
 *     `node.properties[key]` (coerced via Number()). Top-level numeric fields
 *     like `node.title` are NOT consulted; formulas address property keys.
 *   - Evaluate via `evaluateExpression`; on success append to ranked with the
 *     computed score; on failure record the missing variables.
 *
 * Sort: numeric desc, with nulls last (preserves input order among null rows).
 */
export function executePrioritise(
  framework: UPGFramework,
  candidateIds: string[],
  store: UPGFileStore,
  opts: { exerciseId?: string } = {},
): PrioritiseExecutionResult | PrioritiseFallbackResult | PrioritiseTypeMismatchResult {
  // Exercise-aware (0.8.4): when an exercise is given, each candidate's inputs
  // come from its `framework_exercise_includes_node` edge properties (the
  // exercise's recorded answers), not from `node.properties`. Entities that were
  // deliberately included in an exercise also bypass the target-type guard —
  // the whole point of the exercise model is that any entity type can be scored.
  let ids = candidateIds
  let edgeInputs: Map<string, Record<string, unknown>> | null = null
  if (opts.exerciseId) {
    edgeInputs = new Map()
    for (const e of store.getEdgesForNode(opts.exerciseId)) {
      if (e.type === 'framework_exercise_includes_node' && e.source === opts.exerciseId) {
        edgeInputs.set(e.target, (e.properties as Record<string, unknown>) ?? {})
      }
    }
    if (ids.length === 0) ids = [...edgeInputs.keys()]
  }

  // (Seam 5): validate candidate types against the framework's target
  // BEFORE computing. RICE scores `feature`; given `opportunity` candidates the
  // formula either silently scores the wrong type or — when a divisor property
  // is missing — emits a baffling "Division by zero". Reject loud with a clear
  // message instead. (The schema/entity decision of WHICH properties belong on
  // WHICH type is, Captain's call; this guard is correct regardless.)
  const targetTypes = frameworkTargetTypes(framework)
  if (!opts.exerciseId && targetTypes.length > 0 && ids.length > 0) {
    const mismatched: Array<{ entity_id: string; entity_type: string }> = []
    for (const id of ids) {
      const node = store.getNode(id)
      if (!node) continue // missing nodes handled in the compute loop below
      if (!targetTypes.includes(node.type as string)) {
        mismatched.push({ entity_id: id, entity_type: node.type as string })
      }
    }
    // Reject only when EVERY resolvable candidate is the wrong type; a mixed
    // set still computes the matching ones and reports the rest as missing
    // properties (existing behaviour) rather than failing the whole call.
    const resolvable = ids.map((id) => store.getNode(id)).filter(Boolean).length
    if (resolvable > 0 && mismatched.length === resolvable) {
      const byType = new Map<string, number>()
      for (const m of mismatched) byType.set(m.entity_type, (byType.get(m.entity_type) ?? 0) + 1)
      const breakdown = [...byType.entries()]
        .map(([t, n]) => `${n} ${t}`)
        .join(', ')
      return {
        kind: 'type_mismatch',
        framework_used: {
          id: framework.id,
          name: framework.name,
          category: framework.category,
        },
        target_entity_types: targetTypes,
        mismatched,
        hint:
          `${framework.id} scores ${targetTypes.join(' / ')}; ` +
          `${breakdown} candidate(s) are a different type. ` +
          `Pass ${targetTypes.join('/')} candidates, use a framework that targets ${[...byType.keys()].join('/')}, ` +
          `or run a framework_exercise over them (apply_framework / 'upg apply', then prioritise with exercise_id) ` +
          `to score any entity type from the exercise's edges.`,
      }
    }
  }

  const computed = framework.data?.computed_properties?.[0]
  if (!computed || typeof computed.expression !== 'string' || computed.expression.length === 0) {
    return {
      kind: 'fallback',
      framework_used: {
        id: framework.id,
        name: framework.name,
        category: framework.category,
      },
      hint:
        `Framework "${framework.id}" has no computed_properties expression. ` +
        `It defines structural slots (${framework.slots?.length ?? 0}) and an education layer. ` +
        `Use get_framework to read its scoring guidance, then synthesise rankings manually.`,
    }
  }

  const ranked: PrioritiseRankedRow[] = []
  // Probe the expression once with an empty scope to enumerate required
  // identifiers, used both for diagnostics and to compute the per-candidate
  // missing-property lists without re-tokenising.
  const probe = evaluateExpression(computed.expression, {})
  const requiredProperties =
    probe.ok === false && probe.missing ? probe.missing : []

  for (const id of ids) {
    const node = store.getNode(id)
    if (!node) {
      ranked.push({
        entity_id: id,
        score: null,
        rationale: `Entity not found in graph: ${id}`,
      })
      continue
    }

    const scope = collectNumericScope(edgeInputs ? (edgeInputs.get(id) ?? {}) : node.properties)
    const result = evaluateExpression(computed.expression, scope)

    if (result.ok) {
      ranked.push({
        entity_id: id,
        score: result.value,
        rationale: buildRationale(computed.expression, scope, result.value),
      })
    } else {
      ranked.push({
        entity_id: id,
        score: null,
        rationale: result.error,
        missing_properties: result.missing,
      })
    }
  }

  // Sort: numeric desc, nulls last with stable order.
  const withIndex = ranked.map((r, idx) => ({ r, idx }))
  withIndex.sort((a, b) => {
    if (a.r.score === null && b.r.score === null) return a.idx - b.idx
    if (a.r.score === null) return 1
    if (b.r.score === null) return -1
    return b.r.score - a.r.score
  })
  const sorted = withIndex.map((w) => w.r)

  return {
    kind: 'execution',
    ranked: sorted,
    framework_used: {
      id: framework.id,
      name: framework.name,
      category: framework.category,
      expression: computed.expression,
    },
    required_properties: requiredProperties,
  }
}

function collectNumericScope(
  properties: Record<string, unknown> | undefined,
): Record<string, number> {
  const scope: Record<string, number> = {}
  if (!properties) return scope
  for (const [k, v] of Object.entries(properties)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      scope[k] = v
    } else if (typeof v === 'string') {
      const n = Number.parseFloat(v)
      if (Number.isFinite(n)) scope[k] = n
    } else if (typeof v === 'boolean') {
      scope[k] = v ? 1 : 0
    }
  }
  return scope
}

function buildRationale(
  expression: string,
  scope: Record<string, number>,
  value: number,
): string {
  const usedVars = Object.entries(scope)
    .filter(([k]) => expression.includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
  const formatted = Number.isInteger(value) ? value.toString() : value.toFixed(4)
  if (usedVars.length === 0) {
    return `${expression} = ${formatted}`
  }
  return `${expression} = ${formatted}  (${usedVars})`
}

// ─── plan ────────────────────────────────────────────────────────────────────

export interface MissingEntityRow {
  entity_type: string
  domain: string | null
  /** Index in the domain guide's `creation_sequence` (lower = earlier). */
  position_in_sequence: number
  /** Anchor entity type for the domain (commonly the typical parent). */
  typical_parent_type: string | null
  hint: string
}

export interface PlanResult {
  missing_entities: MissingEntityRow[]
  /** Ratio of covered entity types to expected entity types. */
  coverage_score: number
  /** Total expected entity types in scope. */
  expected_count: number
  /** Number of expected types with at least one instance in the graph. */
  covered_count: number
  /** Region narrowed to, if any. */
  region: string | null
  /** How the expected set was scoped: which regions were counted. */
  scope: 'active_regions' | 'region' | 'exhaustive'
  /** The canonical region ids the expected set was drawn from. */
  scoped_regions: string[]
  /** Set when an explicit region/domain arg did not resolve. */
  error?: string
}

export interface PlanOptions {
  /**
   * Narrow to a single region OR atomic-domain id. Accepts canonical region
   * ids (e.g. `discovery_research_validation`) AND atomic-domain ids (e.g.
   * `discovery`); an unknown id returns a clear `error` rather than a silent
   * empty result.
   */
  region?: string
  /**
   * Score against the ENTIRE 320-type universe (every domain guide's creation
   * sequence). Off by default: whole-universe gap scoring is a token-bomb and
   * noise for a focused product. Without this, scope defaults to the product's
   * ACTIVE regions (every region that already has ≥1 entity).
   */
  exhaustive?: boolean
}

/**
 * Compute a missing-entity backlog from the graph's current coverage against
 * the canonical creation sequences (Seam 5).
 *
 * Scope (in precedence order):
 *   1. `region` set → just that region/domain (clear error if it doesn't resolve).
 *   2. `exhaustive: true` → every type across all domain guides (the full
 *      320-type universe; opt-in only).
 *   3. Default → the product's ACTIVE regions: every canonical region that
 *      already has at least one entity in the graph. This keeps `plan` aligned
 *      with `get_graph_digest`'s focused coverage instead of grading an
 *      idea-stage product against 292 missing types.
 *
 * Back-compat: the legacy `executePlan(store, regionId)` positional call still
 * works (the second arg is treated as `{ region }`).
 *
 * Ordering: missing entities are sorted by position in their domain's
 * `creation_sequence` (earlier types surface first).
 */
export function executePlan(
  store: UPGFileStore,
  options?: PlanOptions | string,
): PlanResult {
  const opts: PlanOptions =
    typeof options === 'string' ? { region: options } : (options ?? {})

  const typesPresent = new Set<string>()
  for (const node of store.getAllNodes()) {
    typesPresent.add(node.type as string)
  }

  // ── Resolve the scope into a set of atomic domains + a label ──────────────
  let scope: PlanResult['scope']
  let scopedRegions: string[]
  let domainsInScope: Set<string> | null // null = all domains (exhaustive)

  if (opts.region) {
    const resolved = resolveRegionOrDomain(opts.region)
    if (!resolved) {
      const regionIds = UPG_REGIONS.map((r) => r.id).join(', ')
      return {
        missing_entities: [],
        coverage_score: 0,
        expected_count: 0,
        covered_count: 0,
        region: opts.region,
        scope: 'region',
        scoped_regions: [],
        error:
          `Unknown region/domain "${opts.region}". ` +
          `Pass a canonical region id (one of: ${regionIds}) or an atomic-domain id.`,
      }
    }
    scope = 'region'
    scopedRegions = resolved.regionId ? [resolved.regionId] : []
    domainsInScope = new Set(resolved.domains)
  } else if (opts.exhaustive) {
    scope = 'exhaustive'
    scopedRegions = UPG_REGIONS.map((r) => r.id)
    domainsInScope = null
  } else {
    // Default: the product's ACTIVE regions (regions with ≥1 present type).
    const activeRegionIds = new Set<string>()
    for (const t of typesPresent) {
      let region
      try {
        region = getRegionForEntityType(t as UPGEntityType)
      } catch {
        region = undefined
      }
      if (region?.id) activeRegionIds.add(region.id as string)
    }
    scope = 'active_regions'
    scopedRegions = [...activeRegionIds]
    const domains = new Set<string>()
    for (const rid of activeRegionIds) {
      const region = UPG_REGION_MAP[rid]
      for (const d of region?.composes_atomic_domains ?? []) domains.add(d as string)
    }
    domainsInScope = domains
  }

  // Build the expected set + per-type metadata for the resolved domains.
  const expected = collectExpectedTypes(domainsInScope)

  const missing: MissingEntityRow[] = []
  let coveredCount = 0
  for (const exp of expected) {
    if (typesPresent.has(exp.entity_type)) {
      coveredCount++
      continue
    }
    missing.push(exp)
  }

  // Sort missing by position_in_sequence asc; ties broken by domain id, type id.
  missing.sort((a, b) => {
    if (a.position_in_sequence !== b.position_in_sequence) {
      return a.position_in_sequence - b.position_in_sequence
    }
    const ad = a.domain ?? ''
    const bd = b.domain ?? ''
    if (ad !== bd) return ad.localeCompare(bd)
    return a.entity_type.localeCompare(b.entity_type)
  })

  return {
    missing_entities: missing,
    coverage_score: expected.length === 0 ? 0 : coveredCount / expected.length,
    expected_count: expected.length,
    covered_count: coveredCount,
    region: opts.region ?? null,
    scope,
    scoped_regions: scopedRegions,
  }
}

/**
 * Resolve a user-supplied id to a set of atomic domains. Accepts either a
 * canonical region id (→ its `composes_atomic_domains`) or an atomic-domain id
 * (→ itself). Returns null when neither matches (clear error, not
 * silent empty).
 */
function resolveRegionOrDomain(
  id: string,
): { regionId?: string; domains: string[] } | null {
  const region = UPG_REGION_MAP[id]
  if (region) {
    return { regionId: id, domains: [...region.composes_atomic_domains] as string[] }
  }
  // Atomic-domain id? Accept it if any domain guide declares it.
  const isDomain = UPG_DOMAIN_GUIDES.some((g) => (g.domain_id as string) === id)
  if (isDomain) return { domains: [id] }
  return null
}

interface ExpectedTypeRow {
  entity_type: string
  domain: string | null
  position_in_sequence: number
  typical_parent_type: string | null
  hint: string
}

/**
 * Build the expected-type rows for a set of atomic domains. `null` means "all
 * domains" (the exhaustive universe). Scope resolution (region/domain id →
 * domain set, active-region defaulting) is the caller's job (`executePlan`).
 */
function collectExpectedTypes(domainsInScope: Set<string> | null): ExpectedTypeRow[] {
  const rows: ExpectedTypeRow[] = []
  const seen = new Set<string>()

  for (const guide of UPG_DOMAIN_GUIDES) {
    if (domainsInScope && !domainsInScope.has(guide.domain_id as string)) {
      continue
    }
    const anchorType = guide.anchor_entity as string
    guide.creation_sequence.forEach((type, idx) => {
      const key = type as string
      if (seen.has(key)) return
      seen.add(key)
      rows.push({
        entity_type: key,
        domain: guide.domain_id as string,
        position_in_sequence: idx,
        typical_parent_type: idx === 0 ? null : anchorType,
        hint: buildPlanHint(key, idx, guide.domain_id as string, anchorType),
      })
    })
  }

  return rows
}

function buildPlanHint(
  type: string,
  position: number,
  domain: string,
  anchor: string,
): string {
  if (position === 0) {
    return `Author the anchor ${type} for the ${domain} domain; everything else hangs from it.`
  }
  return `Add ${type} (step ${position + 1} in the ${domain} sequence; typically attached under ${anchor}).`
}

// ─── inspect ─────────────────────────────────────────────────────────────────

export interface InspectViolation {
  severity: 'high' | 'medium' | 'low' | 'unknown'
  kind:
    | 'anti_pattern'
    | 'entity_drift'
    | 'edge_drift'
    | 'lifecycle_drift'
    | 'property_drift'
    | 'self_referential'
    | 'top_level_drift'
  entity_id?: string
  description: string
  fix_hint: string
  /** Source id (anti-pattern id, migration via, etc.) for traceability. */
  source?: string
}

export interface InspectResult {
  violations: InspectViolation[]
  scope: { region: string | null; entities: string[] | null }
  /** Counts of violation kinds for quick triage. */
  summary: Record<string, number>
}

/**
 * Wrap `validate_graph` + `get_anti_pattern_violations_for` into a single
 * inspect projection: a flat, severity-ordered violations array plus a kind
 * count map. The scope filter narrows by region (drop violations whose target
 * type isn't in the region) or by entities (drop violations whose
 * `target_entities` don't include any node-of-interest's type, and drift rows
 * whose id isn't in the candidate set).
 */
export function executeInspect(
  validateResult: ValidateGraphBody,
  scope: { region?: string; entities?: string[] },
): InspectResult {
  const region = scope.region ?? null
  const entities = scope.entities ?? null

  const regionEntityTypes = region ? getRegionEntityTypes(region) : null
  const entitySet = entities ? new Set(entities) : null

  const violations: InspectViolation[] = []

  // Anti-pattern violations
  for (const v of validateResult.anti_pattern_violations ?? []) {
    if (
      regionEntityTypes &&
      !v.target_entities?.some((t) => regionEntityTypes.has(t))
    ) {
      continue
    }
    if (
      entitySet &&
      !v.target_entities?.some((t) => entityTypesIntersect(entitySet, t))
    ) {
      continue
    }
    violations.push({
      severity: v.severity ?? 'unknown',
      kind: 'anti_pattern',
      description: `${v.name}: ${v.description ?? v.why_it_matters ?? ''}`,
      fix_hint: v.remediation ?? 'See list_anti_patterns for guidance.',
      source: v.anti_pattern_id,
    })
  }

  // Drift rows from validate_graph: wrap each into the unified shape.
  for (const drift of validateResult.entity_drift ?? []) {
    if (entitySet && !entitySet.has(drift.id)) continue
    if (regionEntityTypes && !regionEntityTypes.has(drift.type)) continue
    violations.push({
      severity: 'medium',
      kind: 'entity_drift',
      entity_id: drift.id,
      description: `Entity type "${drift.type}" is deprecated`,
      fix_hint: driftFixHint(drift.suggested_migration),
      source: drift.suggested_migration?.via,
    })
  }

  for (const drift of validateResult.edge_drift ?? []) {
    if (entitySet && !entitySet.has(drift.source) && !entitySet.has(drift.target)) continue
    violations.push({
      severity: 'medium',
      kind: 'edge_drift',
      entity_id: drift.id,
      description: `Edge type "${drift.type}" is deprecated`,
      fix_hint: driftFixHint(drift.suggested_migration),
      source: drift.suggested_migration?.via,
    })
  }

  for (const drift of validateResult.lifecycle_drift ?? []) {
    if (entitySet && !entitySet.has(drift.id)) continue
    if (regionEntityTypes && !regionEntityTypes.has(drift.type)) continue
    violations.push({
      severity: 'medium',
      kind: 'lifecycle_drift',
      entity_id: drift.id,
      description: `Status "${drift.status}" not in lifecycle phases for ${drift.type}`,
      fix_hint: `Valid phases: ${drift.valid_phases.join(', ')}. Update via update_node.`,
    })
  }

  for (const drift of validateResult.property_drift ?? []) {
    if (entitySet && !entitySet.has(drift.id)) continue
    if (regionEntityTypes && !regionEntityTypes.has(drift.type)) continue
    violations.push({
      severity: 'low',
      kind: 'property_drift',
      entity_id: drift.id,
      description: `Property "${drift.property}" needs migration on ${drift.type}`,
      fix_hint: `Run migrate_properties to lift/drop. Source: ${drift.via}.`,
      source: drift.via,
    })
  }

  for (const drift of validateResult.self_referential ?? []) {
    if (entitySet && !entitySet.has(drift.id)) continue
    violations.push({
      severity: 'low',
      kind: 'self_referential',
      entity_id: drift.id,
      description: `Self-referential fields detected: ${drift.fields.join(', ')}`,
      fix_hint: 'Drop the self-referential source_id / source_type via update_node.',
    })
  }

  for (const drift of validateResult.top_level_drift ?? []) {
    if (entitySet && !entitySet.has(drift.id)) continue
    if (regionEntityTypes && !regionEntityTypes.has(drift.type)) continue
    violations.push({
      severity: 'low',
      kind: 'top_level_drift',
      entity_id: drift.id,
      description: `Unknown top-level fields: ${drift.unknown_fields.join(', ')}`,
      fix_hint: 'Move properties into the `properties` object.',
    })
  }

  // Sort: severity high → low; preserve insertion order within tier.
  const order: Record<string, number> = { high: 0, medium: 1, low: 2, unknown: 3 }
  const withIndex = violations.map((v, idx) => ({ v, idx }))
  withIndex.sort((a, b) => {
    const sd = (order[a.v.severity] ?? 4) - (order[b.v.severity] ?? 4)
    if (sd !== 0) return sd
    return a.idx - b.idx
  })

  const sorted = withIndex.map((w) => w.v)
  const summary: Record<string, number> = {}
  for (const v of sorted) {
    summary[v.kind] = (summary[v.kind] ?? 0) + 1
  }

  return {
    violations: sorted,
    scope: { region, entities },
    summary,
  }
}

function driftFixHint(
  migration: { kind: string; to?: string | string[]; via?: string; flip?: boolean } | undefined,
): string {
  if (!migration) return 'Run validate_graph for full details.'
  if (migration.kind === 'rename') {
    return `Run migrate_type to rename → "${String(migration.to)}". Source: ${migration.via ?? 'unknown'}.`
  }
  if (migration.kind === 'split') {
    return `Run migrate_type to split → [${(migration.to as string[]).join(', ')}]. Source: ${migration.via ?? 'unknown'}.`
  }
  if (migration.kind === 'drop') {
    return `Drop this edge; no canonical replacement. Source: ${migration.via ?? 'unknown'}.`
  }
  return 'No automated migration available; remove or update manually.'
}

function entityTypesIntersect(_entitySet: Set<string>, _type: string): boolean {
  // Phase 1: anti-pattern target_entities are TYPES not IDs (per evaluator.ts).
  // We can't tell whether an id-scoped set intersects a type-keyed pattern
  // without resolving every id's type; caller passes store to do that.
  // For now keep all anti-pattern violations when entity scope is given; they
  // get refined when target_entities migrates to ids in Phase 1.x.
  return true
}

function getRegionEntityTypes(regionId: string): Set<string> | null {
  const region = UPG_REGION_MAP[regionId]
  if (!region) return null
  return new Set(region.entities.map((e) => e.type))
}

// Subset of validate_graph's response shape; only what executeInspect needs.
// Local to avoid a hard import cycle with @unified-product-graph/mcp-tooling.
export interface ValidateGraphBody {
  anti_pattern_violations?: Array<{
    anti_pattern_id: string
    name: string
    severity: 'high' | 'medium' | 'low'
    target_entities: string[]
    description?: string
    why_it_matters?: string
    remediation?: string
  }>
  entity_drift?: Array<{
    id: string
    type: string
    suggested_migration?: { kind: string; to?: string | string[]; via?: string }
  }>
  edge_drift?: Array<{
    id: string
    type: string
    source: string
    target: string
    suggested_migration?: { kind: string; to?: string; via?: string; flip?: boolean }
  }>
  lifecycle_drift?: Array<{ id: string; type: string; status: string; valid_phases: string[] }>
  property_drift?: Array<{ id: string; type: string; property: string; via: string }>
  self_referential?: Array<{ id: string; fields: string[] }>
  top_level_drift?: Array<{ id: string; type: string; unknown_fields: string[] }>
}

// ─── trace ───────────────────────────────────────────────────────────────────

export interface TraceTrailRow {
  depth: number
  entity_id: string
  entity_type: string
  edge_type_in: string | null
}

export interface TraceResult {
  trail: TraceTrailRow[]
  reached: string[]
  /** Set when traversal halts early, e.g. no canonical edge for a hop. */
  error?: string
  /** Depth at which the trace halted, if it stopped early. */
  halted_at_depth?: number
}

/**
 * Walk a typed path starting from `anchor`.
 *
 * **`path` is the list of entity types to visit AFTER the anchor — NOT
 * including the anchor's own type** (Seam 5). Each element is one hop.
 * The walker resolves the canonical edge for `previousType → path[i]` (via
 * `resolveContainmentEdge`) unless `edgesOverride[i]` supplies an explicit edge
 * type. The anchor itself is depth 0 in the returned `trail`; `path[0]` is the
 * first hop (depth 1), `path[1]` the second (depth 2), and so on.
 *
 * @example
 * // From a persona anchor, walk persona → job → need:
 * executeTrace(store, personaId, ['job', 'need'])
 * // → trail: [persona(d0), job(d1), need(d2)]
 *
 * Do NOT include the anchor's own type as `path[0]` (e.g. `['persona', 'job',
 * 'need']` from a persona): that asks for a persona → persona self-hop, which
 * has no canonical edge, and the trace halts at depth 1. The documented form
 * is hops-after-anchor.
 *
 * Strategy is breadth-first per depth: at depth N+1 we walk every outgoing
 * edge of the resolved type whose target node matches `path[N]`. The trail
 * carries every reached node at every depth.
 *
 * Halts when no canonical edge can be resolved for a hop AND no override is
 * supplied; it returns a partial trail + `error` + `halted_at_depth`. This
 * gives the caller enough signal to either supply an override or rewrite
 * the path.
 */
export function executeTrace(
  store: UPGFileStore,
  anchor: string,
  path: string[],
  edgesOverride?: (string | null)[],
): TraceResult {
  const anchorNode = store.getNode(anchor)
  if (!anchorNode) {
    return {
      trail: [],
      reached: [],
      error: `Anchor entity not found: ${anchor}`,
      halted_at_depth: 0,
    }
  }

  const trail: TraceTrailRow[] = [
    {
      depth: 0,
      entity_id: anchor,
      entity_type: anchorNode.type as string,
      edge_type_in: null,
    },
  ]

  let frontier: Array<{ id: string; type: string }> = [
    { id: anchor, type: anchorNode.type as string },
  ]

  for (let i = 0; i < path.length; i++) {
    const nextType = path[i]
    if (frontier.length === 0) break

    // Determine the edge type for this hop. Override beats canonical resolver.
    // Note: with one hop per element, the override at index i applies to the
    // step from frontier (any type) → nextType.
    const overrideEdge = edgesOverride?.[i] ?? null
    let edgeType: string | null = overrideEdge
    let resolverError: string | null = null

    if (!edgeType) {
      // The frontier may carry mixed types after deeper hops, but path is
      // typed-shorthand, so all frontier entries share the SAME type at every
      // step. Use the first to resolve.
      const sourceType = frontier[0].type
      const resolved = resolveContainmentEdge(
        sourceType as UPGEntityType,
        nextType as UPGEntityType,
      )
      if (!resolved) {
        resolverError = `no canonical edge for ${sourceType} → ${nextType} at depth ${i + 1}`
      } else {
        edgeType = resolved
      }
    }

    if (!edgeType) {
      return {
        trail,
        reached: trail.map((t) => t.entity_id),
        error: resolverError ?? `no edge resolved at depth ${i + 1}`,
        halted_at_depth: i + 1,
      }
    }

    const nextFrontier: Array<{ id: string; type: string }> = []
    const seen = new Set<string>()
    for (const f of frontier) {
      const outgoing = store.getEdgesForNode(f.id)
      for (const e of outgoing) {
        if (e.source !== f.id) continue
        if ((e.type as string) !== edgeType) continue
        const target = store.getNode(e.target)
        if (!target) continue
        if ((target.type as string) !== nextType) continue
        if (seen.has(target.id)) continue
        seen.add(target.id)
        nextFrontier.push({ id: target.id, type: target.type as string })
        trail.push({
          depth: i + 1,
          entity_id: target.id,
          entity_type: target.type as string,
          edge_type_in: edgeType,
        })
      }
    }

    frontier = nextFrontier
  }

  return {
    trail,
    reached: trail.map((t) => t.entity_id),
  }
}

// ─── reflect ─────────────────────────────────────────────────────────────────

export type ReflectPromptKind =
  | 'assumption'
  | 'alternative'
  | 'blind_spot'
  | 'load_bearing'

export interface ReflectPrompt {
  kind: ReflectPromptKind
  question: string
  target_entities?: string[]
}

export interface ReflectResult {
  prompts: ReflectPrompt[]
  mode: string | null
  scope: string | null
}

/**
 * Emit structured reflection prompts based on graph topology + mode.
 *
 * - "assumptions": find entities of type `assumption` or drafted hypotheses;
 *   one prompt per entity asks the author to surface evidence / falsification.
 * - "alternatives": find parents with multiple siblings of the same type and
 *   prompt "did you consider…" alternatives.
 * - "blind-spots": find atomic domains with zero entities and prompt
 *   the author to explain why that surface is empty.
 * - "load-bearing": find entities with the highest incoming-edge counts and
 *   prompt "if this changes, what depends on it?"
 * - No mode (open): pick the most informative single category based on the
 *   graph's actual state; never empty unless the graph itself is empty.
 *
 * Prompts are capped at a sensible per-mode limit so the response stays
 * digestible; the agent calls again with a tighter mode if it wants more.
 *
 * Valid modes: `assumptions`, `alternatives`, `blind-spots`, `load-bearing`
 * (or `null`/omitted to run all four and return the top 3). (S-06): an
 * unrecognised mode now THROWS `ReflectModeError` listing the valid set, rather
 * than silently returning `prompts: []` (which read as a no-op feature).
 */
export const REFLECT_MODES = ['assumptions', 'alternatives', 'blind-spots', 'load-bearing'] as const
export type ReflectMode = (typeof REFLECT_MODES)[number]

export class ReflectModeError extends Error {
  readonly validModes: readonly string[]
  constructor(mode: string) {
    super(
      `Unknown reflect mode "${mode}". Valid modes: ${REFLECT_MODES.join(', ')} ` +
        `(or omit the mode to run all four and return the top 3).`,
    )
    this.name = 'ReflectModeError'
    this.validModes = REFLECT_MODES
  }
}

export function executeReflect(
  store: UPGFileStore,
  mode?: string,
  scope?: string | null,
): ReflectResult {
  // (S-06): reject unknown modes loud. `null`/undefined runs all four.
  if (mode !== undefined && mode !== null && !(REFLECT_MODES as readonly string[]).includes(mode)) {
    throw new ReflectModeError(mode)
  }

  const allNodes = store.getAllNodes()
  const allEdges = store.getAllEdges()

  if (allNodes.length === 0) {
    return {
      prompts: [
        {
          kind: 'blind_spot',
          question:
            'Your graph is empty. Start with a vision or anchor entity for the domain you want to model first.',
        },
      ],
      mode: mode ?? null,
      scope: scope ?? null,
    }
  }

  const modeNormalised = mode ?? null
  const prompts: ReflectPrompt[] = []

  if (modeNormalised === null || modeNormalised === 'assumptions') {
    prompts.push(...reflectAssumptions(allNodes, modeNormalised !== null))
  }
  if (modeNormalised === null || modeNormalised === 'alternatives') {
    prompts.push(...reflectAlternatives(allNodes, allEdges, modeNormalised !== null))
  }
  if (modeNormalised === null || modeNormalised === 'blind-spots') {
    prompts.push(...reflectBlindSpots(allNodes, modeNormalised !== null))
  }
  if (modeNormalised === null || modeNormalised === 'load-bearing') {
    prompts.push(...reflectLoadBearing(allNodes, allEdges, modeNormalised !== null))
  }

  // Open reflection: trim to the most informative 3 prompts overall.
  if (modeNormalised === null) {
    return {
      prompts: prompts.slice(0, 3),
      mode: null,
      scope: scope ?? null,
    }
  }

  return {
    prompts,
    mode: modeNormalised,
    scope: scope ?? null,
  }
}

function reflectAssumptions(
  nodes: ReadonlyArray<{ id: string; type: string; status?: string; title: string }>,
  detailed: boolean,
): ReflectPrompt[] {
  const matches = nodes.filter(
    (n) =>
      (n.type as string) === 'assumption' ||
      //: hypothesis folded onto VALIDATION; the pre-verdict initial
      // phase is `untested` (was `drafted`).
      ((n.type as string) === 'hypothesis' && n.status === 'untested') ||
      ((n.type as string) === 'hypothesis_claim' && n.status === 'untested'),
  )
  const limit = detailed ? 10 : 1
  return matches.slice(0, limit).map((m) => ({
    kind: 'assumption' as const,
    question: `What evidence would falsify "${m.title}"? Has anyone tested it?`,
    target_entities: [m.id],
  }))
}

function reflectAlternatives(
  nodes: ReadonlyArray<{ id: string; type: string; title: string }>,
  edges: ReadonlyArray<{ source: string; target: string; type: string }>,
  detailed: boolean,
): ReflectPrompt[] {
  // Group target nodes by (source, source_type, edge_type): siblings.
  const siblingMap = new Map<string, Array<{ id: string; type: string; title: string }>>()
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  for (const e of edges) {
    const target = nodeById.get(e.target)
    if (!target) continue
    const key = `${e.source}|${e.type}`
    let arr = siblingMap.get(key)
    if (!arr) {
      arr = []
      siblingMap.set(key, arr)
    }
    arr.push(target)
  }

  const prompts: ReflectPrompt[] = []
  const limit = detailed ? 5 : 1
  for (const [key, siblings] of siblingMap) {
    if (siblings.length < 2) continue
    if (prompts.length >= limit) break
    const [sourceId, edgeType] = key.split('|')
    prompts.push({
      kind: 'alternative',
      question: `${siblings.length} ${siblings[0].type}(s) link to one parent via ${edgeType}. Did you consider alternatives outside this set?`,
      target_entities: [sourceId, ...siblings.map((s) => s.id)],
    })
  }
  return prompts
}

function reflectBlindSpots(
  nodes: ReadonlyArray<{ type: string }>,
  detailed: boolean,
): ReflectPrompt[] {
  const presentDomains = new Set<string>()
  const domainCounts = new Map<string, number>()
  const typeToDomain = UPG_ENTITY_TO_DOMAIN as Readonly<Record<string, string>>
  for (const n of nodes) {
    const d = typeToDomain[n.type as string]
    if (!d) continue
    presentDomains.add(d)
    domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1)
  }

  // Total expected = every domain that has a usage guide (the "canonical
  // ring"). Empty domains are the blind spots.
  const expectedDomains = UPG_DOMAIN_GUIDES.map((g) => g.domain_id as string)

  const prompts: ReflectPrompt[] = []
  const limit = detailed ? 10 : 2
  for (const domain of expectedDomains) {
    if (presentDomains.has(domain)) continue
    if (prompts.length >= limit) break
    prompts.push({
      kind: 'blind_spot',
      question: `No entities in the "${domain}" domain; is that intentional or unmodeled?`,
    })
  }
  return prompts
}

function reflectLoadBearing(
  nodes: ReadonlyArray<{ id: string; type: string; title: string }>,
  edges: ReadonlyArray<{ source: string; target: string }>,
  detailed: boolean,
): ReflectPrompt[] {
  const incoming = new Map<string, number>()
  for (const e of edges) {
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1)
  }
  const ranked = [...nodes]
    .map((n) => ({ n, count: incoming.get(n.id) ?? 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)

  const limit = detailed ? 5 : 1
  return ranked.slice(0, limit).map((r) => ({
    kind: 'load_bearing' as const,
    question: `"${r.n.title}" has ${r.count} incoming edge(s). If it changes, what depends on it?`,
    target_entities: [r.n.id],
  }))
}

// Re-export for tests
export { UPG_ANTI_PATTERNS, UPG_REGIONS }
