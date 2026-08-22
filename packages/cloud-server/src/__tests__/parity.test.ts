/**
 * Cloud ↔ local MCP parity audit.
 *
 * Pins the disposition of every tool on either server. New asymmetry MUST
 * be justified by editing one of the two escape-hatch sets below; otherwise
 * this test fails and CI catches the drift.
 *
 * The test reads both manifests from `dist/tools-manifest.json` (produced by
 * the JSDoc-driven generator in `@unified-product-graph/mcp-tooling`). Run `npm run build`
 * in both packages first; the cloud package's `postbuild` regenerates its
 * own manifest, and the local package's manifest must already be on disk
 * from its build.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, '../..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..')

const CLOUD_MANIFEST = resolve(PACKAGE_ROOT, 'dist/tools-manifest.json')
const LOCAL_MANIFEST = resolve(REPO_ROOT, 'packages/upg-mcp-server/dist/tools-manifest.json')

interface Manifest { tools: Array<{ name: string }> }

function readNames(path: string): string[] {
  if (!existsSync(path)) {
    const which = path === LOCAL_MANIFEST ? '@unified-product-graph/mcp-server' : '@unified-product-graph/cloud-server'
    throw new Error(
      `Tool manifest not found at ${path}. The parity audit reads built manifests; ` +
        `build ${which} first (\`npm run build --workspace=${which}\`). ` +
        `Both manifests must exist on disk before this suite runs.`,
    )
  }
  const m = JSON.parse(readFileSync(path, 'utf-8')) as Manifest
  return m.tools.map((t) => t.name).sort()
}

/**
 * Cloud tools that are intentionally absent from local. Each entry is a
 * category error if reproduced on local: multi-tenant primitives, RBAC,
 * webhooks, and Postgres-side analytics belong on the server.
 */
const LOCAL_NA = new Set([
  // multi-tenant catalog + whole-product dumps (local reads the .upg file directly)
  'list_products',
  'get_product_graph',
  'export_upg_document',
  // server-only audit log
  'get_audit_log',
  // collaboration / RBAC
  'add_comment',
  'list_comments',
  'grant_access',
  'list_collaborators',
  // webhooks (outbound delivery)
  'register_webhook',
  'list_webhooks',
  'remove_webhook',
  // Postgres-side aggregation
  'get_graph_analytics',
])

/**
 * Local tools that are intentionally absent from cloud, split into
 * "N/A" (category-mismatched) vs "deferred" (could be added later). The
 * test treats them the same way: they're allowed to be local-only.
 */
