/**
 * Five canonical envelopes for atomicity-sensitive MCP tools.
 *
 *   - `migrate_type`        → `MigrateTypeResult`
 *   - `migrate_properties`  → `MigratePropertiesResult` (future)
 *   - `validate_graph`      → `ValidateGraphResult`
 *   - `rename_edge_type`    → `RenameEdgeTypeResult`
 *   - `export_edges`        → `ExportEdgesResult`
 *
 * Servers cast their JSON-stringified payload through these at the
 * boundary. TypeScript fires on drift. The wire stays `text`-content
 * (`ToolResult`); these types govern the JSON inside.
 *
 * Routine reads (`list_nodes`, `get_node`, `query`) keep server-specific
 * shapes.
 *
 * @atomicity see `@atomicity` JSDoc on each handler in the consuming server.
 */

/* ---------------------------------------------------------------------------
 * migrate_type: node-type rename + catalog-aware edge migration
 * ------------------------------------------------------------------------- */

/**
 * Rename rule applied to one edge. `from` is the pre-migration type, `to`
 * is the new canonical, and `flipped` is true when source/target were
 * swapped because the new catalog entry inverts direction.
 */
export interface MigrateTypeEdgeRename {
  id: string
  from: string
  to: string
  flipped: boolean
}

/**
 * Drop rule applied to one edge. Its type was retired in
 * `UPG_EDGE_MIGRATIONS` without a replacement.
 */
export interface MigrateTypeEdgeDrop {
  id: string
  from: string
}

/**
 * Edge type that fired no migration rule and is also absent from
 * `UPG_EDGE_CATALOG`. Surfaced as a count rather than a rule, so the
 * caller decides whether to leave them, hand-migrate via
 * `rename_edge_type`, or escalate.
 */
export interface MigrateTypeUnmappedLegacyEdge {
  type: string
  count: number
}

/**
 * Canonical envelope returned by `migrate_type` (both dry-run and apply).
 *
 * With `dry_run: true`, counts and arrays describe the planned mutations.
 * With `dry_run: false`, the same fields are populated from the actual
 * migration result.
 *
 * `defaults_applied` is the property defaults pulled from the active rule
 * (for example, `pain_point → need` adds `valence: 'pain'`). It is `null`
 * when the rule has no defaults or the migration is direct.
 */
export interface MigrateTypeResult {
  migrated_nodes: number
  migrated_edges: number
  edge_renames: MigrateTypeEdgeRename[]
  dropped_edges: MigrateTypeEdgeDrop[]
  unmapped_legacy_edges: MigrateTypeUnmappedLegacyEdge[]
  defaults_applied: Record<string, unknown> | null
  dry_run: boolean
}

/* ---------------------------------------------------------------------------
 * migrate_properties: property rename / lift / drop pass (future)
 * ------------------------------------------------------------------------- */

/**
 * Property change applied to one node. `kind` matches the
 * `UPGPropertyMigration` discriminator (`lift_property_to_top_level`,
 * `rename_top_level`, `drop_props`, `drop_when_self_referential`).
 *
 * The full shape will solidify when `migrate_properties` ships. This is
 * the contract stub the cloud and local servers conform to.
 */
export interface MigratePropertiesNodeChange {
  id: string
  type: string
  kind: 'lift_property_to_top_level' | 'rename_top_level' | 'drop_props' | 'drop_when_self_referential'
  /** Pre-migration property key(s). */
  from: string | string[]
  /** Post-migration property key (when applicable). */
  to?: string
  via: string
}

/**
 * Canonical envelope returned by `migrate_properties` (future tool).
 *
 * Pinned here so the eventual implementation lands on the contract from
 * the first PR.
 */
export interface MigratePropertiesResult {
  migrated_nodes: number
  migrated_properties: number
  changes: MigratePropertiesNodeChange[]
  dry_run: boolean
}

/* ---------------------------------------------------------------------------
 * migrate_status: legacy status value → canonical lifecycle phase
 * ------------------------------------------------------------------------- */

