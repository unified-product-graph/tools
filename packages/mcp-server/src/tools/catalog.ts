/**
 * Faceted spec-catalog tools (UPG 0.19.0 consolidation, Phase 1 — additive).
 *
 * `list_catalog` / `get_catalog_entry` collapse the 25 `list_*` + 15
 * `get_*-by-id` spec-introspection tools behind two facets, while the retired
 * tools stay registered. Both facets DELEGATE to the existing handlers in
 * `./spec.js` / `./templates.js` via the shared factory in
 * `@unified-product-graph/mcp-tooling`, so their output is byte-identical to
 * the retired tools BY CONSTRUCTION. The dispatch maps below are typed
 * `Record<CatalogListKind, …>` / `Record<CatalogGetKind, …>`, so the shared
 * kind enums and this wiring can never silently drift (a new kind is a compile
 * error until wired here AND on the cloud server).
 *
 * See `packages/upg-mcp-tooling/src/spec-catalog.ts` for the rationale.
 */

import {
  makeListCatalogHandler,
  makeGetCatalogEntryHandler,
  type ListDispatchEntry,
  type GetDispatchEntry,
  type CatalogListKind,
  type CatalogGetKind,
} from '@unified-product-graph/mcp-tooling'
import type { ToolContext, ToolHandler } from '../lib/server-context.js'
import {
  listEntityTypes,
  getEntityMeta,
  listEdgeTypes,
  getEdgeType,
  listCrossEdgeTypes,
  listRegions,
  getRegion,
  listDomains,
  getDomainGuide,
  listDomainRings,
  getDomainRing,
  listFrameworks,
  getFramework,
  listFrameworkCategories,
  listFrameworkStructurePatterns,
  listLenses,
  getLensTool,
  listLifecycles,
  getLifecycle,
  listPlaybooks,
  getPlaybook,
  listScales,
  getScale,
  listAntiPatterns,
  getAntiPattern,
  listTreePatterns,
  getTreePattern,
  listApproaches,
  getApproach,
  listTypeLabels,
  getTypeLabel,
  listStatusValues,
  listProductStages,
  listBenchmarks,
  listEdgeMigrations,
  listScalarToEdgeMigrations,
  listSplitMigrations,
  listTypeMigrations,
} from './spec.js'
import { listTemplatesTool, getTemplateTool } from './templates.js'

/** Delegation map: every listable catalog kind → its retired `list_*` handler. */
const LIST_DISPATCH: Record<CatalogListKind, ListDispatchEntry<ToolContext>> = {
  entity_types: { handler: listEntityTypes },
  edge_types: { handler: listEdgeTypes },
  cross_edge_types: { handler: listCrossEdgeTypes },
  regions: { handler: listRegions },
  domains: { handler: listDomains },
  domain_rings: { handler: listDomainRings },
  frameworks: { handler: listFrameworks },
  framework_categories: { handler: listFrameworkCategories },
  framework_structure_patterns: { handler: listFrameworkStructurePatterns },
  lenses: { handler: listLenses },
  lifecycles: { handler: listLifecycles },
  playbooks: { handler: listPlaybooks },
  scales: { handler: listScales },
  anti_patterns: { handler: listAntiPatterns },
  tree_patterns: { handler: listTreePatterns },
  templates: { handler: listTemplatesTool },
  approaches: { handler: listApproaches },
  type_labels: { handler: listTypeLabels },
  status_values: { handler: listStatusValues },
  product_stages: { handler: listProductStages },
  // `list_benchmarks` takes its own `kind` (the benchmark category), which
  // collides with the facet discriminator. Accept `benchmark_kind` and remap.
  benchmarks: {
    handler: listBenchmarks,
    mapArgs: ({ benchmark_kind, ...rest }) => ({ ...rest, kind: benchmark_kind }),
  },
  edge_migrations: { handler: listEdgeMigrations },
  scalar_to_edge_migrations: { handler: listScalarToEdgeMigrations },
  split_migrations: { handler: listSplitMigrations },
  type_migrations: { handler: listTypeMigrations },
}

/** Delegation map: every gettable catalog kind → its retired `get_*` handler + id-param. */
const GET_DISPATCH: Record<CatalogGetKind, GetDispatchEntry<ToolContext>> = {
  entity_meta: { handler: getEntityMeta, idParam: 'name' },
  edge_type: { handler: getEdgeType, idParam: 'type' },
  region: { handler: getRegion, idParam: 'id' },
  domain_guide: { handler: getDomainGuide, idParam: 'domain_id' },
  domain_ring: { handler: getDomainRing, idParam: 'id' },
  framework: { handler: getFramework, idParam: 'id' },
  lens: { handler: getLensTool, idParam: 'id' },
  lifecycle: { handler: getLifecycle, idParam: 'entity_type' },
  playbook: { handler: getPlaybook, idParam: 'id' },
  scale: { handler: getScale, idParam: 'id' },
  anti_pattern: { handler: getAntiPattern, idParam: 'id' },
  tree_pattern: { handler: getTreePattern, idParam: 'id' },
  type_label: { handler: getTypeLabel, idParam: 'entity_type' },
  template: { handler: getTemplateTool, idParam: 'id' },
  approach: { handler: getApproach, idParam: 'id' },
}

/**
 * List a static spec catalog by `kind` (one faceted tool replacing the 25
 * `list_*` spec-introspection tools). Reads `@unified-product-graph/core` and
 * delegates to the retired `list_<kind>` handler, so output is byte-identical.
 * Kind-specific filters pass straight through (e.g. `playbooks` accepts
 * `region` / `canonical_only` / `framework_id`; `benchmarks` requires
 * `benchmark_kind`).
 *
 * @returns JSON: the delegated `list_<kind>` payload verbatim (shape varies by kind).
 * @throws textError when `kind` is missing or not a known catalog kind.
 * @atomicity atomic (read-only)
 * @see get_catalog_entry
 * @see get_entity_schema
 * @see get_spec_version
 */
export const listCatalog: ToolHandler = makeListCatalogHandler<ToolContext>(LIST_DISPATCH)

/**
 * Fetch one static spec catalog record by `kind` + `id` (one faceted tool
 * replacing the 15 `get_*-by-id` spec-introspection tools). Reads
 * `@unified-product-graph/core` and delegates to the retired `get_<kind>`
 * handler (remapping the uniform `id` to that handler's native id-param), so
 * output is byte-identical.
 *
 * @returns JSON: the delegated `get_<kind>` record verbatim (shape varies by kind).
 * @throws textError when `kind` or `id` is missing, or the kind is unknown.
 * @atomicity atomic (read-only)
 * @see list_catalog
 * @see get_entity_schema
 */
export const getCatalogEntry: ToolHandler = makeGetCatalogEntryHandler<ToolContext>(GET_DISPATCH)