const CLOUD_NA = new Set([
  // ── Category-mismatched (intentional, will never be on cloud) ──────────────
  // .upg-file workspace concepts (cloud is single-product-per-request)
  'init_workspace',
  'list_local_products',
  'switch_product',
  // reload_product (0.17.6): re-reads the ACTIVE product from an on-disk .upg
  // file to escape a wedged save-conflict. A pure local file-concurrency concern
  // — the cloud server is stateless per request with no persistent in-memory
  // snapshot to go stale, so there is nothing to reload. Category error on cloud.
  'reload_product',
  'get_workspace_info',
  // process-local session state (the cloud server is stateless per request)
  'get_session_context',
  'update_session_context',
  // sync: the cloud IS the destination, so it doesn't push/pull to itself
  'apply_pull_changeset',
  'get_sync_state',
  'push_to_cloud',
  // local-only introspection (audits the on-disk .claude skill files)
  'skill_audit',
  // get_import_recipe: returns the source→UPG mapping recipe an agent
  // executes. Read-only over spec + the adapters mapping tables, so it COULD run
  // on cloud — shipped local-only in the first agent-native-import increment
  // (it pairs with the local /upg-sync-import skill + local write tools). Cloud
  // parity is a tracked follow-up, not a category error.
  'get_import_recipe',
  // submit_feedback (feedback pipeline Phase 2): POSTs a feedback report to the
  // public triage endpoint at unifiedproductgraph.org, stamping context from the
  // CLIENT's own environment — the MCP initialize handshake (client name/version)
  // and local runtime. That client environment only exists on the local server;
  // the stateless per-request cloud server has no handshake/runtime to stamp, so
  // this is a category error on cloud (never on cloud), not a deferred gap.
  'submit_feedback',
  // ── Candidate cloud-parity gaps (local-only today, not category errors) ────
  // Could be added to the cloud server later; tracked as follow-ups, dispositioned
  // here so the parity audit stays green in the meantime.
  'get_anti_pattern_violations_for', // store-coupled whole-graph evaluation
  'get_organization',                // org / portfolio read
  'migrate_properties',              // cloud has migrate_type but not these two
  'migrate_status',
  'promote_scalars_to_edges',        // P14 scalar→edge apply (sibling to migrate_properties); local-only. Cloud exposes the read (list_scalar_to_edge_migrations).
  'start',                         // cold-start on-ramp; store-coupled, reads the local graph to recommend the first playbook. Cloud graphs could get the same on-ramp later (follow-up); local-only for 0.7.6.
  // workspace write surface (0.8.15/654): portfolio.upg membership +
  // product-header writes. Local-only today (portfolio.upg is a .upg-file
  // workspace concept); cloud parity is a tracked follow-up.
  'assign_product_to_area',
  'attach_product_to_portfolio',
  'update_product',
  // portfolio edit / cleanup tier (0.8.16): area editing + re-parenting,
  // membership removal, deletes, and atomic batch cross-edges. Same rationale as the
  // 0.8.15 write surface — portfolio.upg is a .upg-file workspace concept; cloud
  // parity is a tracked follow-up.
  'update_area',
  'remove_product_from_area',
  'delete_area',
  'move_product_to_area',
  'detach_product_from_portfolio',
  'delete_cross_product_edge',
  'batch_create_cross_product_edges',
  // batch_delete_cross_product_edges (0.17.3, brief H): the atomic batch inverse of
  // batch_create_cross_product_edges. Local-only for the same reason as the rest of
  // the portfolio write surface (portfolio.upg is a .upg-file workspace concept);
  // cloud parity is a tracked follow-up.
  'batch_delete_cross_product_edges',
  // upsert_composition (0.34.0): create or republish a composition, writing the
  // node and its composition_focuses_node edges in one commit. A composition IS
  // an ordinary .upg node, so the generic readers already serve it; what earns
  // the tool is that `rev` is DERIVED inside the write. Local-only in this
  // increment because the derivation and its optimistic precondition are written
  // against the single-file store's read-modify-write and bounded reload, which
  // the Postgres-backed cloud server would have to implement as a row-level CAS
  // rather than mirror. Not a category error: cloud parity is a tracked
  // follow-up once that transaction shape is designed.
  'upsert_composition',
  // create_portfolio (0.17.x, gap G2 / #39): first-class portfolio creation in
  // portfolio.upg. Local-only for the same reason as the rest of the portfolio
  // write surface (portfolio.upg is a .upg-file workspace concept); cloud parity
  // is a tracked follow-up.
  'create_portfolio',
  // cross-product read layer (0.9.1, batch-3 #13): read node content / digests
  // ACROSS products in one call. Local-only — they sweep the .upg-file workspace
  // (multiple .upg files in a folder), which has no cloud analogue (the cloud
  // server is single-product-per-request). Cloud parity is a tracked follow-up.
  'portfolio_query',
  'portfolio_digest',
  // portfolio_census (0.12.5): the cross-product list_nodes — lists
  // product-local nodes of one type across the workspace with a projection.
  // Local-only for the same reason as the rest of the portfolio read layer: it
  // sweeps the .upg-file workspace (multiple files in a folder), which the
  // single-product-per-request cloud server has no analogue for.
  'portfolio_census',
  // get_portfolio_tree (0.10.7): assembles the classification landscape /
  // competitor profile from portfolio.upg cross-edges + the shared registry.
  // Local-only for the same reason as the rest of the portfolio read layer:
  // it spans the .upg-file workspace (portfolio document + product files),
  // which the single-product-per-request cloud server has no analogue for.
  'get_portfolio_tree',
  // audit_property_coverage (0.10.8): audits portfolio cross-edges for missing
  // required properties. Local-only — reads the portfolio document, a .upg-file
  // workspace concept with no single-product cloud analogue.
  'audit_property_coverage',
  // diff_classification (0.11.0): reads the append-only reclassification history
  // (portfolio signals[]) to show what moved on the classification landscape.
  // Local-only — the history lives in the portfolio workspace document, which
  // the single-product-per-request cloud server has no analogue for.
  'diff_classification',
  // classification-analysis read tools (0.11.2): compare_classifications derives
  // two competitors' axis-by-axis agree/diverge (feeding the parity layer);
  // aggregate_edge_properties digests a cross-edge property's distribution. Both
  // read the portfolio document — a .upg-file workspace concept with no
  // single-product cloud analogue.
  'compare_classifications',
  'aggregate_edge_properties',
  // audit_axis_overlap (0.11.3): lists sources holding >1 value on a single-select
  // classification axis (the supersede regression guard). Reads the portfolio
  // document — a .upg-file workspace concept with no single-product cloud analogue.
  'audit_axis_overlap',
  // portfolio-wide audit (0.9.3, batch-4 #19): runs validate_graph across the
  // .upg-file workspace in one call. Local-only for the same reason as the
  // portfolio read layer — no cloud analogue (single-product-per-request).
  'portfolio_validate',
  // cross-product shape clone (0.9.4, batch-4 #17): reads an exemplar .upg and
  // stamps its shape into another .upg in the workspace. Local-only — it spans
  // multiple .upg files, which the single-product-per-request cloud has no
  // analogue for.
  'clone_structure',
  // canonical shared-entity registry (0.9.6, registry initiative Phase 2): the
  // registry lives in the `.upg`-file portfolio document (shared-vocabulary tier
  // across products), a workspace concept with no single-product cloud analogue.
  'define_canonical_entity',
  'register_instance',
  'list_registry',
  'update_canonical_entity',
  'batch_define_canonical_entity',
  'batch_register_instance',
  'promote_to_canonical',
  'create_registry_edge',
  // registry CRUD completion (feedback 01b21402): delete retires a canonical
  // (referenced-guard / cascade / dry_run); merge collapses twin canonicals by
  // repointing instance_of + registry edges onto a keeper. Local-only for the
  // same reason as the rest of the registry surface.
  'delete_canonical_entity',
  'merge_canonical_entities',
  // registry-edge read path (0.25.1): the read counterpart to
  // create_registry_edge, enumerating `registry.edges` from the portfolio
  // document. Local-only for the same reason as its writer and the rest of the
  // registry surface.
  'list_registry_edges',
  'link_area_to_audience',
  // create_parity_edge (0.10.1, spec issue #38 fast-follow): typed writer for the
  // feature_rivals_competitor_feature parity edge. Local-only for the same reason
  // as the other cross-product writers — it can target a competitor_feature in a
  // separate watched .upg graph (a workspace concept with no single-product cloud
  // analogue). Cloud parity is a tracked follow-up.
  'create_parity_edge',
  // create_classification_edge (0.10.4): typed writer for the classification
  // edges, local-only for the same reason as create_parity_edge (it can target a
  // competitor in a separate watched .upg graph). Cloud parity is a tracked
  // follow-up.
  'create_classification_edge',
  // get_tree reached cloud parity in 0.9.16: the assembler moved to the shared
  // @unified-product-graph/mcp-tooling package, and the cloud handler builds an
  // in-memory GraphReader from a one-shot product load. REQUIRED on cloud now.
  // framework exercises (apply_framework / score_entity) reached cloud parity in
  // 0.8.6: migration 005 added edge `properties` JSONB, and the cloud handlers
  // mirror the local SDK logic. They are now REQUIRED on cloud (removed here).
])