/**
 * Status change applied to one node by `migrate_status`. `from` is the
 * pre-migration value, `to` is the canonical phase from
 * `UPG_STATUS_MIGRATIONS[type][from]`.
 */
export interface MigrateStatusNodeChange {
  id: string
  type: string
  from: string
  to: string
}

/**
 * Canonical envelope returned by `migrate_status`. Mirrors the
 * `migrate_type` / `migrate_properties` family: dry-run preview and apply
 * branch share the same fields.
 *
 * With `dry_run: true`, `changes` describes the planned mutations.
 * With `dry_run: false`, the same fields describe the realised mutations.
 *
 * `migrated_nodes` is the total mutated count. `skipped_no_migration` is
 * the count of nodes whose current status is invalid (per the type's
 * lifecycle) but for which `UPG_STATUS_MIGRATIONS` has no registered
 * replacement; surfaced so callers can decide to operator-handle the
 * residue rather than silently leave drift.
 */
export interface MigrateStatusResult {
  migrated_nodes: number
  skipped_no_migration: number
  changes: MigrateStatusNodeChange[]
  dry_run: boolean
}

/* ---------------------------------------------------------------------------
 * validate_graph: per-class drift report
 * ------------------------------------------------------------------------- */

export type ValidateGraphScope =
  | 'all'
  | 'entity_drift'
  | 'edge_drift'
  | 'property_drift'
  | 'top_level_drift'
  | 'lifecycle_drift'
  | 'self_referential'
  | 'configuration_drift'

/**
 * One configuration-drift finding, surfaced by `validate_graph` (0.30.0).
 *
 * Contradictions inside the configuration declarations themselves: an axis that
 * declares no values, a `present_under` naming a value the axis does not have,
 * the `active_when` qualifier on an edge type it is not legal on, a declared
 * alternation whose endpoints can both be present at once. Errors mean a
 * projection of this graph cannot be trusted; the single warning
 * (`orphaned_under_projection`) means the graph is coherent but one of its
 * projections has a gap.
 */
export interface ValidateGraphConfigurationDrift {
  kind: string
  severity: 'error' | 'warning'
  node_id?: string
  edge_id?: string
  axis_id?: string
  message: string
}

export interface ValidateGraphSummary {
  /** UPG spec version the validation ran against. */
  spec_version: string
  /** Echoed scope filter from the request. */
  scope: ValidateGraphScope
  /** Echoed limit applied to each per-class array. */
  limit: number
  /** Per-class counts. Implementations may add fields; these are required. */
  entity_drift: number
  edge_drift: number
  property_drift?: number
  top_level_drift?: number
  lifecycle_drift?: number
  self_referential?: number
  [key: string]: unknown
}

export type ValidateGraphEntitySuggestion =
  | { kind: 'rename'; to: string; via: string }
  | { kind: 'split'; to: string[]; via: string }
  | { kind: 'unknown' }

export interface ValidateGraphEntityDrift {
  id: string
  type: string
  title: string
  suggested_migration: ValidateGraphEntitySuggestion
}

export type ValidateGraphEdgeSuggestion =
  | { kind: 'rename'; to: string; flip?: boolean; via: string }
  | { kind: 'drop'; via: string }
  | { kind: 'unknown' }

export interface ValidateGraphEdgeDrift {
  id: string
  type: string
  source: string
  target: string
  suggested_migration: ValidateGraphEdgeSuggestion
}

export interface ValidateGraphTopLevelDrift {
  id: string
  type: string
  unknown_fields: string[]
}

/**
 * Suggested fix attached to a `lifecycle_drift` entry. Present only when
 * `UPG_STATUS_MIGRATIONS[type][status]` resolves to a canonical replacement
 * (and the replacement differs from the current value). Lets the caller
 * chain into `migrate_status` without re-deriving the plan.
 *
 * `via` is the registry symbol the suggestion was sourced from, kept as a
 * string for consistency with the entity/edge/property suggestions on the
 * same envelope.
 */
