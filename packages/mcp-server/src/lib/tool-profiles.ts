/**
 * Tool profiles (0.38.0, F5 — cloud-agent hardening).
 *
 * `--profile read-only|author` filters the tool surface SERVER-SIDE: the
 * profile shrinks `tools/list` AND the dispatcher refuses calls to excluded
 * tools, because a client-side allowlist is advisory (a client can still call
 * what it was not shown). Teams gate destructive tools in shared cloud
 * environments; a server flag is more robust than every client's config.
 *
 * FAIL-CLOSED, in the opposite direction from `MUTATING_TOOLS`: that set
 * under-covers deliberately (deduping a read would be a new bug, so when in
 * doubt a tool is left out). Access control must over-cover: a tool absent
 * from the explicit READ allowlist is treated as a write and excluded from
 * `read-only`, so a NEW tool is gated until someone classifies it here. The
 * profile-coverage test flags every unclassified name so that decision is
 * deliberate, never a default.
 */

export const TOOL_PROFILES = ['read-only', 'author'] as const
export type ToolProfile = (typeof TOOL_PROFILES)[number]

/**
 * The explicit read allowlist: tools that neither mutate any persisted graph
 * nor send anything outward. `switch_product` / `reload_product` are included
 * deliberately — they move the server's in-memory pointer between graphs,
 * which multi-product READING requires, and write nothing. `submit_feedback`
 * is excluded: it mutates no graph but POSTs externally, and a read-only
 * surface should not originate network sends. `update_session_context` is
 * excluded: the lens can persist onto the product node.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'aggregate_edge_properties',
  'audit_axis_overlap',
  'audit_property_coverage',
  'compare_classifications',
  'diff_classification',
  'export_edges',
  'get_anti_pattern_violations_for',
  'get_area_context',
  'get_area_graph',
  'get_catalog_entry',
  'get_changes',
  'get_entity_schema',
  'get_graph_digest',
  'get_import_recipe',
  'get_node',
  'get_nodes',
  'get_organization',
  'get_portfolio_tree',
  'get_product_context',
  'get_session_context',
  'get_spec_version',
  'get_sync_state',
  'get_tree',
  'get_workspace_info',
  'list_catalog',
  'list_local_products',
  'list_nodes',
  'list_portfolio_cross_edges',
  'list_portfolios',
  'list_product_areas',
  'list_registry',
  'list_registry_edges',
  'portfolio_census',
  'portfolio_digest',
  'portfolio_query',
  'portfolio_validate',
  'query',
  'reload_product',
  'score_entity',
  'search_nodes',
  'skill_audit',
  'start',
  'switch_product',
  'validate_graph',
])

/**
 * What `author` gates: destructive and infrastructure tools, per the field
 * brief's own list (delete_*, batch_delete_*, migrate_*, rename_edge_type,
 * push_to_cloud, init_workspace, create_product) plus the three that delete
 * under another verb — deduplicate_nodes and merge_canonical_entities remove
 * nodes, repair_dangling_edges removes edges. An author writes and links
 * freely; removing data and reshaping the workspace stay behind the full
 * surface.
 */
export const AUTHOR_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'delete_node',
  'delete_edge',
  'delete_area',
  'delete_canonical_entity',
  'delete_cross_product_edge',
  'batch_delete_nodes',
  'batch_delete_edges',
  'batch_delete_cross_product_edges',
  'migrate_type',
  'migrate_status',
  'migrate_properties',
  'migrate_cross_edges',
  'rename_edge_type',
  'push_to_cloud',
  'init_workspace',
  'create_product',
  'deduplicate_nodes',
  'merge_canonical_entities',
  'repair_dangling_edges',
])

export function isValidProfile(p: unknown): p is ToolProfile {
  return typeof p === 'string' && (TOOL_PROFILES as readonly string[]).includes(p)
}

/** Whether `name` is callable under `profile` (no profile = full surface). */
export function isToolAllowed(profile: ToolProfile | undefined, name: string): boolean {
  if (!profile) return true
  if (profile === 'read-only') return READ_ONLY_TOOLS.has(name)
  return !AUTHOR_EXCLUDED_TOOLS.has(name)
}

/** The refusal a dispatch to an excluded tool gets. Names the profile and the fix. */
export function profileRefusalMessage(profile: ToolProfile, name: string): string {
  return (
    `Tool "${name}" is not available under the "${profile}" profile this server was started with. ` +
    (profile === 'read-only'
      ? 'This surface is read-only: no tool that writes a graph, a portfolio, or the network is exposed. '
      : 'The author profile gates destructive and infrastructure tools (deletes, migrations, workspace reshaping). ') +
    'If this operation is genuinely needed, the environment owner can relaunch the server without --profile (or with a wider one).'
  )
}
