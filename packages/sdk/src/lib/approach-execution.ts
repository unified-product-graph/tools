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
  resolveContainmentEdge,
  type UPGRegion,
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
): PrioritiseExecutionResult | PrioritiseFallbackResult {
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

  for (const id of candidateIds) {
    const node = store.getNode(id)
    if (!node) {
      ranked.push({
        entity_id: id,
        score: null,
        rationale: `Entity not found in graph: ${id}`,
      })
      continue
    }

    const scope = collectNumericScope(node.properties)
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
}

/**
 * Compute a missing-entity backlog from the graph's current coverage against
 * the canonical creation sequences.
 *
 * When `region` is provided, the expected set is that region's entity
 * memberships. When omitted, the expected set is every type listed across all
 * domain guides' creation sequences (the union, that's the "whole-graph"
 * planning surface).
 *
 * Ordering: missing entities are sorted by position in their domain's
 * `creation_sequence` (earlier types surface first) so the agent always sees
 * the foundational gaps before the late-stage ones.
 */
export function executePlan(store: UPGFileStore, regionId?: string): PlanResult {
  const typesPresent = new Set<string>()
  for (const node of store.getAllNodes()) {
    typesPresent.add(node.type as string)
  }

  // Build the expected set + per-type metadata.
  const expected = collectExpectedTypes(regionId)

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
    region: regionId ?? null,
  }
}

interface ExpectedTypeRow {
  entity_type: string
  domain: string | null
  position_in_sequence: number
  typical_parent_type: string | null
  hint: string
}

function collectExpectedTypes(regionId?: string): ExpectedTypeRow[] {
  const rows: ExpectedTypeRow[] = []
  const seen = new Set<string>()

  // If region specified, restrict to that region's atomic-domain composition.
  let domainsInScope: string[] | null = null
  if (regionId) {
    const region: UPGRegion | undefined = UPG_REGION_MAP[regionId]
    if (region) {
      domainsInScope = [...region.composes_atomic_domains]
    } else {
      // Unknown region; return empty expected set so caller surfaces 0 coverage.
      return rows
    }
  }

  for (const guide of UPG_DOMAIN_GUIDES) {
    if (domainsInScope && !domainsInScope.includes(guide.domain_id as string)) {
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
 * Walk a typed path starting from `anchor`. Each step in `path` is an entity
 * type; the walker chooses the canonical edge for the previous-type →
 * current-type pair (via `resolveContainmentEdge`) unless `edgesOverride[i]`
 * is set to a non-null string.
 *
 * Strategy is breadth-first per depth: at depth N+1 we walk every outgoing
 * edge of the resolved type whose target node matches `path[N+1]`. The trail
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
 */
export function executeReflect(
  store: UPGFileStore,
  mode?: string,
  scope?: string | null,
): ReflectResult {
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
      ((n.type as string) === 'hypothesis' && n.status === 'drafted') ||
      ((n.type as string) === 'hypothesis_claim' && n.status === 'drafted'),
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
