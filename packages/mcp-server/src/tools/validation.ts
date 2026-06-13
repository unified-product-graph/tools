/**
 * Schema validation tool: `validate_graph`.
 *
 * Walks the loaded document and returns a per-class, per-node report of
 * schema drift plus anti-pattern violations against the curated catalog.
 * Companion to the load-time `computeSchemaDriftSummary` (lib/schema-drift.ts)
 * with the same drift classes and a full breakdown.
 *
 * One call answers two questions: "is the graph spec-shaped?" (drift) and
 * "does the graph violate canonical product-thinking patterns?" (anti-patterns).
 * The blocks stay separated in the response. Read-only; pairs with
 * `migrate_type`, `rename_edge_type`, and `migrate_properties` for fixes.
 */

import {
  UPG_TYPES,
  UPG_TYPES_SET,
  UPG_EDGE_CATALOG,
  UPG_MIGRATIONS,
  UPG_SPLIT_MIGRATIONS,
  UPG_PROPERTY_MIGRATIONS,
  UPG_VERSION,
  UPG_EDGE_PAIR_MAP,
  UPG_POLYMORPHIC_EDGE_KEYS,
  getUPGEdgeMigrations,
  getLifecycleForType,
  getReplacementType,
  evaluateAntiPatterns,
  walkMigrationChainToCanonical,
  migrateStatusValue,
  validateEdgeProperties,
  type UPGAntiPatternSeverity,
  type UPGProductStage,
} from '@unified-product-graph/core'
import type { UPGSplitMigration, UPGBaseNode, UPGEdge } from '@unified-product-graph/core'
import type { ToolContext, ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { preflightPayload } from '../lib/payload-guard.js'
import { computeSchemaDriftSummary } from '@unified-product-graph/sdk'
import { collectAntiPatternInputs } from '@unified-product-graph/sdk'
import { validateEdgeTypePair } from '@unified-product-graph/sdk'
import { classifyProductKind } from '../lib/portfolio-kind.js'
import { checkPropertyTypes } from '@unified-product-graph/sdk'
import { inferEdgeTypeWithTier } from '@unified-product-graph/sdk'
import type {
  ValidateGraphResult,
  ValidateGraphScope,
  ValidateGraphEntityDrift,
  ValidateGraphEdgeDrift,
  ValidateGraphTopLevelDrift,
  ValidateGraphLifecycleDrift,
  ValidateGraphSelfReferential,
  ValidateGraphPropertyDrift,
  ValidateGraphAntiPatternViolation,
} from '@unified-product-graph/mcp-tooling'

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

// New drift classes added by the 2026-05-20 audit hardening
//. Kept as a local extension because the canonical
// ValidateGraphScope union lives in mcp-tooling. Callers can pass any of
// the strings below as `scope`; the response envelope carries the matching
// per-class arrays at top level.
type LocalScope =
  | ValidateGraphScope
  | 'edge_type_pair_drift'
  | 'graph_topology_self_loops'
  | 'property_type_drift'

const SCOPES: readonly LocalScope[] = [
  'all',
  'entity_drift',
  'edge_drift',
  'property_drift',
  'top_level_drift',
  'lifecycle_drift',
  'self_referential',
  'edge_type_pair_drift',
  'graph_topology_self_loops',
  'property_type_drift',
] as const
type Scope = LocalScope

// Local aliases; the canonical types live in `@unified-product-graph/mcp-tooling`
//. Re-aliased here so the rest of the file
// reads naturally without sprinkling fully-qualified names everywhere.
type EntityDriftEntry = ValidateGraphEntityDrift
type EdgeDriftEntry = ValidateGraphEdgeDrift
type TopLevelDriftEntry = ValidateGraphTopLevelDrift
type LifecycleDriftEntry = ValidateGraphLifecycleDrift
type SelfReferentialEntry = ValidateGraphSelfReferential
type PropertyDriftEntry = ValidateGraphPropertyDrift

// New drift entry types; hardening (2026-05-20).
interface EdgeTypePairDriftEntry {
  id: string
  type: string
  source: string
  target: string
  expected: { source: string; target: string }
  actual: { source: string; target: string }
  reason: string
}

interface GraphTopologySelfLoopEntry {
  id: string
  type: string
  node: string
}

interface PropertyTypeDriftEntry {
  id: string
  type: string
  property: string
  expected_type: string
  actual_type: string
  reason: string
}

//: polymorphic upgrade hints (opt-in via include_polymorphic_upgrades).
// One entry per polymorphic edge that has a typed alternative for its
// actual source/target pair. Severity is "info"; the polymorphic edge
// remains valid; this is a suggestion, not an error.
interface PolymorphicUpgradeHintEntry {
  id: string
  polymorphic_type: string
  source_type: string
  target_type: string
  suggested_typed_alternatives: string[]
  severity: 'info'
  rationale: string
}

// spec issue #38 (UPG 0.10.1): parity divergence. The
// `feature_rivals_competitor_feature` edge carries the authoritative parity
// assessment; the `competitor_feature` node's `parity_status` is a denormalised
// single-rival cache. When a competitor_feature has exactly one inbound rivalry
// edge and the cached node value disagrees with the edge's assessment, the cache
// is stale. Advisory only — never flips `valid`.
interface ParityDivergenceEntry {
  competitor_feature_id: string
  feature_id: string
  edge_id: string
  node_parity_status: string
  edge_parity_status: string
}

// Pre-computed polymorphic set for O(1) membership checks.
const POLYMORPHIC_EDGE_SET = new Set<string>(UPG_POLYMORPHIC_EDGE_KEYS)

const VALID_SEVERITIES: ReadonlySet<UPGAntiPatternSeverity> = new Set([
  'high',
  'medium',
  'low',
])

/**
 * Walk the loaded graph and return a structured per-node drift report PLUS
 * anti-pattern violations from `UPG_ANTI_PATTERNS`. Read-only. Pairs with
 * `migrate_type`, `rename_edge_type`, and (future) `migrate_properties` for
 * the actual fixes.
 *
 * Returns counts in `summary` plus per-class arrays. Each entry includes a
 * `suggested_migration` / `suggested_action` pointing at the right migration
 * rule or tool, so an agent can chain into the fix without re-deriving the
 * plan.
 *
 * Anti-pattern evaluation runs against the same tool surface. The
 * `anti_pattern_violations` block lists every catalog entry that fired
 * against the live graph, sorted high → medium → low. Optional filters:
 *   - `severity`: `'high' | 'medium' | 'low'`
 *   - `anti_pattern_ids`: restrict evaluation to a subset
 *   - `skip_drift`: skip the schema-drift block entirely (only patterns)
 *   - `skip_anti_patterns`: skip the catalog evaluation (only drift)
 *
 * Polymorphic upgrade hints (opt-in):
 *   - `include_polymorphic_upgrades: true` adds a
 *     `polymorphic_with_typed_alternative` array. Each entry identifies a
 *     polymorphic edge (e.g. `node_owned_by_person`, `node_constrains_node`)
 *     that has a more-specific typed alternative for its actual source/target
 *     pair. Advisory only; does not affect `valid`. Omitted by default.
 *
 * Two top-level verdicts, on two different axes (N4):
 *   - `structurally_valid` — true iff EVERY schema-drift class is empty. This
 *     is the spec-conformance signal, independent of product-health linting.
 *     A well-formed graph that merely lacks a hypothesis is structurally
 *     valid. CI conformance gates should read THIS. Omitted when
 *     `skip_drift: true` (structure was not assessed).
 *   - `valid` — true iff drift is empty AND no anti-pattern violations fired.
 *     A COMBINED structure-plus-health verdict; stricter than structural
 *     conformance. (Unchanged from prior behaviour.)
 * Polymorphic upgrade hints do NOT affect either verdict.
 *
 * @example
 * // Run a full graph health check (schema drift + anti-pattern violations)
 * // Input:
 * {}
 * // Output (truncated):
 * {
 *   "valid": false,
 *   "summary": {
 *     "entity_drift": 2,
 *     "edge_drift": 0,
 *     "property_drift": 1,
 *     "anti_pattern_violations_high": 1,
 *     "anti_pattern_violations_medium": 2,
 *     "anti_pattern_violations_low": 0,
 *     "spec_version": "0.5.0",
 *     "scope": "all"
 *   },
 *   "entity_drift": [
 *     { "id": "pain_01", "type": "pain_point", "title": "Slow onboarding", "suggested_migration": { "kind": "rename", "to": "need" } }
 *   ],
 *   "anti_pattern_violations": [
 *     { "anti_pattern_id": "features-without-hypotheses", "severity": "high", "remediation": "Add hypothesis_claim nodes linked to features via feature_tests_hypothesis" }
 *   ],
 *   "_hash": "sha256-abc123"
 * }
 *
 * @example
 * // Run a full graph health check; schema drift + anti-pattern violations
 * // Input:
 * {}
 * // Output (truncated):
 * {
 *   "valid": false,
 *   "summary": {
 *     "entity_drift": 2,
 *     "edge_drift": 0,
 *     "property_drift": 1,
 *     "anti_pattern_violations_high": 1,
 *     "anti_pattern_violations_medium": 2,
 *     "anti_pattern_violations_low": 0,
 *     "spec_version": "0.4.0",
 *     "scope": "all"
 *   },
 *   "entity_drift": [
 *     { "id": "pain_01", "type": "pain_point", "title": "Slow onboarding", "suggested_migration": { "kind": "rename", "to": "need" } }
 *   ],
 *   "anti_pattern_violations": [
 *     { "anti_pattern_id": "features-without-hypotheses", "severity": "high", "remediation": "Add hypothesis_claim nodes linked to features via feature_tests_hypothesis" }
 *   ],
 *   "_hash": "sha256-abc123"
 * }
 *
 * @returns JSON: `{ valid, structurally_valid?, summary, entity_drift?,
 *   edge_drift?, property_drift?, top_level_drift?, lifecycle_drift?,
 *   self_referential?, anti_pattern_violations?, notes?, _hash }`. Per-class
 *   drift arrays appear only when the requested `scope` includes that class.
 *   Each array is capped at `limit` (default 100). `structurally_valid` is
 *   omitted when `skip_drift: true`.
 * @throws Returns a textError when `scope` or `severity` is not one of the
 *   recognised values.
 * @atomicity atomic (read-only)
 * @warning `valid` is true ONLY when both drift is empty AND no anti-pattern
 *   violations fired — it conflates structure and product-health. For a pure
 *   spec-conformance check read `structurally_valid` (or set
 *   `skip_anti_patterns: true`, which makes `valid` track structure alone).
 *   `skip_drift: true` gives a catalog-only run and omits `structurally_valid`.
 * @see migrate_type
 * @see migrate_properties
 * @see rename_edge_type
 * @see get_anti_pattern_violations_for
 * @see list_anti_patterns
 * @see list_type_migrations
 * @see list_edge_migrations
 * @see inspect
 */
export const validateGraph: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const ifChangedSince = args.if_changed_since as string | undefined
  const currentHash = store.getContentHash()
  if (ifChangedSince && ifChangedSince === currentHash) {
    return text(JSON.stringify({ changed: false, _hash: currentHash }, null, 2))
  }

  // Batch-4 #18: pre-commit hypothetical. When pending_nodes / pending_edges are
  // supplied, evaluate anti-patterns against the CURRENT graph PLUS that delta
  // WITHOUT writing, and report which violations the delta would newly trigger
  // or resolve. Lets an agent converge to clean in one pass instead of
  // write -> validate -> patch cycles.
  const pendingNodesIn = args.pending_nodes as Array<Record<string, unknown>> | undefined
  const pendingEdgesIn = args.pending_edges as Array<Record<string, unknown>> | undefined
  if ((pendingNodesIn && pendingNodesIn.length > 0) || (pendingEdgesIn && pendingEdgesIn.length > 0)) {
    return previewPendingDelta(store, args, pendingNodesIn ?? [], pendingEdgesIn ?? [])
  }

  const scope = ((args.scope as string) ?? 'all') as Scope
  if (!SCOPES.includes(scope)) {
    return textError(
      `Unknown scope: "${scope}". Valid: ${SCOPES.join(', ')}.`,
    )
  }
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 100), 1000)

  const skipDrift = args.skip_drift === true
  const skipAntiPatterns = args.skip_anti_patterns === true
  const includePolymorphicUpgrades = args.include_polymorphic_upgrades === true

  const severityArg = args.severity as string | undefined
  if (severityArg !== undefined && !VALID_SEVERITIES.has(severityArg as UPGAntiPatternSeverity)) {
    return textError(
      `Unknown severity: "${severityArg}". Valid: high, medium, low.`,
    )
  }
  const antiPatternIds = Array.isArray(args.anti_pattern_ids)
    ? (args.anti_pattern_ids as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined

  // The drift walker only touches doc.nodes / doc.edges; pass a minimal
  // synthetic document. Cast through unknown to satisfy UPGDocument's full
  // interface without copying every metadata field.
  const docLike = { nodes: store.getAllNodes(), edges: store.getAllEdges() } as unknown as Parameters<typeof computeSchemaDriftSummary>[0]
  const summary = computeSchemaDriftSummary(docLike)

  const includes = (s: Scope) => scope === 'all' || scope === s

  // Pre-compute migration rule lookups
  const validTypes = new Set<string>(UPG_TYPES)
  const canonicalEdgeKeys = new Set<string>(Object.keys(UPG_EDGE_CATALOG))
  const entityRenameMap = new Map<string, { to: string; via: string }>()
  for (const [v, rules] of Object.entries(UPG_MIGRATIONS)) {
    for (const r of rules) {
      if (!entityRenameMap.has(r.from)) {
        entityRenameMap.set(r.from, { to: r.to, via: `UPG_MIGRATIONS['${v}']` })
      }
    }
  }
  const entitySplitMap = new Map<string, { to: string[]; via: string }>()
  for (const [v, rules] of Object.entries(UPG_SPLIT_MIGRATIONS)) {
    for (const r of rules as UPGSplitMigration[]) {
      const to = r.produces.map((s) => s.type)
      if (!entitySplitMap.has(r.from)) {
        entitySplitMap.set(r.from, { to, via: `UPG_SPLIT_MIGRATIONS['${v}']` })
      }
    }
  }
  // Edge migration index: build a lookup from `from` → first applicable rule
  // across the version range. We mirror migrateEdge's iteration order so the
  // "via" reference points at the right rule.
  const edgeRules = getUPGEdgeMigrations('0.0.0', UPG_VERSION)
  // Property migration keys per type; discriminated-union case analysis on
  // UPGPropertyMigration. Only `lift_property_to_top_level` and `drop_props`
  // touch values nested under `properties`; `rename_top_level` and
  // `drop_when_self_referential` operate on top-level fields and are surfaced
  // via top_level_drift / self_referential.
  const propertyMigrationKeysByType = new Map<string, Map<string, { via: string; action: string }>>()
  const propertyMigrationKeysWildcard = new Map<string, { via: string; action: string }>()
  const addPropertyKey = (type: string, key: string, via: string, action: string) => {
    if (type === '*') {
      if (!propertyMigrationKeysWildcard.has(key)) {
        propertyMigrationKeysWildcard.set(key, { via, action })
      }
      return
    }
    let map = propertyMigrationKeysByType.get(type)
    if (!map) {
      map = new Map()
      propertyMigrationKeysByType.set(type, map)
    }
    if (!map.has(key)) map.set(key, { via, action })
  }
  // Value-aware rules (remap_property_value / reshape_value_to_assessment): unlike
  // lift/drop, these KEEP the property key, so key-presence alone would flag
  // correctly-shaped nodes. They are checked against the actual VALUE below.
  // (0.10.2: makes the existing 0.9.12 enum remaps + the new market_trend reshape
  // discoverable via validate_graph instead of being silent until a write fails.)
  type ValueMigrationRule = { property: string; via: string; check: 'remap' | 'reshape'; value_map?: Record<string, string> }
  const valueMigrationRulesByType = new Map<string, ValueMigrationRule[]>()
  const addValueRule = (type: string, rule: ValueMigrationRule) => {
    const list = valueMigrationRulesByType.get(type) ?? []
    list.push(rule)
    valueMigrationRulesByType.set(type, list)
  }
  for (const [v, rules] of Object.entries(UPG_PROPERTY_MIGRATIONS)) {
    for (const r of rules) {
      const via = `UPG_PROPERTY_MIGRATIONS['${v}']`
      if (r.kind === 'lift_property_to_top_level') {
        addPropertyKey(r.type, r.from_property, via, `lift to top-level '${r.to}'`)
      } else if (r.kind === 'drop_props') {
        for (const key of r.drop_props) addPropertyKey(r.type, key, via, 'drop')
      } else if (r.kind === 'remap_property_value') {
        addValueRule(r.type, { property: r.property, via, check: 'remap', value_map: r.value_map })
      } else if (r.kind === 'reshape_value_to_assessment') {
        addValueRule(r.type, { property: r.property, via, check: 'reshape' })
      }
    }
  }

  const doc = { nodes: store.getAllNodes(), edges: store.getAllEdges() }
  const entityDrift: EntityDriftEntry[] = []
  const edgeDrift: EdgeDriftEntry[] = []
  const topLevelDrift: TopLevelDriftEntry[] = []
  const lifecycleDrift: LifecycleDriftEntry[] = []
  const selfReferential: SelfReferentialEntry[] = []
  const propertyDrift: PropertyDriftEntry[] = []
  const edgeTypePairDrift: EdgeTypePairDriftEntry[] = []
  const graphTopologySelfLoops: GraphTopologySelfLoopEntry[] = []
  const propertyTypeDrift: PropertyTypeDriftEntry[] = []
  const polymorphicUpgradeHints: PolymorphicUpgradeHintEntry[] = []

  // Node lookup for the new edge walks (built once).
  const nodeById = new Map<string, (typeof doc.nodes)[number]>()
  for (const n of doc.nodes) nodeById.set(n.id, n)

  for (const node of doc.nodes) {
    if (includes('entity_drift')) {
      // A type listed in UPG_TYPES is canonical and must never
      // surface as drift, even if a stale rename/split rule still references
      // it. `experiment` was reinstated as canonical alongside its
      // (former) split children; leaving the v0.2.6 split rule in place
      // for legacy data, but the type itself is no longer deprecated.
      // Treat canonicality as the authoritative signal; only suggest a
      // migration when the type isn't in UPG_TYPES.
      const isCanonical = validTypes.has(node.type)
      if (!isCanonical) {
        const renameRule = entityRenameMap.get(node.type as string)
        const splitRule = entitySplitMap.get(node.type as string)
        if (entityDrift.length < limit) {
          if (renameRule) {
            entityDrift.push({
              id: node.id,
              type: node.type as string,
              title: node.title,
              suggested_migration: { kind: 'rename', to: renameRule.to, via: renameRule.via },
            })
          } else if (splitRule) {
            entityDrift.push({
              id: node.id,
              type: node.type as string,
              title: node.title,
              suggested_migration: { kind: 'split', to: splitRule.to, via: splitRule.via },
            })
          } else {
            entityDrift.push({
              id: node.id,
              type: node.type as string,
              title: node.title,
              suggested_migration: { kind: 'unknown' },
            })
          }
        }
      }
    }

    if (includes('top_level_drift')) {
      const nodeRecord = node as unknown as Record<string, unknown>
      const unknown_fields: string[] = []
      for (const key of Object.keys(nodeRecord)) {
        if (!CANONICAL_NODE_FIELDS.has(key)) unknown_fields.push(key)
      }
      if (unknown_fields.length > 0 && topLevelDrift.length < limit) {
        topLevelDrift.push({
          id: node.id,
          type: node.type as string,
          unknown_fields,
        })
      }
    }

    if (includes('lifecycle_drift')) {
      if (typeof node.status === 'string' && node.status.length > 0) {
        const lifecycle = getLifecycleForType(node.type as string)
        if (lifecycle) {
          const validPhases = lifecycle.phases.map((p) => p.id)
          if (!validPhases.includes(node.status) && lifecycleDrift.length < limit) {
            const entry: LifecycleDriftEntry = {
              id: node.id,
              type: node.type as string,
              status: node.status,
              valid_phases: validPhases,
            }
            // Attach the canonical replacement when UPG_STATUS_MIGRATIONS
            // knows one. The presence of this field tells the caller
            // `migrate_status` can fix this row automatically; absence
            // means the operator needs to choose a phase.
            const target = migrateStatusValue(node.type as string, node.status)
            if (target !== null && target !== node.status) {
              entry.suggested_migration = {
                kind: 'migrate_status',
                to: target,
                via: 'UPG_STATUS_MIGRATIONS',
              }
            }
            lifecycleDrift.push(entry)
          }
        }
      }
    }

    if (includes('self_referential')) {
      const nodeAny = node as unknown as Record<string, unknown>
      const fields: string[] = []
      if (nodeAny.source_id === node.id) fields.push('source_id')
      if (nodeAny.source_type === node.type) fields.push('source_type')
      if (fields.length === 2 && selfReferential.length < limit) {
        selfReferential.push({ id: node.id, fields })
      }
    }

    if (includes('property_drift')) {
      // A node typed as a deprecated alias (e.g. `kpi`) carries
      // the same properties as its canonical replacement (`metric`). The
      // property-migration key map is keyed on canonical types, so normalise
      // via getReplacementType before lookup so the drift rule fires even when
      // the node has not yet been migrated.
      const effectiveType = (getReplacementType(node.type as string) ?? node.type) as string
      const propsKeys = propertyMigrationKeysByType.get(effectiveType)
      if (node.properties) {
        const bag = node.properties as Record<string, unknown>
        for (const key of Object.keys(bag)) {
          const hit = propsKeys?.get(key) ?? propertyMigrationKeysWildcard.get(key)
          if (hit && propertyDrift.length < limit) {
            propertyDrift.push({
              id: node.id,
              type: node.type as string,
              property: key,
              via: hit.via,
            })
          }
        }
        // Value-aware: remap_property_value (a stale enum value) and
        // reshape_value_to_assessment (a bare number where an assessment is
        // expected) keep the same key, so only a genuinely-stale VALUE is drift.
        const valueRules = [
          ...(valueMigrationRulesByType.get(effectiveType) ?? []),
          ...(valueMigrationRulesByType.get('*') ?? []),
        ]
        for (const vr of valueRules) {
          if (propertyDrift.length >= limit) break
          const val = bag[vr.property]
          if (val === undefined) continue
          // A value listed in a remap value_map needs migrating (it is either
          // renamed or split out to a sibling property), so presence is the
          // staleness signal. A reshape is stale when the value is still a bare
          // number (or numeric string) rather than an assessment object.
          const stale =
            vr.check === 'remap'
              ? typeof val === 'string' && !!vr.value_map && val in vr.value_map
              : typeof val === 'number' ||
                (typeof val === 'string' && val.trim() !== '' && Number.isFinite(Number(val)))
          if (stale) {
            propertyDrift.push({ id: node.id, type: node.type as string, property: vr.property, via: vr.via })
          }
        }
      }
    }

    // New drift class; property_type_drift. F4 (2026-05-20).
    // Reports declared properties on the node whose value type doesn't match
    // the schema's declared type. Undeclared properties remain
    // out of scope (covered by the read-time unknown-properties warning).
    if (includes('property_type_drift') && node.properties) {
      const effectiveTypeForTypes = (getReplacementType(node.type as string) ?? node.type) as string
      const { violations } = checkPropertyTypes(
        effectiveTypeForTypes,
        node.properties as Record<string, unknown>,
      )
      for (const v of violations) {
        if (propertyTypeDrift.length >= limit) break
        propertyTypeDrift.push({
          id: node.id,
          type: node.type as string,
          property: v.property,
          expected_type: v.expected_type,
          actual_type: v.actual_type,
          reason: v.reason,
        })
      }
    }
  }

  // Edge property drift (0.10.4): an edge whose type declares a property_schema
  // (the classification edges) is validated against it — off-scale assessment
  // values, an unknown key, or a missing required assessment field surface as
  // property_type_drift. validateEdgeProperties is a no-op for schema-less edge
  // types, so parity / framework-exercise edges are untouched.
  if (includes('property_type_drift')) {
    for (const edge of doc.edges) {
      if (propertyTypeDrift.length >= limit) break
      const edgeProps = (edge as { properties?: Record<string, unknown> }).properties
      if (!edgeProps) continue
      for (const msg of validateEdgeProperties(edge.type as string, edgeProps)) {
        if (propertyTypeDrift.length >= limit) break
        propertyTypeDrift.push({
          id: edge.id,
          type: edge.type as string,
          property: '(edge property)',
          expected_type: 'valid',
          actual_type: 'invalid',
          reason: msg,
        })
      }
    }
  }

  if (includes('edge_drift')) {
    // fix (B + A):
    //
    // Fix B (canonical suppression): an edge type listed in UPG_EDGE_CATALOG
    // is canonical and must NEVER surface as edge_drift, even if a historical
    // UPG_EDGE_MIGRATIONS rule still references it as `from`. The hypothesis
    // family is the canonical example; v0.2.8 renamed
    // `solution_proposes_hypothesis → solution_proposes_hypothesis_claim`,
    // v0.4.0 renamed it back. Both rules are historically correct; both
    // appear as `from` in the registry. The previous logic
    // (`isCanonical && !matchingRule continue`) leaked here: when the edge
    // was canonical AND a stale older rule still matched, the validator
    // suggested migrating canonical → deprecated. Canonicality is the
    // authoritative signal; drop the rule check entirely.
    //
    // Fix A (chain walk): for non-canonical edges,
    // walkMigrationChainToCanonical follows the latest-version rule from
    // each `from` key and traces the chain until it lands on a value in
    // UPG_EDGE_CATALOG (current canonical) or hits a drop rule. This
    // ensures multi-rename chains (e.g. legacy → intermediate → canonical)
    // land on the FINAL canonical name, not whichever intermediate the
    // first matching rule happens to point at.
    for (const edge of doc.edges) {
      if (canonicalEdgeKeys.has(edge.type)) continue
      if (edgeDrift.length >= limit) break

      const walk = walkMigrationChainToCanonical(edge.type as string, UPG_EDGE_CATALOG)
      // Carry the first hop's `flip` so callers know whether endpoints need
      // swapping. Chains longer than one hop don't currently exist in
      // UPG_EDGE_MIGRATIONS; if/when they do, flip semantics across the
      // walk would need separate accumulation. For now, only the first hop
      // can flip; multi-hop chains are pure renames.
      const firstHop = edgeRules.find((r) => r.from === edge.type)
      if (walk.kind === 'canonical') {
        edgeDrift.push({
          id: edge.id,
          type: edge.type as string,
          source: edge.source,
          target: edge.target,
          suggested_migration: {
            kind: 'rename',
            to: walk.to,
            flip: firstHop?.kind === 'rename' ? firstHop.flip : undefined,
            via: 'UPG_EDGE_MIGRATIONS',
          },
        })
      } else if (walk.kind === 'drop') {
        edgeDrift.push({
          id: edge.id,
          type: edge.type as string,
          source: edge.source,
          target: edge.target,
          suggested_migration: { kind: 'drop', via: 'UPG_EDGE_MIGRATIONS' },
        })
      } else {
        // dead_end or cycle; no canonical target known.
        edgeDrift.push({
          id: edge.id,
          type: edge.type as string,
          source: edge.source,
          target: edge.target,
          suggested_migration: { kind: 'unknown' },
        })
      }
    }
  }

  // New drift classes; F1 + F2 (2026-05-20).
  //
  // edge_type_pair_drift: edges whose source/target node types don't match
  // what the catalog says their edge type connects. Distinct from edge_drift,
  // which complains about NAMING (the type string isn't canonical or has
  // been deprecated); edge_type_pair_drift complains about WIRING (the type
  // is canonical but it's been written to the wrong node-type pair).
  //
  // graph_topology_self_loops: edges where source_id === target_id.
  // Distinct from the existing `self_referential` class, which fires on
  // source_id / source_type properties on a node (external-import
  // provenance); those are properties on a node, not loops in the graph
  // topology.
  if (includes('edge_type_pair_drift') || includes('graph_topology_self_loops')) {
    for (const edge of doc.edges) {
      if (includes('graph_topology_self_loops') && edge.source === edge.target) {
        if (graphTopologySelfLoops.length < limit) {
          graphTopologySelfLoops.push({
            id: edge.id,
            type: edge.type as string,
            node: edge.source,
          })
        }
      }
      if (includes('edge_type_pair_drift')) {
        const sourceNode = nodeById.get(edge.source)
        const targetNode = nodeById.get(edge.target)
        if (!sourceNode || !targetNode) continue // dangling; separate concern
        const pairCheck = validateEdgeTypePair(
          edge.type as string,
          sourceNode.type as string,
          targetNode.type as string,
        )
        if (!pairCheck.valid && edgeTypePairDrift.length < limit) {
          edgeTypePairDrift.push({
            id: edge.id,
            type: edge.type as string,
            source: edge.source,
            target: edge.target,
            expected: pairCheck.expected,
            actual: pairCheck.actual,
            reason: pairCheck.reason,
          })
        }
      }
    }
  }

  // ── Polymorphic upgrade hints ───────────────────────────
  // Opt-in (include_polymorphic_upgrades: true). For each edge whose type is
  // in the registered polymorphic allow-list, look up whether a typed
  // alternative exists for the actual source/target node-type pair. If one
  // does, emit a suggestion. Severity is always "info"; the polymorphic
  // edge remains valid; this is advisory only.
  //
  // The wildcard endpoint in the catalog is the literal string 'node'.
  // Ownership edges: source_type='node', target_type=<ownerType>.
  //   → Look up UPG_EDGE_PAIR_MAP[actualSourceType + ':' + ownerType].
  // Symmetric generics (node_constrains_node, node_informs_node,
  //   node_inspires_node): source_type='node', target_type='node'.
  //   → Look up UPG_EDGE_PAIR_MAP[actualSourceType + ':' + actualTargetType].
  // node_belongs_to_bounded_context: source_type='node'.
  //   → Look up UPG_EDGE_PAIR_MAP[actualSourceType + ':bounded_context'].
  // decision_* (source is typed 'decision', target wildcard 'node'):
  //   → Look up UPG_EDGE_PAIR_MAP['decision:' + actualTargetType].
  //
  // In every case, filter out the polymorphic edges themselves from the
  // candidates so we only surface genuinely typed alternatives.
  if (includePolymorphicUpgrades) {
    for (const edge of doc.edges) {
      if (polymorphicUpgradeHints.length >= limit) break
      const edgeType = edge.type as string
      if (!POLYMORPHIC_EDGE_SET.has(edgeType)) continue

      const sourceNode = nodeById.get(edge.source)
      const targetNode = nodeById.get(edge.target)
      if (!sourceNode || !targetNode) continue // dangling edge; skip

      const actualSource = sourceNode.type as string
      const actualTarget = targetNode.type as string

      const catalogDef = UPG_EDGE_CATALOG[edgeType as keyof typeof UPG_EDGE_CATALOG]
      if (!catalogDef) continue

      // Determine the pair key to query. The wildcard is the literal 'node'.
      const WILDCARD = 'node'
      let pairKey: string
      if (catalogDef.source_type === WILDCARD && catalogDef.target_type !== WILDCARD) {
        // Ownership family: source is the wildcard, target is a concrete owner type.
        pairKey = `${actualSource}:${catalogDef.target_type}`
      } else if (catalogDef.source_type !== WILDCARD && catalogDef.target_type === WILDCARD) {
        // decision_* family: source is typed (e.g. 'decision'), target is wildcard.
        pairKey = `${catalogDef.source_type}:${actualTarget}`
      } else {
        // Both endpoints wildcard (node_constrains_node, node_informs_node, etc.)
        pairKey = `${actualSource}:${actualTarget}`
      }

      const candidates = UPG_EDGE_PAIR_MAP[pairKey] ?? []
      const typedAlternatives = candidates.filter((k) => !POLYMORPHIC_EDGE_SET.has(k))
      if (typedAlternatives.length === 0) continue

      // Build a human-readable rationale describing why the typed alternative
      // might be preferable.
      let rationale: string
      if (edgeType.startsWith('node_owned_by_')) {
        const ownerType = catalogDef.target_type
        rationale =
          `${edgeType} is the generic ownership edge (any node → ${ownerType}). ` +
          `${typedAlternatives.join(' / ')} carries the same ownership semantics but is ` +
          `scoped specifically to ${actualSource} → ${ownerType}, making the graph more ` +
          `queryable and self-documenting.`
      } else if (edgeType === 'node_belongs_to_bounded_context') {
        rationale =
          `node_belongs_to_bounded_context is the generic containment edge (any node → bounded_context). ` +
          `${typedAlternatives.join(' / ')} expresses the same relationship but is typed ` +
          `for ${actualSource}, enabling type-safe traversal.`
      } else if (edgeType === 'node_constrains_node') {
        rationale =
          `node_constrains_node is the generic constraint edge (any → any). ` +
          `${typedAlternatives.join(' / ')} captures the same intent but is ` +
          `semantically scoped to ${actualSource} → ${actualTarget}.`
      } else if (
        edgeType === 'decision_influences_node' ||
        edgeType === 'decision_constrained_by_node' ||
        edgeType === 'decision_produces_node'
      ) {
        rationale =
          `${edgeType} is a generic decision-to-anything edge. ` +
          `${typedAlternatives.join(' / ')} expresses the same relationship but is ` +
          `typed specifically for decision → ${actualTarget}.`
      } else {
        // node_informs_node, node_inspires_node
        rationale =
          `${edgeType} is a generic semantic edge (any → any). ` +
          `${typedAlternatives.join(' / ')} captures the same intent ` +
          `with ${actualSource} → ${actualTarget} typing for stronger graph integrity.`
      }

      polymorphicUpgradeHints.push({
        id: edge.id,
        polymorphic_type: edgeType,
        source_type: actualSource,
        target_type: actualTarget,
        suggested_typed_alternatives: typedAlternatives,
        severity: 'info',
        rationale,
      })
    }
  }

  // ── Parity divergence (advisory, spec issue #38, UPG 0.10.1) ──────
  // The feature_rivals_competitor_feature edge is authoritative for parity; the
  // competitor_feature node's `parity_status` is a denormalised single-rival
  // cache. When a competitor_feature has exactly one inbound rivalry edge and
  // the cached node value disagrees with the edge's assessment, surface it so
  // the cache can be reconciled to the edge. Within-graph only (the edge and
  // both endpoints live in this store); cross-product divergence is a
  // portfolio-tier concern. Advisory only: never flips `valid`.
  const parityDivergence: ParityDivergenceEntry[] = []
  {
    const RIVALS = 'feature_rivals_competitor_feature'
    const inboundByTarget = new Map<string, Array<(typeof doc.edges)[number]>>()
    for (const edge of doc.edges) {
      if (edge.type !== RIVALS) continue
      const list = inboundByTarget.get(edge.target) ?? []
      list.push(edge)
      inboundByTarget.set(edge.target, list)
    }
    for (const [cfId, edges] of inboundByTarget) {
      if (edges.length !== 1) continue // only the single-rival cache case
      if (parityDivergence.length >= limit) break
      const edge = edges[0]
      const cf = nodeById.get(cfId)
      if (!cf || cf.type !== 'competitor_feature') continue
      const nodeParity = (cf.properties as Record<string, unknown> | undefined)?.parity_status
      const edgeParity = (edge as { properties?: Record<string, unknown> }).properties?.parity_status
      if (typeof nodeParity !== 'string' || typeof edgeParity !== 'string') continue
      if (nodeParity === edgeParity) continue
      parityDivergence.push({
        competitor_feature_id: cfId,
        feature_id: edge.source,
        edge_id: edge.id,
        node_parity_status: nodeParity,
        edge_parity_status: edgeParity,
      })
    }
  }

  // ── Anti-pattern evaluation ─────────────────────────────────────
  // Pure evaluator over pre-computed inputs. The collector walks the store
  // once and returns the 7-field stats shape consumed by `evaluateAntiPatterns`.
  let antiPatternViolations: ValidateGraphAntiPatternViolation[] | undefined
  if (!skipAntiPatterns) {
    const productStage = store.getProduct().stage as UPGProductStage | undefined
    const inputs = collectAntiPatternInputs(store, productStage)
    const violations = evaluateAntiPatterns(inputs, {
      severity: severityArg as UPGAntiPatternSeverity | undefined,
      anti_pattern_ids: antiPatternIds,
    })
    antiPatternViolations = violations.map((v) => ({
      anti_pattern_id: v.anti_pattern_id,
      name: v.name,
      severity: v.severity,
      target_entities: v.target_entities,
      description: v.description,
      why_it_matters: v.why_it_matters,
      remediation: v.remediation,
      source: v.source,
    }))
  }

  // Payload pre-flight: rough cost estimate based on combined arrays.
  const totalEntries =
    entityDrift.length +
    edgeDrift.length +
    topLevelDrift.length +
    lifecycleDrift.length +
    selfReferential.length +
    propertyDrift.length +
    edgeTypePairDrift.length +
    graphTopologySelfLoops.length +
    propertyTypeDrift.length +
    polymorphicUpgradeHints.length +
    parityDivergence.length +
    (antiPatternViolations?.length ?? 0)
  const guardOutcome = preflightPayload({
    toolName: 'validate_graph',
    nodeCount: 0,
    edgeCount: totalEntries,
    compactEdges: true,
    argsHint: `scope=${scope}, limit=${limit}`,
  })
  if (guardOutcome.kind === 'refuse') return guardOutcome.result

  // ── `valid` / `structurally_valid` semantics ───────────────────
  // Two distinct axes, surfaced separately (N4, UPG QA 0.8.7):
  //
  //   structurally_valid — the graph is spec-shaped: EVERY drift class is
  //     empty. Independent of product-health anti-patterns. This is the signal
  //     a CI conformance gate should read: a well-formed graph that merely
  //     lacks a hypothesis is structurally valid.
  //
  //   valid — stricter, COMBINED health: structurally valid AND no
  //     anti-pattern violations fired. UNCHANGED from prior behaviour (kept
  //     intact so nothing downstream breaks).
  //
  // `structurallyClean` is the pure drift verdict, computed regardless of the
  // skip flags so it reflects the actual graph. `structurally_valid` is only
  // emitted when drift was actually evaluated (skip_drift omits it, since we
  // didn't assess structure). `valid` keeps its existing skip semantics: when
  // `skip_drift` is true drift is ignored; when `skip_anti_patterns` is true
  // violations are ignored.
  const structurallyClean =
    summary.entity_drift === 0 &&
    summary.edge_drift === 0 &&
    summary.top_level_drift === 0 &&
    summary.lifecycle_drift === 0 &&
    summary.self_referential === 0 &&
    summary.property_drift === 0 &&
    edgeTypePairDrift.length === 0 &&
    graphTopologySelfLoops.length === 0 &&
    propertyTypeDrift.length === 0
  const driftClean = skipDrift || structurallyClean
  // A watched intelligence graph (member of a `watched` portfolio, e.g. a
  // competitor graph) is not a product under management: its product-spine
  // anti-pattern violations are category errors and must not flip `valid`.
  // Structural drift still gates validity; violations are still reported, but
  // advisory, and `watched_intelligence_graph` flags the suppression. Only
  // classified when there is something to suppress (avoids the portfolio read
  // on the clean path). (spec issue #39, UPG 0.9.27)
  const watchedGraph =
    !skipAntiPatterns &&
    (antiPatternViolations?.length ?? 0) > 0 &&
    classifyProductKind(process.cwd(), store.getProduct().id) === 'watched'
  const antiPatternClean =
    skipAntiPatterns || watchedGraph || (antiPatternViolations?.length ?? 0) === 0
  const valid = driftClean && antiPatternClean
  // Only meaningful when drift was actually evaluated.
  const structurallyValid = skipDrift ? undefined : structurallyClean

  // ── Summary fields ─────────────────────────────────────
  let highCount = 0
  let mediumCount = 0
  let lowCount = 0
  if (antiPatternViolations) {
    for (const v of antiPatternViolations) {
      if (v.severity === 'high') highCount++
      else if (v.severity === 'medium') mediumCount++
      else if (v.severity === 'low') lowCount++
    }
  }

  // Build the canonical envelope. Per-class arrays are populated only when the
  // requested scope includes that class.
  //
  // The new drift classes (edge_type_pair_drift, graph_topology_self_loops,
  // property_type_drift) extend the canonical ValidateGraphResult contract
  // additively; see hardening (2026-05-20). The local server emits
  // them as extra top-level fields plus matching summary counts. Consumers
  // can read them via `response.edge_type_pair_drift` etc.
  const response = {
    valid,
    ...(watchedGraph ? { watched_intelligence_graph: true } : {}),
    // N4 (UPG QA 0.8.7): additive structural-conformance signal. true ⟺ every
    // drift class is 0, independent of anti-pattern health. Omitted when
    // `skip_drift` is true (structure was not assessed). A CI gate that wants
    // "is this graph spec-shaped?" should read this, not `valid`.
    ...(structurallyValid !== undefined ? { structurally_valid: structurallyValid } : {}),
    summary: {
      ...summary,
      spec_version: UPG_VERSION,
      scope,
      limit,
      anti_pattern_violations_high: highCount,
      anti_pattern_violations_medium: mediumCount,
      anti_pattern_violations_low: lowCount,
      edge_type_pair_drift: edgeTypePairDrift.length,
      graph_topology_self_loops: graphTopologySelfLoops.length,
      property_type_drift: propertyTypeDrift.length,
      polymorphic_upgrade_hints: includePolymorphicUpgrades ? polymorphicUpgradeHints.length : undefined,
      parity_divergence: parityDivergence.length > 0 ? parityDivergence.length : undefined,
    },
    _hash: currentHash,
  } as ValidateGraphResult & {
    structurally_valid?: boolean
    edge_type_pair_drift?: EdgeTypePairDriftEntry[]
    graph_topology_self_loops?: GraphTopologySelfLoopEntry[]
    property_type_drift?: PropertyTypeDriftEntry[]
    polymorphic_with_typed_alternative?: PolymorphicUpgradeHintEntry[]
    parity_divergence?: ParityDivergenceEntry[]
  }
  if (!skipDrift) {
    if (includes('entity_drift')) response.entity_drift = entityDrift
    if (includes('edge_drift')) response.edge_drift = edgeDrift
    if (includes('top_level_drift')) response.top_level_drift = topLevelDrift
    if (includes('lifecycle_drift')) response.lifecycle_drift = lifecycleDrift
    if (includes('self_referential')) response.self_referential = selfReferential
    if (includes('property_drift')) response.property_drift = propertyDrift
    if (includes('edge_type_pair_drift')) response.edge_type_pair_drift = edgeTypePairDrift
    if (includes('graph_topology_self_loops')) response.graph_topology_self_loops = graphTopologySelfLoops
    if (includes('property_type_drift')) response.property_type_drift = propertyTypeDrift
  }
  // Polymorphic upgrade hints are independent of skip_drift; they are advisory
  // suggestions, not schema-drift errors, and are controlled solely by
  // include_polymorphic_upgrades. When skip_drift is true they still appear.
  if (includePolymorphicUpgrades) response.polymorphic_with_typed_alternative = polymorphicUpgradeHints
  // Parity divergence is advisory and independent of skip_drift (it is not a
  // schema-drift class); surfaced only when something actually diverges.
  if (parityDivergence.length > 0) response.parity_divergence = parityDivergence
  if (antiPatternViolations) {
    response.anti_pattern_violations = antiPatternViolations
  }

  // Payload-guard `_warning` / `_payload_bytes` are part of the canonical
  // `ValidateGraphResult` contract, so we attach them with the
  // typed shape; no unknown-cast.
  if (guardOutcome.kind === 'warn') {
    response._warning = guardOutcome.fields._warning
    response._payload_bytes = guardOutcome.fields._payload_bytes
  }

  return text(JSON.stringify(response, null, 2))
}