describe('MCP parity audit: @unified-product-graph/cloud-server vs @unified-product-graph/mcp-server', () => {
  it('both tool manifests exist on disk (run npm run build first)', () => {
    expect(existsSync(CLOUD_MANIFEST), `missing ${CLOUD_MANIFEST}`).toBe(true)
    expect(existsSync(LOCAL_MANIFEST), `missing ${LOCAL_MANIFEST}`).toBe(true)
  })

  it('every cloud tool not in LOCAL_NA also exists on local', () => {
    const cloud = new Set(readNames(CLOUD_MANIFEST))
    const local = new Set(readNames(LOCAL_MANIFEST))
    const expectedOnLocal = [...cloud].filter((n) => !LOCAL_NA.has(n))
    const missing = expectedOnLocal.filter((n) => !local.has(n))
    expect(
      missing,
      `cloud tools missing from local without LOCAL_NA disposition: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('every local tool not in CLOUD_NA also exists on cloud', () => {
    const cloud = new Set(readNames(CLOUD_MANIFEST))
    const local = new Set(readNames(LOCAL_MANIFEST))
    const expectedOnCloud = [...local].filter((n) => !CLOUD_NA.has(n))
    const missing = expectedOnCloud.filter((n) => !cloud.has(n))
    expect(
      missing,
      `local tools missing from cloud without CLOUD_NA disposition: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('LOCAL_NA contains no tools that actually exist on local (stale entries)', () => {
    const local = new Set(readNames(LOCAL_MANIFEST))
    const stale = [...LOCAL_NA].filter((n) => local.has(n))
    expect(stale, `LOCAL_NA contains tools that are on local: ${stale.join(', ')}`).toEqual([])
  })

  it('CLOUD_NA contains no tools that actually exist on cloud (stale entries)', () => {
    const cloud = new Set(readNames(CLOUD_MANIFEST))
    const stale = [...CLOUD_NA].filter((n) => cloud.has(n))
    expect(stale, `CLOUD_NA contains tools that are on cloud: ${stale.join(', ')}`).toEqual([])
  })

  it('every entry in LOCAL_NA / CLOUD_NA is registered on its own server', () => {
    // Otherwise the set entry is meaningless; it's not an "asymmetry" if
    // the tool doesn't exist anywhere.
    const cloud = new Set(readNames(CLOUD_MANIFEST))
    const local = new Set(readNames(LOCAL_MANIFEST))
    const cloudOrphans = [...LOCAL_NA].filter((n) => !cloud.has(n))
    const localOrphans = [...CLOUD_NA].filter((n) => !local.has(n))
    expect(cloudOrphans, `LOCAL_NA references tools not on cloud: ${cloudOrphans.join(', ')}`).toEqual([])
    expect(localOrphans, `CLOUD_NA references tools not on local: ${localOrphans.join(', ')}`).toEqual([])
  })
})
