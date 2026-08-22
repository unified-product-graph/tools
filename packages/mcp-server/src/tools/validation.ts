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
  UPG_BASE_NODE_FIELD_SET,
  getUPGEdgeMigrations,
  getLifecycleForType,
  getReplacementType,
  evaluateAntiPatterns,
  concernGatesFor,
  isThinCoverageAdvisory,
  walkMigrationChainToCanonical,
  migrateStatusValue,
  validateEdgeProperties,
  checkHeaderSealText,
  type UPGAntiPatternSeverity,
  type UPGProductStage,
  type UPGHeaderCountsMismatch,
  type UPGHeaderIntegrityMismatch,
} from '@unified-product-graph/core'
import { readFileSync } from 'node:fs'
import type { UPGSplitMigration, UPGBaseNode, UPGEdge } from '@unified-product-graph/core'
import type { ToolContext, ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { preflightPayload } from '../lib/payload-guard.js'
import { computeSchemaDriftSummary } from '@unified-product-graph/sdk'
import { collectAntiPatternInputs } from '@unified-product-graph/sdk'
import { resolveConfiguration } from '../lib/configuration-view.js'
import {
  checkConfigurationDrift,
  enumerateProjections,
  projectGraph,
} from '@unified-product-graph/core'
import { validateEdgeTypePair } from '@unified-product-graph/sdk'
import { classifyProductKind } from '../lib/portfolio-kind.js'
import { checkPropertyTypes, checkUndeclaredProperties } from '@unified-product-graph/sdk'
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

/**
 * Canonical top-level node fields, DERIVED from the `UPGBaseNode` shape.
 *
 * `validate_graph` reports the per-node breakdown behind `top_level_drift`, so
 * this must agree exactly with the counter in
 * `packages/upg-sdk/src/lib/schema-drift.ts`, which derives from the same
 * export. It was a second hand-maintained copy of the same fifteen names and
 * went stale in the same release for the same reason.
 */
const CANONICAL_NODE_FIELDS = UPG_BASE_NODE_FIELD_SET

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
  | 'counts_drift'
  | 'integrity_drift'
  | 'undeclared_property_drift'

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
  'counts_drift',
  'integrity_drift',
  'undeclared_property_drift',
  'configuration_drift',
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

// Header-seal drift classes (feedback 1bb903bf). Unlike every other class here,
// these two describe the on-disk ARTIFACT rather than the loaded graph: they ask
// whether the `.upg` file's `$upg` header is true to that same file's body.
// Entry shapes come straight from the spec-side checker so the MCP surface and
// `upg verify` can never describe the same defect two different ways.
type CountsDriftEntry = UPGHeaderCountsMismatch
type IntegrityDriftEntry = UPGHeaderIntegrityMismatch

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
 * Header-seal classes (feedback 1bb903bf) — the only two classes that judge the
 * on-disk FILE rather than the loaded graph. `$upg.counts` and
 * `$upg.integrity.body` are derived from the body at write time; these compare
 * a file's header against that same file's body:
 *   - `counts_drift` — a declared `$upg.counts` field disagrees with the actual
 *     array length. Entries: `{ field, declared, actual }`.
 *   - `integrity_drift` — the declared body checksum does not match a
 *     recomputation. Entries: `{ algorithm, declared, computed }`.
 * The reachable cause is an ordinary git merge: two branches each add a node,
 * git merges the bodies cleanly but takes the identical `counts` hunk once, and
 * the file silently declares one fewer node than it holds. `upg fmt` reseals
 * both fields; `upg fmt --check` gates it in CI. Both classes are empty for
 * legacy flat files, which declare no header to drift from.
 *
 * Two top-level verdicts, on two different axes (N4):
 *   - `structurally_valid` — true iff EVERY schema-drift class is empty,
 *     header-seal classes included. This is the spec-conformance signal,
 *     independent of product-health linting. A well-formed graph that merely
 *     lacks a hypothesis is structurally valid. CI conformance gates should
 *     read THIS. Omitted when `skip_drift: true` (structure was not assessed).
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
 * @example
 * // A graph whose header no longer matches its body (the classic bad git merge)
 * // Input:
 * { "scope": "counts_drift" }
 * // Output (truncated):
 * {
 *   "valid": false,
 *   "structurally_valid": false,
 *   "summary": { "counts_drift": 1, "scope": "counts_drift" },
 *   "counts_drift": [ { "field": "nodes", "declared": 1274, "actual": 1275 } ]
 * }
 *
 * @returns JSON: `{ valid, structurally_valid?, summary, entity_drift?,
 *   edge_drift?, property_drift?, top_level_drift?, lifecycle_drift?,
 *   self_referential?, counts_drift?, integrity_drift?, header_seal_note?,
 *   anti_pattern_violations?, notes?, _hash }`. Per-class
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
 * @warning `counts_drift` / `integrity_drift` describe the `.upg` file ON DISK,
 *   not the in-memory graph — they re-read the file and compare its header to
 *   its own body. Unsaved writes therefore never show up as seal drift (the
 *   last-written file is still self-consistent), and a seal defect is repaired
 *   by `upg fmt`, not by any of the `migrate_*` tools.
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
  // 0.30.0: an explicit configuration narrows the whole report to one member of
  // the family. Without it, anti-patterns are still evaluated per projection
  // (see below) and drift is checked on the union, which is where declarations
  // live.
  const explicitConfiguration = resolveConfiguration(args.configuration, store)
  if (explicitConfiguration.error) return textError(explicitConfiguration.error)
  if (!SCOPES.includes(scope)) {
    return textError(
      `Unknown scope: "${scope}". Valid: ${SCOPES.join(', ')}.`,
    )
  }
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 100), 1000)

  const skipDrift = args.skip_drift === true
  const skipAntiPatterns = args.skip_anti_patterns === true

  // `configuration` narrows the ANTI-PATTERN pass and nothing else, so asking
  // for one while skipping anti-patterns asks for nothing. Refused rather than
  // ignored, on the same bar the parameter sets for itself elsewhere: an
  // argument that cannot take effect must never be silently accepted.
  if (explicitConfiguration.reader && skipAntiPatterns) {
    return textError(
      '`configuration` narrows the anti-pattern pass, so it has no effect with `skip_anti_patterns: true`. ' +
        'Drop one of the two. Configuration drift is checked on the union by design, because the declarations ' +
        'it validates are facts about the whole configuration family rather than about any one member.',
    )
  }
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
  const undeclaredPropertyDrift: Array<{ id: string; type: string; property: string }> = []
  /**
   * TRUE total, counted independently of the capped entry array.
   *
   * `summary.<class>` is the graph's whole count and does NOT move with
   * `limit` — `summary.top_level_drift` reports 1,032 beside a 100-entry list,
   * because the summary answers "how much is there" and the array answers "here
   * is a page of it". This class shipped counting `array.length`, so at the
   * default limit it reported 100 on a graph holding 5,956 and the number moved
   * when a caller changed the page size. It was the first local drift class
   * whose real population exceeds the cap, which is why the same shape in its
   * siblings has never been visible.
   */
  let undeclaredPropertyDriftTotal = 0
  const polymorphicUpgradeHints: PolymorphicUpgradeHintEntry[] = []
  const countsDrift: CountsDriftEntry[] = []
  const integrityDrift: IntegrityDriftEntry[] = []
  // Configuration drift (0.30.0). Computed from the spec's pure checker over
  // the UNION: the declarations are facts about the whole configuration family,
  // so they are checked once rather than once per projection. Returns an empty
  // array for a graph that declares no axes, which is every graph written
  // before this release.
  const configurationDrift = skipDrift
    ? []
    : checkConfigurationDrift(
        doc.nodes as unknown as Parameters<typeof checkConfigurationDrift>[0],
        doc.edges as unknown as Parameters<typeof checkConfigurationDrift>[1],
      )
  const configurationDriftErrorCount = configurationDrift.filter((d) => d.severity === 'error').length

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

    // New drift class; undeclared_property_drift (0.34.1, audit R7).
    //
    // The class that closes the gap between this tool and `get_node`. Until
    // 0.34.1 no drift class here could see an UNDECLARED bag key at all:
    // `property_drift` asks whether a key is covered by a migration RULE, and
    // for a key nobody ever wrote a rule for the honest answer is zero. So
    // `get_node` warned about `properties.lifecycle` on a composition while
    // this tool reported `property_drift: 0` for the same node, and whichever
    // a consumer trusted, the other contradicted it.
    //
    // Namespaced `<tool>:<key>` extensions are NOT drift; see
    // `checkUndeclaredProperties`.
    //
    // DELIBERATELY NOT GATING `structurally_valid`, and the estate says how
    // firmly. Turning this class on measures 5,956 undeclared keys across 15
    // shapes on the 1,118-node tracker and 219 across 35 shapes on the dogfood
    // graph. Gating on it would flip both to structurally invalid on a release
    // that changed nothing about them — the exact failure this audit reported
    // against 0.33.0, where a status migration flipped `structurally_valid`
    // true to false and broke every consumer gating on it. The class REPORTS.
    // Making it gate is a separate decision that needs a migration path and a
    // deprecation window, and it belongs in a minor, not here.
    //
    // Worth knowing before that decision: 5,779 of the tracker's 5,956 are one
    // importer's `linear_*` keys, which are undeclared AND unnamespaced. Under
    // the spec's own rule they should be `linear:...`, and they are the reason
    // that rule exists — an underscore key is indistinguishable from a
    // misspelled spec property. That is a migration, not a validator change.
    if (includes('undeclared_property_drift') && node.properties) {
      const effectiveTypeForUndeclared = (getReplacementType(node.type as string) ?? node.type) as string
      const { unknown_properties } = checkUndeclaredProperties(
        effectiveTypeForUndeclared,
        node.properties as Record<string, unknown>,
      )
      for (const key of unknown_properties) {
        // Counted ALWAYS; pushed only while the page has room.
        undeclaredPropertyDriftTotal++
        if (undeclaredPropertyDrift.length >= limit) continue
        undeclaredPropertyDrift.push({
          id: node.id,
          type: node.type as string,
          property: key,
        })
      }
    }

    // New drift class; property_type_drift. F4 (2026-05-20).
    // Reports declared properties on the node whose value type doesn't match
    // the schema's declared type. Undeclared properties are covered by
    // `undeclared_property_drift` above.
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

  // ── Header seal: counts_drift + integrity_drift (feedback 1bb903bf) ───────
  //
  // `$upg.counts` and `$upg.integrity.body` are derived data the serialiser
  // stamps from the body it writes. Nothing ever read them back, so a `.upg`
  // whose header had fallen out of step with its body passed every drift class
  // clean. The reachable path is an ordinary git merge: two branches each append
  // one node, git merges the bodies without conflict but takes the identical
  // `"nodes": 1273 → 1274` header hunk once, and the merged file declares 1274
  // while holding 1275. No conflict marker, no warning, a silently wrong graph.
  //
  // We check the FILE against ITSELF, re-reading it rather than comparing the
  // header to the in-memory store. That is deliberate:
  //
  //   - Self-consistency is a property of the artifact. Asking "does this file's
  //     header match this file's body?" has one right answer regardless of
  //     session state, and it is the question a corrupted merge gets wrong.
  //   - Comparing a load-time header against the LIVE store would misfire on
  //     every unsaved edit — create a node and the counts legitimately differ.
  //     There is no honest way to distinguish "stale seal" from "unflushed
  //     write" on that axis, so we do not put the two on the same axis.
  //   - The read is inert: no lock, no baseline update, no mtime write. It
  //     cannot manufacture a CONFLICT, and a pending debounced save simply means
  //     we assess the last-written file, which is itself self-consistent.
  //
  // A legacy flat file (no `$upg` block) declares nothing and so can drift in
  // neither class — `checkHeaderSeal` reports both empty for it.
  let headerSealNote: string | undefined
  if (includes('counts_drift') || includes('integrity_drift')) {
    try {
      const raw = readFileSync(store.getFilePath(), 'utf-8')
      const seal = checkHeaderSealText(raw)
      if (includes('counts_drift')) countsDrift.push(...seal.counts_drift.slice(0, limit))
      if (includes('integrity_drift')) integrityDrift.push(...seal.integrity_drift.slice(0, limit))
      if (seal.skipped_reason) headerSealNote = seal.skipped_reason
    } catch (err) {
      // The file moved, was deleted, or stopped being JSON since load. That is
      // worth SAYING rather than reporting as a clean seal — but it is also not
      // header drift, so it must not silently flip the structural verdict.
      headerSealNote =
        `header seal not checked: could not re-read ${store.getFilePath()} ` +
        `(${err instanceof Error ? err.message : String(err)}).`
    }
  }

  // ── Anti-pattern evaluation ─────────────────────────────────────
  // Pure evaluator over pre-computed inputs. The collector walks the store
  // once and returns the 7-field stats shape consumed by `evaluateAntiPatterns`.
  let antiPatternViolations: ValidateGraphAntiPatternViolation[] | undefined
  // Validation-profile gating (0.17.0): the graph's member kind decides which
  // fired anti-patterns gate `valid` vs are advisory. `advisoryProfile` names the
  // kind when a non-product profile demoted at least one fired violation.
  let antiPatternGatingCount = 0
  let advisoryProfile: string | undefined
  // 0.30.0: findings that fired only in the union, suppressed as superposition
  // artifacts. Counted rather than dropped silently, so the suppression itself
  // is visible in the response.
  let suppressedUnionArtifacts = 0
  if (!skipAntiPatterns) {
    const productStage = store.getProduct().stage as UPGProductStage | undefined
    // The graph's own $upg.member_kind wins; a product listed in a `watched`
    // portfolio (portfolio-level posture) is treated as watched. (0.17.0)
    const ownKind = store.getMemberKind()
    const effectiveKind =
      ownKind !== 'product'
        ? ownKind
        : classifyProductKind(process.cwd(), store.getProduct().id) === 'watched'
          ? 'watched'
          : 'product'
    // When the caller named a configuration, evaluate THAT one and report it
    // plainly. The per-projection sweep below exists to stop the union from
    // inventing findings; a caller who already chose a member of the family
    // does not need it, and annotating every finding with the configuration
    // they just asked for would be noise.
    const antiPatternSource = explicitConfiguration.reader
      ? ({
          getAllNodes: () => explicitConfiguration.reader!.getAllNodes(),
          getAllEdges: () => {
            // Deduplicate by identity through a Map. The reader exposes edges
            // per node, so every edge is seen from both endpoints; a findIndex
            // scan here is quadratic in edge count on a graph large enough to
            // have configurations worth projecting.
            const seen = new Map<string, ReturnType<typeof store.getAllEdges>[number]>()
            for (const n of explicitConfiguration.reader!.getAllNodes()) {
              for (const e of explicitConfiguration.reader!.getEdgesForNode(n.id)) {
                const key = e.id ?? `${e.source}|${e.type}|${e.target}`
                if (!seen.has(key)) seen.set(key, e)
              }
            }
            return [...seen.values()]
          },
          getProduct: () => store.getProduct(),
        } as unknown as Parameters<typeof collectAntiPatternInputs>[0])
      : store
    const inputs = collectAntiPatternInputs(antiPatternSource, productStage)
    inputs.memberKind = effectiveKind
    const totalNodeCount = store.getAllNodes().length
    const evalOptions = {
      severity: severityArg as UPGAntiPatternSeverity | undefined,
      anti_pattern_ids: antiPatternIds,
    }
    const unionViolations = evaluateAntiPatterns(inputs, evalOptions)

    // ── Per-projection evaluation (0.30.0, D4) ────────────────────────────
    // In the UNION, alternatives double-count: a surface that exists only under
    // one value and its alternative that exists only under another BOTH carry
    // their occupancy edges, so a contention check reading the union sees a
    // place holding more than any configuration ever renders. That is exactly
    // the false-positive class 0.29.0 spent a release removing, and it would
    // come straight back the moment anyone declared an axis.
    //
    // The fix is cheap because the evaluator never sees nodes or edges: it
    // reads pre-aggregated inputs from a duck-typed collector. So a projection
    // pass is the same collector over a filtered node/edge set, which is what
    // §5.3 of the design bought by insisting 0.29.0's capacity check go through
    // the collector rather than walking the live store.
    const projections = enumerateProjections(
      store.getAllNodes() as unknown as Parameters<typeof enumerateProjections>[0],
    )
    const hasAxes = projections.length > 1 && !explicitConfiguration.reader

    // Per anti-pattern: WHERE it fired, and the violation each projection
    // produced. Keeping the whole violation rather than just the id is what
    // lets a projection-only finding be reported at all, and what lets a
    // qualified finding carry node ids derived from the projections it holds
    // in rather than from the superposed union.
    interface ProjectionFiring {
      configurations: Array<{ axis: string; value: string }>
      violations: ReturnType<typeof evaluateAntiPatterns>
    }
    const firedIn = new Map<string, ProjectionFiring>()
    let projectionCount = 0
    if (hasAxes) {
      for (const p of projections) {
        if (!p.axis || !p.value) continue // the union entry, already evaluated
        projectionCount++
        const projected = projectGraph(
          store.getAllNodes() as never[],
          store.getAllEdges() as never[],
          p.configuration,
        )
        const projectedInputs = collectAntiPatternInputs(
          {
            getAllNodes: () => projected.nodes,
            getAllEdges: () => projected.edges,
            getProduct: () => store.getProduct(),
          } as unknown as Parameters<typeof collectAntiPatternInputs>[0],
          productStage,
        )
        projectedInputs.memberKind = effectiveKind
        for (const v of evaluateAntiPatterns(projectedInputs, evalOptions)) {
          const entry = firedIn.get(v.anti_pattern_id) ?? { configurations: [], violations: [] }
          entry.configurations.push({ axis: p.axis, value: p.value })
          entry.violations.push(v)
          firedIn.set(v.anti_pattern_id, entry)
        }
      }
    }

    // Reporting model. A finding that fires in EVERY projection is invariant
    // and reports unqualified, exactly as it always did. One that fires in SOME
    // is reported once, annotated with where it holds. One that fires ONLY in
    // the union is an artifact of superposition: it is suppressed, and counted,
    // because surfacing it recreates the bug, and suppressing it silently would
    // hide a real one.
    // THE PROJECTIONS DECIDE, NOT THE UNION. Once a graph declares axes the
    // reported set is built FROM the per-projection firings, not filtered out of
    // the union list. Filtering could only ever remove, which silently lost
    // every finding that fires in a configuration but not in the superposed
    // graph: the catalog has eleven `not_exists` patterns, and those are exactly
    // non-monotone. A job edge riding a surface that exists only under one value
    // makes `surface-without-job` true under the other value and false in the
    // union, and the caller heard nothing.
    //
    //   fires in every projection  -> invariant, reported unqualified
    //   fires in some projections  -> reported once, annotated with where
    //   fires only in the union    -> superposition artifact, suppressed + counted
    //
    // Node ids come from the projections the finding actually holds in, so a
    // qualified finding can never carry the union's double-counted ids.
    let violations: ReturnType<typeof evaluateAntiPatterns>
    const configurationsById = new Map<string, Array<{ axis: string; value: string }>>()
    if (hasAxes) {
      const merged: ReturnType<typeof evaluateAntiPatterns> = []
      for (const [id, entry] of firedIn) {
        const ids = new Set<string>()
        for (const v of entry.violations) for (const nid of v.target_node_ids ?? []) ids.add(nid)
        const representative = { ...entry.violations[0]! }
        representative.target_node_ids = ids.size > 0 ? [...ids].sort() : undefined
        merged.push(representative)
        // Qualified only when it does NOT hold everywhere. A finding true in
        // every configuration is reported plainly, which is what keeps an
        // unqualified graph's output identical to the previous release.
        if (entry.configurations.length < projectionCount) {
          configurationsById.set(id, entry.configurations)
        }
      }
      merged.sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 } as const
        const d = order[a.severity] - order[b.severity]
        return d !== 0 ? d : a.anti_pattern_id.localeCompare(b.anti_pattern_id)
      })
      violations = merged
      const suppressed = unionViolations.filter((v) => !firedIn.has(v.anti_pattern_id)).length
      if (suppressed > 0) suppressedUnionArtifacts = suppressed
    } else {
      violations = unionViolations
    }

    antiPatternViolations = violations.map((v) => {
      // A fired violation gates `valid` iff its concern is gated by the member-kind
      // profile AND it is not a coverage pattern softened on a still-thin graph
      // (companion C). Thinness-softened and profile-demoted violations still
      // report, with gating:false.
      const gating =
        concernGatesFor(effectiveKind, v.concern) &&
        !isThinCoverageAdvisory(v.anti_pattern_id, totalNodeCount)
      if (gating) antiPatternGatingCount++
      return {
        anti_pattern_id: v.anti_pattern_id,
        name: v.name,
        severity: v.severity,
        concern: v.concern,
        gating,
        target_entities: v.target_entities,
        ...(v.target_node_ids ? { target_node_ids: v.target_node_ids } : {}),
        // Which configurations this finding actually holds in. Present only
        // when the graph declares axes AND the finding is not universal: a
        // violation true everywhere is reported unqualified, as before.
        ...(configurationsById.has(v.anti_pattern_id)
          ? { configurations: configurationsById.get(v.anti_pattern_id) }
          : {}),
        description: v.description,
        why_it_matters: v.why_it_matters,
        remediation: v.remediation,
        source: v.source,
      }
    })
    // A non-product profile demoted at least one fired violation to advisory.
    if (effectiveKind !== 'product' && antiPatternViolations.length > antiPatternGatingCount) {
      advisoryProfile = effectiveKind
    }
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
    // The PAGE, not the true total. This estimates bytes about to go on the
    // wire, and only the capped array is sent — feeding the uncapped count here
    // made the guard refuse `validate_graph` outright on the 1,118-node tracker,
    // whose true count is 5,956 against a 100-entry page. A summary figure and a
    // payload estimate answer different questions and must not share a variable.
    undeclaredPropertyDrift.length +
    polymorphicUpgradeHints.length +
    parityDivergence.length +
    countsDrift.length +
    integrityDrift.length +
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
    propertyTypeDrift.length === 0 &&
    // Header seal (feedback 1bb903bf). These two DO gate `structurally_valid`,
    // on the existing contract's own terms: it promises "every drift class is
    // empty", and a header that lies about its body is not spec-shaped — the
    // spec defines `$upg.counts` / `$upg.integrity` as derivations OF the body,
    // so a file where the derivation no longer holds violates the format.
    //
    // Worth stating plainly, because it widens what the flag ranges over: every
    // other class judges the loaded GRAPH, these two judge the FILE. A stale
    // seal after a hand-merge is a different failure from a deprecated entity
    // type — the graph content may be perfectly fine and only the header wrong.
    // We fold them in anyway, because the CI conformance gate that reads
    // `structurally_valid` is exactly the thing that must catch a corrupted
    // merge, and a signal that stays green through one is worth little. The
    // repair is also unusually cheap and total: `upg fmt` reseals both fields.
    countsDrift.length === 0 &&
    integrityDrift.length === 0 &&
    // Configuration drift, ERRORS only (0.30.0). A graph whose declarations
    // contradict each other cannot be projected reliably, and the checks say so
    // in their own messages, so returning valid:true to a CI gate would be the
    // signal contradicting its own text. The single WARNING class
    // (orphaned_under_projection) deliberately does not gate: the graph is
    // coherent there, one of its projections just has a gap.
    configurationDriftErrorCount === 0
  const driftClean = skipDrift || structurallyClean
  // Anti-pattern gating is member-kind-profile-driven (0.17.0, supersedes the
  // hard-coded `watched` branch of spec #39). Only GATING violations — those whose
  // concern the kind's profile gates — flip `valid`; advisory ones are reported
  // but do not. watched gates nothing; org_rollup gates universal only; an
  // operating_function graph gates universal + operating and never sees the
  // product spine. `watched_intelligence_graph` is retained for back-compat.
  const watchedGraph = advisoryProfile === 'watched'
  const antiPatternClean = skipAntiPatterns || antiPatternGatingCount === 0
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
    ...(advisoryProfile ? { advisory_profile: advisoryProfile } : {}),
    // 0.30.0: findings that fired only in the union and in no single
    // configuration. Suppressed because reporting them recreates the
    // double-count false positive; counted because suppressing silently
    // would hide a real one.
    ...(suppressedUnionArtifacts > 0
      ? { suppressed_union_artifacts: suppressedUnionArtifacts }
      : {}),
    // Echo what was actually applied, so a reader never has to infer from the
    // findings which member of the family they are looking at.
    ...(explicitConfiguration.configuration
      ? { applied_configuration: explicitConfiguration.configuration }
      : {}),
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
      anti_pattern_violations_gating: skipAntiPatterns ? undefined : antiPatternGatingCount,
      edge_type_pair_drift: edgeTypePairDrift.length,
      graph_topology_self_loops: graphTopologySelfLoops.length,
      property_type_drift: propertyTypeDrift.length,
      undeclared_property_drift: undeclaredPropertyDriftTotal,
      counts_drift: countsDrift.length,
      integrity_drift: integrityDrift.length,
      configuration_drift: skipDrift ? undefined : configurationDrift.length,
      polymorphic_upgrade_hints: includePolymorphicUpgrades ? polymorphicUpgradeHints.length : undefined,
      parity_divergence: parityDivergence.length > 0 ? parityDivergence.length : undefined,
    },
    _hash: currentHash,
  } as ValidateGraphResult & {
    structurally_valid?: boolean
    edge_type_pair_drift?: EdgeTypePairDriftEntry[]
    graph_topology_self_loops?: GraphTopologySelfLoopEntry[]
    property_type_drift?: PropertyTypeDriftEntry[]
    undeclared_property_drift?: Array<{ id: string; type: string; property: string }>
    polymorphic_with_typed_alternative?: PolymorphicUpgradeHintEntry[]
    parity_divergence?: ParityDivergenceEntry[]
    counts_drift?: CountsDriftEntry[]
    integrity_drift?: IntegrityDriftEntry[]
    header_seal_note?: string
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
    if (includes('undeclared_property_drift')) response.undeclared_property_drift = undeclaredPropertyDrift
    if (includes('counts_drift')) response.counts_drift = countsDrift
    if (includes('integrity_drift')) response.integrity_drift = integrityDrift
    // Emitted whenever the scope includes it, empty or not, exactly like every
    // sibling drift class. An array that appears only when something is wrong
    // makes "no configuration drift" indistinguishable from "this server does
    // not check for it".
    if (includes('configuration_drift')) response.configuration_drift = configurationDrift
    // Why a seal check was skipped (unrecognised format_version / algorithm, or
    // an unreadable file). Surfaced only when there is something to say, so a
    // normal clean run stays quiet.
    if (headerSealNote) response.header_seal_note = headerSealNote
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
      ...(v.target_node_ids ? { target_node_ids: v.target_node_ids } : {}),
      remediation: v.remediation,
    })),
  }
  return text(JSON.stringify(response, null, 2))
}