/**
 * Batch-4 #18: evaluate anti-patterns against the current graph plus a proposed
 * (pending) delta WITHOUT writing, and diff the verdict against the current
 * graph. The graph is augmented in a synthetic read-only view
 * (`collectAntiPatternInputs` touches only `getAllNodes` / `getAllEdges`), so
 * nothing is ever mutated or persisted. `pending_edges` endpoints may be an
 * existing node id or a `$N` index into `pending_nodes`; edge type is inferred
 * from endpoints when omitted.
 */
function previewPendingDelta(
  store: ToolContext['store'],
  args: Record<string, unknown>,
  pendingNodesIn: Array<Record<string, unknown>>,
  pendingEdgesIn: Array<Record<string, unknown>>,
): ToolResult {
  const severityArg = args.severity as string | undefined
  if (severityArg !== undefined && !VALID_SEVERITIES.has(severityArg as UPGAntiPatternSeverity)) {
    return textError(`Unknown severity: "${severityArg}". Valid: high, medium, low.`)
  }
  const antiPatternIds = Array.isArray(args.anti_pattern_ids)
    ? (args.anti_pattern_ids as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined

  const errors: string[] = []

  // Resolve pending nodes → synthetic nodes with stable temp ids.
  const pendingNodes: UPGBaseNode[] = []
  for (let i = 0; i < pendingNodesIn.length; i++) {
    const n = pendingNodesIn[i]
    const type = n.type as string | undefined
    if (!type) { errors.push(`pending_nodes[${i}]: missing "type"`); continue }
    if (!UPG_TYPES_SET.has(type)) { errors.push(`pending_nodes[${i}]: unknown entity type "${type}"`); continue }
    const node = { id: `pending_${i}`, type, title: (n.title as string) ?? `Pending ${type}` } as UPGBaseNode
    if (typeof n.status === 'string') (node as { status?: string }).status = n.status
    if (Array.isArray(n.tags)) (node as { tags?: unknown }).tags = n.tags
    if (n.properties && typeof n.properties === 'object') (node as { properties?: unknown }).properties = n.properties
    pendingNodes.push(node)
  }

  // Resolve pending edges. from/to may be an existing node id or a `$N` index
  // into pending_nodes; type is inferred from endpoint types when omitted.
  const existingIds = new Set(store.getAllNodes().map((n) => n.id))
  const typeOfEndpoint = (id: string): string | undefined => {
    if (id.startsWith('pending_')) return pendingNodes.find((p) => p.id === id)?.type as string | undefined
    return store.getNode(id)?.type as string | undefined
  }
  const resolveEnd = (raw: unknown, label: string, i: number): string | null => {
    if (typeof raw !== 'string' || raw.length === 0) { errors.push(`pending_edges[${i}]: missing "${label}"`); return null }
    const m = raw.match(/^\$(\d+)$/)
    if (m) {
      const idx = parseInt(m[1], 10)
      if (idx >= pendingNodes.length) { errors.push(`pending_edges[${i}]: ${label} "${raw}" out of range (${pendingNodes.length} pending nodes)`); return null }
      return `pending_${idx}`
    }
    if (!existingIds.has(raw)) { errors.push(`pending_edges[${i}]: ${label} "${raw}" is not an existing node id or a $N pending ref`); return null }
    return raw
  }
  const pendingEdges: UPGEdge[] = []
  for (let i = 0; i < pendingEdgesIn.length; i++) {
    const e = pendingEdgesIn[i]
    const from = resolveEnd(e.from, 'from', i)
    const to = resolveEnd(e.to, 'to', i)
    if (!from || !to) continue
    let type = e.type as string | undefined
    if (!type) {
      const st = typeOfEndpoint(from)
      const tt = typeOfEndpoint(to)
      if (st && tt) {
        const inf = inferEdgeTypeWithTier(st, tt)
        if (inf.ok) type = inf.edgeType
      }
    }
    if (!type) { errors.push(`pending_edges[${i}]: no "type" given and none inferable from endpoints`); continue }
    pendingEdges.push({ id: `pe_${i}`, source: from, target: to, type } as UPGEdge)
  }

  if (errors.length > 0) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: errors[0], errors }, null, 2) }], isError: true }
  }

  // Synthetic augmented view (no mutation, no persistence).
  const augNodes = [...store.getAllNodes(), ...pendingNodes]
  const augEdges = [...store.getAllEdges(), ...pendingEdges]
  const product = store.getProduct()
  const synthetic = {
    getAllNodes: () => augNodes,
    getAllEdges: () => augEdges,
    getProduct: () => product,
  } as unknown as Parameters<typeof collectAntiPatternInputs>[0]
  const stage = (product as { stage?: string }).stage as UPGProductStage | undefined

  const evalOpts = { severity: severityArg as UPGAntiPatternSeverity | undefined, anti_pattern_ids: antiPatternIds }
  const hyp = evaluateAntiPatterns(collectAntiPatternInputs(synthetic, stage), evalOpts)
  const cur = evaluateAntiPatterns(collectAntiPatternInputs(store, stage), evalOpts)
  const curIds = new Set(cur.map((v) => v.anti_pattern_id))
  const hypIds = new Set(hyp.map((v) => v.anti_pattern_id))
  const short = (v: { anti_pattern_id: string; name: string; severity: string }) => ({
    anti_pattern_id: v.anti_pattern_id, name: v.name, severity: v.severity,
  })

  let high = 0, medium = 0, low = 0
  for (const v of hyp) {
    if (v.severity === 'high') high++
    else if (v.severity === 'medium') medium++
    else if (v.severity === 'low') low++
  }

  const response = {
    preview: true,
    pending: { nodes: pendingNodes.length, edges: pendingEdges.length },
    would_be_valid: hyp.length === 0,
    summary: {
      hypothetical_violations: hyp.length,
      current_violations: cur.length,
      anti_pattern_violations_high: high,
      anti_pattern_violations_medium: medium,
      anti_pattern_violations_low: low,
    },
    delta: {
      newly_triggered: hyp.filter((v) => !curIds.has(v.anti_pattern_id)).map(short),
      newly_resolved: cur.filter((v) => !hypIds.has(v.anti_pattern_id)).map(short),
    },
    anti_pattern_violations: hyp.map((v) => ({
      anti_pattern_id: v.anti_pattern_id,
      name: v.name,
      severity: v.severity,
      target_entities: v.target_entities,
      remediation: v.remediation,
    })),
  }
  return text(JSON.stringify(response, null, 2))
}