export interface ValidateGraphLifecycleSuggestion {
  kind: 'migrate_status'
  to: string
  via: string
}

export interface ValidateGraphLifecycleDrift {
  id: string
  type: string
  status: string
  valid_phases: string[]
  /**
   * Optional canonical replacement target from `UPG_STATUS_MIGRATIONS`.
   * Absent when no automated migration is registered for the
   * (type, status) pair; surface to the operator.
   */
  suggested_migration?: ValidateGraphLifecycleSuggestion
}

export interface ValidateGraphSelfReferential {
  id: string
  fields: string[]
}

export interface ValidateGraphPropertyDrift {
  id: string
  type: string
  property: string
  via: string
}

/**
 * One fired anti-pattern from `UPG_ANTI_PATTERNS`.
 *
 * `target_entities` carries the entity-type strings the catalog references.
 * Phase 1 keeps these as types; Phase 1.x will promote to specific entity
 * ids once the input collector tracks them.
 */
export interface ValidateGraphAntiPatternViolation {
  anti_pattern_id: string
  name: string
  severity: 'high' | 'medium' | 'low'
  /** Concern family (0.17.0): product_spine | universal | operating. */
  concern?: 'product_spine' | 'universal' | 'operating'
  /** Whether this fired violation gates `valid` under the graph's member-kind
   *  validation profile (0.17.0). false = reported but advisory. */
  gating?: boolean
  target_entities: string[]
  /**
   * The specific nodes this violation is about (0.29.0), when the fired
   * condition could name them.
   *
   * Additive and optional: a consumer that ignores it behaves exactly as
   * before, and a violation without it is not thereby about nothing. Most
   * detectors here are whole-graph approximations of per-node rules, so they
   * can report a problem without locating it; only per-node checks and declared
   * filters attribute. Narrow work with this when it is present, and keep
   * falling back to `target_entities` when it is not.
   */
  target_node_ids?: string[]
  /**
   * The configurations this finding holds in (0.30.0).
   *
   * Present only when the graph declares configuration axes AND the finding is
   * not universal. A finding true in every configuration reports unqualified,
   * which is what keeps an unqualified graph's output identical to earlier
   * releases. Absent therefore means "true everywhere, or this graph has no
   * axes", never "true nowhere".
   */
  configurations?: Array<{ axis: string; value: string }>
  description: string
  why_it_matters: string
  remediation: string
  source?: unknown
}

/**
 * Canonical envelope returned by `validate_graph`.
 *
 * Each per-class array appears only when the requested `scope` includes
 * that class (or `scope === 'all'`). `_hash` is the content hash of the
 * graph at validation time, used by `if_changed_since` short-circuiting.
 *
 * Anti-pattern evaluation extends this. The `valid` field is true when
 * schema drift is empty and zero anti-pattern violations fired, so
 * callers reading `validate_graph().valid` get a stricter health check.
 * Schema-drift fields and anti-pattern fields stay clearly separated so
 * the agent's mental model can keep them distinct.
 *
 * `structurally_valid` (N4) is the spec-conformance axis on its own: true
 * when every schema-drift class is empty, independent of anti-pattern
 * health. CI conformance gates should read this rather than `valid`, which
 * also fails on product-health anti-patterns.
 *
 * `_warning` is the payload-guard soft-warning channel. When the
 * serialized response approaches the soft byte limit, the local server
 * attaches a human-readable hint (for example, "narrow scope, lower
 * limit"). It is part of the canonical contract, so consumers can
 * surface it without unknown-casting.
 */
