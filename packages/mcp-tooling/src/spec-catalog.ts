/**
 * Faceted spec-catalog surface (UPG 0.19.0 tool consolidation, Phase 1).
 *
 * Collapses the ~40 static-spec introspection tools (`list_*` / `get_*` over
 * `@unified-product-graph/core`) behind TWO faceted tools — `list_catalog`
 * and `get_catalog_entry` — while the retired tools stay registered
 * (additive phase; nothing is removed until Phase 2 ratifies parity).
 *
 * ## Why this module is the single source of truth
 *
 * Both servers (`mcp-server`, `cloud-server`) import the two `kind` enums, the
 * two `ToolDefinition`s, and the two handler factories from here. The enum
 * membership is therefore shared at COMPILE TIME: each server hands the factory
 * a `Record<CatalogListKind, ListDispatchEntry>` / `Record<CatalogGetKind,
 * GetDispatchEntry>`, so a kind added here without a wired handler on either
 * server is a `tsc` error, not a runtime drift. This is the structural-parity
 * property the consolidation plan (§2) requires.
 *
 * ## Why DELEGATION, not re-implementation
 *
 * Phase 1's mandate is the strongest possible parity proof: the retired
 * handlers remain the untouched, trusted ORACLE, and the new facets reach the
 * same data by DELEGATING to them. `list_catalog({ kind: 'playbooks' })`
 * literally calls the server's existing `list_playbooks` handler and returns
 * its result verbatim — so byte-identical output is guaranteed BY
 * CONSTRUCTION, not merely asserted by the gate. The gate then proves the
 * remaining, still-meaningful things: completeness (every retired tool has a
 * kind), correct routing (a kind maps to the right handler, caught by
 * comparing to the independently-named retired tool), and arg passthrough
 * (filters / id survive the facet layer).
 *
 * A plain-data re-implementation of 40 bespoke envelopes/filters/paginations
 * would (a) duplicate a large drift surface and (b) — if the retired handlers
 * were later refactored to share that builder — destroy the independence of
 * the oracle. Migrating handler BODIES into this module as transport-agnostic
 * builders is a Phase-2 option, correct only once the retired tools are gone.
 *
 * This module is core-free: it routes to handlers, it does not read the spec.
 */

import type { ToolDefinition, ToolHandler } from './tool-definition.js'
import { textError } from './result.js'

/* ---------------------------------------------------------------------------
 * Kind enums — the single source of truth for facet membership.
 *
 * `CATALOG_LIST_KINDS` mirrors the 25 retired `list_*` tools; each server must
 * provide a dispatch entry per kind (typed `Record<CatalogListKind, …>`).
 * `CATALOG_GET_KINDS` mirrors the 15 retired `get_*-by-id` tools.
 * ------------------------------------------------------------------------- */

export const CATALOG_LIST_KINDS = [
  'entity_types',
  'edge_types',
  'cross_edge_types',
  'regions',
  'domains',
  'domain_rings',
  'frameworks',
  'framework_categories',
  'framework_structure_patterns',
  'lenses',
  'lifecycles',
  'playbooks',
  'scales',
  'anti_patterns',
  'tree_patterns',
  'templates',
  'approaches',
  'type_labels',
  'status_values',
  'product_stages',
  'benchmarks',
  'edge_migrations',
  'scalar_to_edge_migrations',
  'split_migrations',
  'type_migrations',
] as const
export type CatalogListKind = (typeof CATALOG_LIST_KINDS)[number]

export const CATALOG_GET_KINDS = [
  'entity_meta',
  'edge_type',
  'region',
  'domain_guide',
  'domain_ring',
  'framework',
  'lens',
  'lifecycle',
  'playbook',
  'scale',
  'anti_pattern',
  'tree_pattern',
  'type_label',
  'template',
  'approach',
] as const
export type CatalogGetKind = (typeof CATALOG_GET_KINDS)[number]

/* ---------------------------------------------------------------------------
 * Dispatch contracts.
 * ------------------------------------------------------------------------- */

export interface ListDispatchEntry<TContext> {
  /** The retired `list_<kind>` handler this facet delegates to. */
  handler: ToolHandler<TContext>
  /**
   * Optional arg remap (facet args, minus `kind`, → delegated handler args).
   * Default is identity (strip `kind`, pass the rest straight through — filters
   * like `region` / `domain` / `limit` survive untouched).
   *
   * Used only for `benchmarks`, whose retired handler takes its own `kind`
   * (the benchmark category) — which collides with the facet discriminator.
   * The facet accepts `benchmark_kind` and remaps it back to `kind`.
   */
  mapArgs?: (rest: Record<string, unknown>) => Record<string, unknown>
}

export interface GetDispatchEntry<TContext> {
  /** The retired `get_<kind>` handler this facet delegates to. */
  handler: ToolHandler<TContext>
  /**
   * The delegated handler's required id-param name. The facet takes a uniform
   * `id` and remaps it to this (e.g. `entity_meta` → `name`, `edge_type` →
   * `type`, `lifecycle` → `entity_type`, `domain_guide` → `domain_id`).
   */
  idParam: string
}

/* ---------------------------------------------------------------------------
 * Tool definitions (wire shapes surfaced on `tools/list`).
 * ------------------------------------------------------------------------- */