// ─── Reverse lookup: get_anti_pattern_violations_for ───────────────

/**
 * Reverse-lookup helper: given an entity id, return the anti-pattern
 * violations whose `target_entities` include that entity's TYPE.
 *
 * Phase 1 keeps `target_entities` as type strings (see evaluator JSDoc), so
 * the lookup matches by type. Phase 1.x will promote to specific ids and the
 * matcher will tighten accordingly.
 *
 * Use case: `/upg-show-entity <entity>` displays "this entity is implicated in
 * N violations." Tightens the Inspect approach.
 *
 * @example
 * // Find all anti-pattern violations that implicate a specific feature node
 * // Input:
 * { "entity_id": "feature_04" }
 * // Output (truncated):
 * {
 *   "entity_id": "feature_04",
 *   "type": "feature",
 *   "violations": [
 *     {
 *       "anti_pattern_id": "features-without-hypotheses",
 *       "name": "Features Without Hypotheses",
 *       "severity": "high",
 *       "why_it_matters": "Building without a testable hypothesis means no way to evaluate success.",
 *       "remediation": "Link each feature to a hypothesis_claim via feature_tests_hypothesis."
 *     }
 *   ]
 * }
 *
 * @returns JSON: `{ entity_id, type, violations: [...] }`.
 * @throws textError when `entity_id` is missing or unknown.
 * @atomicity atomic (read-only)
 * @warning Phase 1 matches by entity TYPE, not specific id. Every entity of
 *   the same type shares the same violation set. Phase 1.x will tighten to
 *   per-id matching once `target_entities` carries ids.
 * @see validate_graph
 * @see list_anti_patterns
 * @see get_anti_pattern
 * @see inspect
 */
export const getAntiPatternViolationsFor: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const entityId = args.entity_id as string | undefined
  if (!entityId) return textError('Missing required parameter: entity_id')

  const node = store.getNode(entityId)
  if (!node) return textError(`Unknown entity_id: ${entityId}`)

  const productStage = store.getProduct().stage as UPGProductStage | undefined
  const inputs = collectAntiPatternInputs(store, productStage)
  const allViolations = evaluateAntiPatterns(inputs)

  const nodeType = node.type as string
  const matched = allViolations.filter((v) => v.target_entities.includes(nodeType))

  return text(
    JSON.stringify(
      {
        entity_id: entityId,
        type: nodeType,
        violations: matched.map((v) => ({
          anti_pattern_id: v.anti_pattern_id,
          name: v.name,
          severity: v.severity,
          why_it_matters: v.why_it_matters,
          remediation: v.remediation,
        })),
      },
      null,
      2,
    ),
  )
}

export type { ToolContext }