export interface ValidateGraphResult {
  /**
   * Stricter-than-drift-only health check. True when schema drift
   * is empty and `anti_pattern_violations` is empty.
   */
  valid?: boolean
  /**
   * Pure structural-conformance verdict (N4). True iff every schema-drift
   * class is empty, independent of anti-pattern health. Omitted when the
   * caller passes `skip_drift: true` (structure was not assessed). Read this,
   * not `valid`, for a CI gate that asks "is this graph spec-shaped?".
   */
  structurally_valid?: boolean
  /**
   * Set when the graph's member-kind validation profile demoted at least one
   * fired anti-pattern to advisory (0.17.0): the member kind whose profile applied
   * (`watched` / `org_rollup` / `operating_function`). Absent for a plain product
   * graph. `watched_intelligence_graph` is retained alongside for back-compat.
   */
  advisory_profile?: string
  summary: ValidateGraphSummary
  entity_drift?: ValidateGraphEntityDrift[]
  edge_drift?: ValidateGraphEdgeDrift[]
  top_level_drift?: ValidateGraphTopLevelDrift[]
  lifecycle_drift?: ValidateGraphLifecycleDrift[]
  self_referential?: ValidateGraphSelfReferential[]
  property_drift?: ValidateGraphPropertyDrift[]
  /**
   * Configuration-declaration contradictions (0.30.0). Emitted whenever the
   * requested scope includes it, empty or not, like every sibling drift class.
   * ERROR-severity entries gate `valid` and `structurally_valid`; the single
   * warning class does not.
   */
  configuration_drift?: ValidateGraphConfigurationDrift[]
  /**
   * How many findings fired ONLY against the superposed union and in no single
   * configuration (0.30.0). Those are artifacts of reading every configuration
   * at once, so they are suppressed rather than reported; the count is here so
   * the suppression is visible rather than silent.
   */
  suppressed_union_artifacts?: number
  /**
   * The configuration actually applied to this run, echoed back (0.30.0).
   * Absent when the whole family was evaluated.
   */
  applied_configuration?: Record<string, string>
  /** Anti-pattern violations from `UPG_ANTI_PATTERNS`. */
  anti_pattern_violations?: ValidateGraphAntiPatternViolation[]
  /** Graph content hash. Supports the `if_changed_since` cache. */
  _hash?: string
  /** Payload-guard soft-warning hint. Present when the response
   *  approached the soft byte limit; absent on healthy payloads. */
  _warning?: string
  /** Payload-guard byte count, paired with `_warning`. */
  _payload_bytes?: number
  /** Human-readable notes about validation scope or known limitations. */
  notes?: string[]
}

/* ---------------------------------------------------------------------------
 * rename_edge_type: exact-match edge type rename
 * ------------------------------------------------------------------------- */

export interface RenameEdgeTypeSampleEdge {
  id: string
  source: string
  target: string
  type: string
}

/**
 * Canonical envelope returned by `rename_edge_type`.
 *
 * With `dry_run: true`, the result populates `would_rename` and `sample`.
 * With `dry_run: false`, the result populates `renamed` and `ids`. Both
 * branches echo `from`, `to`, and `flip`.
 */
export type RenameEdgeTypeResult =
  | {
      dry_run: true
      from: string
      to: string
      flip: boolean
      would_rename: number
      sample: RenameEdgeTypeSampleEdge[]
    }
  | {
      dry_run: false
      from: string
      to: string
      flip: boolean
      renamed: number
      ids: string[]
    }

/* ---------------------------------------------------------------------------
 * export_edges: flat edge enumeration for migration and canonicalisation
 * ------------------------------------------------------------------------- */

export interface ExportEdgesEdge {
  id: string
  source: string
  target: string
  type: string
  /** Present when the edge has a recorded mapping_confidence. */
  mapping_confidence?: string
}

/**
 * Canonical envelope returned by `export_edges`.
 *
 * `types` is echoed only when the caller filtered. Pagination uses
 * `offset` and `limit`; `total` is the unfiltered (post-types-filter)
 * count.
 */
export interface ExportEdgesResult {
  edges: ExportEdgesEdge[]
  total: number
  offset: number
  limit: number
  types?: string[]
  /** Graph content hash. Supports the `if_changed_since` cache. */
  _hash?: string
  /** Payload-guard soft-warning channel (mirrors ValidateGraphResult). */
  _warning?: string
  /** Payload byte count, paired with `_warning`. */
  _payload_bytes?: number
}
