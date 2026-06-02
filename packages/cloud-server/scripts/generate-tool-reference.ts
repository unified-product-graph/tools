/**
 * Tool reference generator: `@unified-product-graph/cloud-server` consumer shim.
 *
 * Mirrors the local server's shim: delegates the actual walking/auditing/
 * emitting to `@unified-product-graph/mcp-tooling`, configures cloud's domains, tools dir,
 * symbol map, and output paths.
 *
 * Usage:
 *   npx tsx scripts/generate-tool-reference.ts
 *   npx tsx scripts/generate-tool-reference.ts --check
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGenerator } from '@unified-product-graph/mcp-tooling/generator'
import { TOOL_DEFINITIONS } from '../src/lib/tool-registry.js'

// ─── Paths ─────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PACKAGE_ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..')
const TOOLS_DIR = join(PACKAGE_ROOT, 'src', 'tools')

// ─── Domain config (mirrors src/tools/*.ts file layout) ────────────────────

const DOMAINS = [
  'products',
  'context',
  'nodes',
  'edges',
  'frameworks',
  'areas',
  'schema',
  'collaboration',
  'analytics',
  'webhooks',
  'spec',
  'portfolio',
  'batch',
  'validation',
  'migrations',
] as const

const DOMAIN_LABELS: Record<string, string> = {
  products: 'Products & Audit',
  context: 'Context & Traversal',
  nodes: 'Nodes',
  edges: 'Edges',
  frameworks: 'Framework Exercises',
  areas: 'Areas',
  schema: 'Schema',
  collaboration: 'Collaboration',
  analytics: 'Analytics',
  webhooks: 'Webhooks',
  spec: 'Spec Introspection',
  portfolio: 'Portfolio',
  batch: 'Atomic Batches',
  validation: 'Validation',
  migrations: 'Migrations',
}

const DOMAIN_BLURBS: Record<string, string> = {
  products: 'Multi-tenant primitives: list, create, audit log.',
  context: 'Product summary, digest, BFS traversal, change feed.',
  nodes: 'Entity CRUD scoped to a product.',
  edges: 'Edge create and delete.',
  frameworks: 'Apply a framework over entities; record per-entity results on the includes edge.',
  areas: 'Product-area listing and subgraph BFS.',
  schema: 'Per-type spec contract: properties, edges in and out, lifecycle.',
  collaboration: 'Comments and role-based access. Cloud-only.',
  analytics: 'Postgres-side metrics aggregator.',
  webhooks: 'Outbound event sinks.',
  spec: 'Spec snapshot: playbooks, approaches, domains, frameworks, edge catalogue, regions, lenses, type labels, entity meta, anti-patterns, benchmarks, product stages.',
  portfolio: 'Cross-product edges and portfolio view.',
  batch: 'Atomic batches: nodes and edges in one Postgres transaction.',
  validation: 'Schema drift detection across entity types, edge types, and properties.',
  migrations: 'Catalog-aware retypes and cross-product-edge relocation.',
}

// ─── Symbol → tool-name map (mirrors HANDLERS in tool-registry.ts) ─────────

const SYMBOL_TO_TOOL_NAME: Record<string, string> = {
  // products
  listProducts: 'list_products',
  createProduct: 'create_product',
  getAuditLog: 'get_audit_log',
  // context
  getProductContext: 'get_product_context',
  getGraphDigest: 'get_graph_digest',
  query: 'query',
  getChanges: 'get_changes',
  // nodes
  listNodes: 'list_nodes',
  getNode: 'get_node',
  getNodes: 'get_nodes',
  searchNodes: 'search_nodes',
  createNode: 'create_node',
  updateNode: 'update_node',
  deleteNode: 'delete_node',
  getProductGraph: 'get_product_graph',
  exportUpgDocument: 'export_upg_document',
  deduplicateNodes: 'deduplicate_nodes',
  // edges
  createEdge: 'create_edge',
  deleteEdge: 'delete_edge',
  // framework exercises
  applyFramework: 'apply_framework',
  scoreEntity: 'score_entity',
  // nodes (extra)
  moveNode: 'move_node',
  exportEdges: 'export_edges',
  renameEdgeType: 'rename_edge_type',
  // areas
  listProductAreas: 'list_product_areas',
  getAreaGraph: 'get_area_graph',
  createArea: 'create_area',
  getAreaContext: 'get_area_context',
  // schema
  getEntitySchema: 'get_entity_schema',
  // collaboration
  addComment: 'add_comment',
  listComments: 'list_comments',
  grantAccess: 'grant_access',
  listCollaborators: 'list_collaborators',
  // analytics
  getGraphAnalytics: 'get_graph_analytics',
  // webhooks
  registerWebhook: 'register_webhook',
  listWebhooks: 'list_webhooks',
  removeWebhook: 'remove_webhook',
  // spec introspection
  listPlaybooks: 'list_playbooks',
  getPlaybook: 'get_playbook',
  listApproaches: 'list_approaches',
  getApproach: 'get_approach',
  plan: 'plan',
  inspect: 'inspect',
  prioritise: 'prioritise',
  trace: 'trace',
  reflect: 'reflect',
  listDomains: 'list_domains',
  getDomainGuide: 'get_domain_guide',
  listFrameworks: 'list_frameworks',
  getFramework: 'get_framework',
  listEdgeTypes: 'list_edge_types',
  getEdgeType: 'get_edge_type',
  listRegions: 'list_regions',
  getRegion: 'get_region',
  getRegionForEntity: 'get_region_for_entity_type',
  getSpecVersion: 'get_spec_version',
  resolveEdgeForPair: 'resolve_edge_for_pair',
  listCrossEdgeTypes: 'list_cross_edge_types',
  listLenses: 'list_lenses',
  getLensTool: 'get_lens',
  listTypeLabels: 'list_type_labels',
  getTypeLabel: 'get_type_label',
  getValidChildrenTool: 'get_valid_children',
  listEntityTypes: 'list_entity_types',
  getEntityMeta: 'get_entity_meta',
  listAntiPatterns: 'list_anti_patterns',
  getAntiPattern: 'get_anti_pattern',
  listBenchmarks: 'list_benchmarks',
  listProductStages: 'list_product_stages',
  // portfolio
  listPortfolios: 'list_portfolios',
  listPortfolioCrossEdges: 'list_portfolio_cross_edges',
  createCrossProductEdge: 'create_cross_product_edge',
  repairDanglingEdges: 'repair_dangling_edges',
  // validation
  validateGraph: 'validate_graph',
  // migrations
  migrateType: 'migrate_type',
  migrateCrossEdges: 'migrate_cross_edges',
  // spec introspection (lifecycles, scales, framework meta, domain rings)
  listTypeMigrations: 'list_type_migrations',
  listEdgeMigrations: 'list_edge_migrations',
  listSplitMigrations: 'list_split_migrations',
  listLifecycles: 'list_lifecycles',
  getLifecycle: 'get_lifecycle',
  listScales: 'list_scales',
  getScale: 'get_scale',
  listFrameworkCategories: 'list_framework_categories',
  listFrameworkStructurePatterns: 'list_framework_structure_patterns',
  listDomainRings: 'list_domain_rings',
  getDomainRing: 'get_domain_ring',
  // batch
  batchCreateNodes: 'batch_create_nodes',
  batchUpdateNodes: 'batch_update_nodes',
  batchDeleteNodes: 'batch_delete_nodes',
  batchCreateEdges: 'batch_create_edges',
  batchDeleteEdges: 'batch_delete_edges',
  batchMoveNodes: 'batch_move_nodes',
}

// ─── Outputs ───────────────────────────────────────────────────────────────

const OUT_TOOLS_MD = join(PACKAGE_ROOT, 'TOOLS.md')
const OUT_SITE_MD = join(REPO_ROOT, 'apps/upg-site/content/generated/mcp-cloud-tools.md')
const OUT_MANIFEST = join(PACKAGE_ROOT, 'dist/tools-manifest.json')

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const check = process.argv.includes('--check')

  const pkgJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as { version: string }

  const toolsMdIntro = `Reference for the ${TOOL_DEFINITIONS.length} tools exposed by \`@unified-product-graph/cloud-server\`. Generated from JSDoc on \`src/tools/*.ts\`; do not edit by hand.`
  const siteMdIntro = `Every tool exposed by \`@unified-product-graph/cloud-server\` v${pkgJson.version}. Generated from source, kept current. ${TOOL_DEFINITIONS.length} tools across ${DOMAINS.length} domains.`

  const result = await runGenerator({
    packageRoot: PACKAGE_ROOT,
    packageName: '@unified-product-graph/cloud-server',
    packageVersion: pkgJson.version,
    toolsDir: TOOLS_DIR,
    domains: DOMAINS,
    domainLabels: DOMAIN_LABELS,
    domainBlurbs: DOMAIN_BLURBS,
    symbolToToolName: SYMBOL_TO_TOOL_NAME,
    toolDefinitions: TOOL_DEFINITIONS,
    outputs: {
      toolsMd: OUT_TOOLS_MD,
      siteMd: OUT_SITE_MD,
      manifest: OUT_MANIFEST,
    },
    toolsMdTitle: 'UPG MCP Cloud Server Tool Reference',
    toolsMdIntro,
    siteMdTitle: 'Cloud MCP Tools',
    siteMdIntro,
    generatedFooter: 'Generated from JSDoc on `packages/upg-cloud-server/src/tools/*.ts` via `scripts/generate-tool-reference.ts`. Do not edit by hand.',
    repoRoot: REPO_ROOT,
    check,
  })

  if (result.errors.length > 0) {
    for (const e of result.errors) process.stderr.write(`  ✗ ${e}\n`)
    process.exit(1)
  }

  if (check) {
    if (!result.ok) {
      process.stderr.write(
        `\n✗ Generated tool-reference outputs are out of date:\n` +
          result.drifts.map((d) => `    - ${d}`).join('\n') +
          `\n\nRe-run \`npm run generate-tools\` (in packages/upg-cloud-server) and commit the result.\n`,
      )
      process.exit(1)
    }
    process.stdout.write(`✓ Tool reference is up to date (${result.toolCount} tools).\n`)
    return
  }

  process.stdout.write(
    `✓ Generated tool reference for ${result.toolCount} tools across ${result.domainCount} domains:\n` +
      result.written.map((p) => `    - ${p}\n`).join(''),
  )
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`)
  process.exit(1)
})