// ─── Reverse lookup: get_anti_pattern_violations_for ───────────────

/**
 * Reverse-lookup helper: given an entity id, return the anti-pattern
 * violations that implicate it.
 *
 * Matching is per-id where the detector could name nodes (0.29.0) and per-type
 * otherwise, with `matched_by` on each returned violation saying which. The
 * distinction matters: a type match means every entity of that type gets the
 * same answer, which is why a graph could once be modelled correctly and still
 * show its whole roster as implicated.
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
 * @returns JSON: `{ entity_id, type, violations: [...] }`, each violation
 *   carrying `matched_by: 'node' | 'type'`.
 * @throws textError when `entity_id` is missing or unknown.
 * @atomicity atomic (read-only)
 * @warning A `matched_by: 'type'` violation is an approximation: the detector
 *   is a whole-graph check that cannot name nodes, so every entity of that type
 *   shares the result. Treat those as "worth looking at", and `matched_by:
 *   'node'` as "this entity specifically".
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
  // 0.29.0: ids narrow the answer for the types they actually cover, and
  // change nothing for the types they do not.
  //
  // Attribution is PARTIAL by nature. The contention detector names surfaces,
  // never the features occupying them, even though `feature` is in
  // `target_entities` because the condition references it. So "the violation
  // names ids, therefore match by id alone" silently drops every feature that
  // used to match, which is a reachability regression rather than precision.
  //
  // The rule that gives precision where precision exists, and costs nothing
  // where it does not: work out which TYPES this violation actually attributed
  // (by resolving its ids), and treat the id list as authoritative for those
  // types only. Everything else keeps matching by type exactly as before.
  //
  //   surface (attributed)     → in the id list?  yes: matched. no: cleared.
  //   feature (not attributed) → matches by type, as it always did.
  //
  // The clearing half is the point of the feature: 14 correctly-declared
  // chained slots kept the entire surface roster lit, and no amount of correct
  // modelling could clear it. The keeping half is what stops that fix from
  // quietly making features unreachable.
  const matched: Array<{ v: (typeof allViolations)[number]; matchedBy: 'id' | 'type' }> = []
  for (const v of allViolations) {
    const ids = v.target_node_ids ?? []
    if (ids.includes(entityId)) {
      matched.push({ v, matchedBy: 'id' })
      continue
    }
    // Types this violation named at least one node of. Resolved through the
    // store because a violation carries ids, not the types behind them.
    const attributedTypes = new Set<string>()
    for (const id of ids) {
      const t = store.getNode(id)?.type as string | undefined
      if (t) attributedTypes.add(t)
    }
    if (attributedTypes.has(nodeType)) continue // id list is authoritative here
    if (v.target_entities.includes(nodeType)) matched.push({ v, matchedBy: 'type' })
  }

  return text(
    JSON.stringify(
      {
        entity_id: entityId,
        type: nodeType,
        violations: matched.map(({ v, matchedBy }) => ({
          anti_pattern_id: v.anti_pattern_id,
          name: v.name,
          severity: v.severity,
          // How this violation reached this entity. `id` means the detector
          // named this node specifically. `type` means it could only name the
          // type, so the match is an approximation over every entity of that
          // type and should be read as "worth looking at", not "at fault".
          matched_by: matchedBy,
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