export const LIST_CATALOG_DEF: ToolDefinition = {
  name: 'list_catalog',
  description:
    'List a static spec catalog by `kind` (one faceted tool replacing the 25 `list_*` spec-introspection tools). Reads `@unified-product-graph/core`; identical for every client on a given spec version. Kind-specific filters pass straight through: e.g. `playbooks` accepts `region` / `canonical_only` / `framework_id`; `entity_types` accepts `domain` / `maturity` / `deprecated` / `limit` / `cursor`; `benchmarks` requires `benchmark_kind` (`count` | `relationship` | `ratio` | `domain_activation`) plus optional `stage` / `domain`. Use `get_catalog_entry` to fetch one record by id.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      kind: {
        type: 'string',
        enum: [...CATALOG_LIST_KINDS],
        description: 'Which static spec catalog to list.',
      },
      // Documented kind-specific passthrough filters (union; each applies only
      // to the kinds that accept it — others ignore them, matching the retired
      // tools' behaviour).
      region: { type: 'string', description: 'Filter (playbooks): exact UPGRegionId.' },
      canonical_only: { type: 'boolean', description: 'Filter (playbooks): canonical playbook per region only.' },
      framework_id: { type: 'string', description: 'Filter (playbooks / approaches): exact framework id.' },
      domain: { type: 'string', description: 'Filter (entity_types / benchmarks): exact atomic-domain id.' },
      maturity: { type: 'string', description: 'Filter (entity_types): draft | proposed | stable | deprecated | removed.' },
      deprecated: { type: 'boolean', description: 'Filter (entity_types): keep only / exclude deprecated types.' },
      stage: { type: 'string', description: 'Filter (benchmarks): UPGProductStage.' },
      benchmark_kind: {
        type: 'string',
        enum: ['count', 'relationship', 'ratio', 'domain_activation'],
        description: 'Required for kind=benchmarks: which benchmark catalog (remapped to the retired tool\'s `kind`).',
      },
      limit: { type: 'number', description: 'Pagination (entity_types / type_labels / frameworks / anti_patterns): page size.' },
      cursor: { type: 'string', description: 'Pagination: opaque cursor from a prior `next_cursor`.' },
    },
    required: ['kind'],
  },
}

export const GET_CATALOG_ENTRY_DEF: ToolDefinition = {
  name: 'get_catalog_entry',
  description:
    'Fetch one static spec catalog record by `kind` + `id` (one faceted tool replacing the 15 `get_*-by-id` spec-introspection tools). Reads `@unified-product-graph/core`. `id` is the record identifier for that kind: `playbook`/`framework`/`lens`/`scale`/`anti_pattern`/`tree_pattern`/`domain_ring`/`region`/`approach` take their record id; `entity_meta` takes an entity-type name; `edge_type` takes an edge-type key; `lifecycle`/`type_label` take an entity type; `domain_guide` takes a domain id; `template` takes a template id. Use `list_catalog` to enumerate a kind.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      kind: {
        type: 'string',
        enum: [...CATALOG_GET_KINDS],
        description: 'Which static spec catalog to read one record from.',
      },
      id: {
        type: 'string',
        description: 'The record identifier for that kind (see the tool description for the per-kind id meaning).',
      },
    },
    required: ['kind', 'id'],
  },
}

/* ---------------------------------------------------------------------------
 * Handler factories.
 * ------------------------------------------------------------------------- */

/**
 * Build the `list_catalog` handler from a server's dispatch map. The map is
 * typed `Record<CatalogListKind, …>`, so the server must wire every kind —
 * a missing kind is a compile error (structural parity).
 */
export function makeListCatalogHandler<TContext>(
  dispatch: Record<CatalogListKind, ListDispatchEntry<TContext>>,
): ToolHandler<TContext> {
  const table = dispatch as Record<string, ListDispatchEntry<TContext> | undefined>
  return (args, ctx) => {
    const kind = args.kind as string | undefined
    if (!kind) return textError('Missing required parameter: kind')
    const entry = table[kind]
    if (!entry) {
      return textError(
        `Unknown catalog kind: ${kind}. Valid kinds: ${CATALOG_LIST_KINDS.join(', ')}`,
      )
    }
    const { kind: _kind, ...rest } = args
    void _kind
    const forwarded = entry.mapArgs ? entry.mapArgs(rest) : rest
    return entry.handler(forwarded, ctx)
  }
}

/**
 * Build the `get_catalog_entry` handler from a server's dispatch map. The
 * uniform `id` is remapped to each retired handler's native id-param.
 */
export function makeGetCatalogEntryHandler<TContext>(
  dispatch: Record<CatalogGetKind, GetDispatchEntry<TContext>>,
): ToolHandler<TContext> {
  const table = dispatch as Record<string, GetDispatchEntry<TContext> | undefined>
  return (args, ctx) => {
    const kind = args.kind as string | undefined
    if (!kind) return textError('Missing required parameter: kind')
    const id = args.id as string | undefined
    if (id === undefined) return textError('Missing required parameter: id')
    const entry = table[kind]
    if (!entry) {
      return textError(
        `Unknown catalog kind: ${kind}. Valid kinds: ${CATALOG_GET_KINDS.join(', ')}`,
      )
    }
    const { kind: _kind, id: _id, ...rest } = args
    void _kind
    void _id
    const forwarded = { ...rest, [entry.idParam]: id }
    return entry.handler(forwarded, ctx)
  }
}
