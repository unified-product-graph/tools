/**
 * Faceted spec-catalog tools (UPG 0.19.0 consolidation, Phase 1 — additive).
 *
 * Cloud mirror of `mcp-server/src/tools/catalog.ts`. `list_catalog` /
 * `get_catalog_entry` delegate to this server's existing retired handlers via
 * the SAME shared factory in `@unified-product-graph/mcp-tooling`, so the two
 * servers are byte-identical by construction and the kind enums cannot drift
 * (typed `Record<CatalogListKind, …>` / `Record<CatalogGetKind, …>`).
 */

import {
  makeListCatalogHandler,
  makeGetCatalogEntryHandler,
  type ListDispatchEntry,
  type GetDispatchEntry,
  type CatalogListKind,
  type CatalogGetKind,
} from '@unified-product-graph/mcp-tooling'
import type { CloudContext, ToolHandler } from '../lib/server-context.js'
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

const LIST_DISPATCH: Record<CatalogListKind, ListDispatchEntry<CloudContext>> = {
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
  benchmarks: {
    handler: listBenchmarks,
    mapArgs: ({ benchmark_kind, ...rest }) => ({ ...rest, kind: benchmark_kind }),
  },
  edge_migrations: { handler: listEdgeMigrations },
  scalar_to_edge_migrations: { handler: listScalarToEdgeMigrations },
  split_migrations: { handler: listSplitMigrations },
  type_migrations: { handler: listTypeMigrations },
}

const GET_DISPATCH: Record<CatalogGetKind, GetDispatchEntry<CloudContext>> = {
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
 * `list_*` spec-introspection tools). Delegates to the retired handler; output
 * is byte-identical. Kind-specific filters pass through.
 *
 * @returns JSON: the delegated `list_<kind>` payload verbatim (shape varies by kind).
 * @throws textError when `kind` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see get_catalog_entry
 * @see get_entity_schema
 */
export const listCatalog: ToolHandler = makeListCatalogHandler<CloudContext>(LIST_DISPATCH)

/**
 * Fetch one static spec catalog record by `kind` + `id` (one faceted tool
 * replacing the 15 `get_*-by-id` spec-introspection tools). Delegates to the
 * retired handler; output is byte-identical.
 *
 * @returns JSON: the delegated `get_<kind>` record verbatim (shape varies by kind).
 * @throws textError when `kind` or `id` is missing, or the kind is unknown.
 * @atomicity atomic (read-only)
 * @see list_catalog
 * @see get_entity_schema
 */
export const getCatalogEntry: ToolHandler = makeGetCatalogEntryHandler<CloudContext>(GET_DISPATCH)
