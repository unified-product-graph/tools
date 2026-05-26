/**
 * Tool-reference generator — `@unified-product-graph/mcp-server` consumer shim.
 *
 * Delegates the actual walking/auditing/emitting to
 * `@unified-product-graph/mcp-tooling`, the shared catalog tooling used by
 * every UPG MCP server. This file just configures the local server's domains,
 * tools dir, symbol map, and output paths, then calls `runGenerator()`.
 *
 * Usage:
 *   npx tsx scripts/generate-tool-reference.ts
 *   npx tsx scripts/generate-tool-reference.ts --check   # exits non-zero on
 *                                                       # any diff vs disk
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
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
  'context',
  'nodes',
  'edges',
  'areas',
  'workspace',
  'schema',
  'spec',
  'sync',
  'validation',
  'migrations',
  'skills',
] as const

const DOMAIN_LABELS: Record<string, string> = {
  context: 'Context & Session',
  nodes: 'Nodes',
  edges: 'Edges',
  areas: 'Areas & Change Log',
  workspace: 'Workspace & Portfolios',
  schema: 'Schema',
  spec: 'Spec Introspection',
  sync: 'Cloud Sync',
  validation: 'Validation',
  migrations: 'Migrations',
  skills: 'Skills Introspection',
}

const DOMAIN_BLURBS: Record<string, string> = {
  context: 'Product overview, graph digest, lens-aware session state.',
  nodes: 'Read, search, traverse, mutate, batch, migrate, dedupe.',
  edges: 'Single create/delete/move plus matching atomic batches.',
  areas: 'Product areas, the `.upg-area.json` cwd scoper, and the session change log.',
  workspace: 'Multi-product discovery, switching, init, cross-product edges.',
  schema: 'Entity schema introspection. Same constraints the LSP enforces.',
  spec: 'Canonical playbooks, approaches, domain guides, frameworks, edge catalogue, regions, lenses, type labels, hierarchy, version, cross-edges, entity meta, anti-patterns, benchmarks, bare-verb approach handlers, migrations, lifecycles, scales, framework categories/patterns, and domain rings. All from `@unified-product-graph/core`.',
  sync: 'Read sync state, pull cloud changes, push local graph.',
  validation: 'Schema-drift detection and full per-node drift reports.',
  migrations: 'Status value migration across the graph.',
  skills: 'Verify source-vs-deployed integrity of UPG `/upg-*` skills before recommending them.',
}

// ─── Symbol → tool-name map (mirrors HANDLERS in tool-registry.ts) ─────────
//
// Kept in sync by hand because the registry exports the binding map as a
// non-exported `const`. If a handler is renamed, update both places — the
// audit will surface mismatches as "no JSDoc block found".

const SYMBOL_TO_TOOL_NAME: Record<string, string> = {
  // context
  getProductContext: 'get_product_context',
  getGraphDigest: 'get_graph_digest',
  getSessionContext: 'get_session_context',
  updateSessionContext: 'update_session_context',
  // skills
  skillAudit: 'skill_audit',
  // nodes
  listNodes: 'list_nodes',
  getNode: 'get_node',
  getNodes: 'get_nodes',
  searchNodes: 'search_nodes',
  query: 'query',
  createNode: 'create_node',
  updateNode: 'update_node',
  deleteNode: 'delete_node',
  batchCreateNodes: 'batch_create_nodes',
  batchUpdateNodes: 'batch_update_nodes',
  batchDeleteNodes: 'batch_delete_nodes',
  migrateType: 'migrate_type',
  migrateProperties: 'migrate_properties',
  deduplicateNodes: 'deduplicate_nodes',
  // edges
  createEdge: 'create_edge',
  deleteEdge: 'delete_edge',
  moveNode: 'move_node',
  batchMoveNodes: 'batch_move_nodes',
  batchCreateEdges: 'batch_create_edges',
  batchDeleteEdges: 'batch_delete_edges',
  repairDanglingEdges: 'repair_dangling_edges',
  exportEdges: 'export_edges',
  renameEdgeType: 'rename_edge_type',
  // areas
  listProductAreas: 'list_product_areas',
  getAreaGraph: 'get_area_graph',
  getAreaContext: 'get_area_context',
  createArea: 'create_area',
  getChanges: 'get_changes',
  // workspace
  listLocalProducts: 'list_local_products',
  switchProduct: 'switch_product',
  getWorkspaceInfo: 'get_workspace_info',
  initWorkspaceTool: 'init_workspace',
  createProductTool: 'create_product',
  listPortfolios: 'list_portfolios',
  getOrganization: 'get_organization',
  createCrossProductEdge: 'create_cross_product_edge',
  listPortfolioCrossEdges: 'list_portfolio_cross_edges',
  migrateCrossEdges: 'migrate_cross_edges',
  // migrations
  migrateStatus: 'migrate_status',
  // schema
  getEntitySchema: 'get_entity_schema',
  // spec
  listPlaybooks: 'list_playbooks',
  getPlaybook: 'get_playbook',
  listApproaches: 'list_approaches',
  getApproach: 'get_approach',
  // spec round 4 — approach verbs
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
  // spec round 2
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
  // spec round 3
  listEntityTypes: 'list_entity_types',
  getEntityMeta: 'get_entity_meta',
  listAntiPatterns: 'list_anti_patterns',
  getAntiPattern: 'get_anti_pattern',
  listBenchmarks: 'list_benchmarks',
  listProductStages: 'list_product_stages',
  // spec round 5
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
  // validation
  validateGraph: 'validate_graph',
  getAntiPatternViolationsFor: 'get_anti_pattern_violations_for',
  // sync
  getSyncState: 'get_sync_state',
  applyPullChangeset: 'apply_pull_changeset',
  pushToCloud: 'push_to_cloud',
}

// ─── Outputs ───────────────────────────────────────────────────────────────

const OUT_TOOLS_MD = join(PACKAGE_ROOT, 'TOOLS.md')
const OUT_SITE_MD = join(REPO_ROOT, 'apps/upg-site/content/generated/mcp-tools.md')
const OUT_MANIFEST = join(PACKAGE_ROOT, 'dist/tools-manifest.json')

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const check = process.argv.includes('--check')

  const pkgJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as { version: string }

  const toolsMdIntro = `Reference for the ${TOOL_DEFINITIONS.length} tools exposed by \`@unified-product-graph/mcp-server\`. Generated from JSDoc on \`src/tools/*.ts\` (do not edit by hand).`
  const siteMdIntro = `Every tool exposed by \`@unified-product-graph/mcp-server\` v${pkgJson.version}. Generated from source. ${TOOL_DEFINITIONS.length} tools across ${DOMAINS.length} domains.`

  const result = await runGenerator({
    packageRoot: PACKAGE_ROOT,
    packageName: '@unified-product-graph/mcp-server',
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
    toolsMdTitle: 'UPG MCP Server: Tool Reference',
    toolsMdIntro,
    siteMdTitle: 'Local MCP Tools',
    siteMdIntro,
    generatedFooter: 'Generated from JSDoc on `packages/upg-mcp-server/src/tools/*.ts` via `scripts/generate-tool-reference.ts`. Do not edit by hand.',
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
          `\n\nRe-run \`npm run generate-tools\` (in packages/upg-mcp-server) and commit the result.\n`,
      )
      process.exit(1)
    }
    process.stdout.write(`✓ Tool reference is up to date (${result.toolCount} tools).\n`)
    return
  }

  // Overlay real captured examples onto the manifest. `tool-examples.generated.json`
  // is produced by `scripts/capture-tool-examples.ts` (every tool run against the
  // notion-saturated fixture). This is what lets the tool reference render real
  // Input/Output transcripts instead of invented JSON.
  const examplesPath = join(PACKAGE_ROOT, 'tool-examples.generated.json')
  if (existsSync(examplesPath) && existsSync(OUT_MANIFEST)) {
    const captured = JSON.parse(readFileSync(examplesPath, 'utf-8')) as Array<{
      name: string; input: Record<string, unknown>; output?: string; ok: boolean
    }>
    const byName = new Map(captured.filter((c) => c.ok && c.output).map((c) => [c.name, c]))
    const manifest = JSON.parse(readFileSync(OUT_MANIFEST, 'utf-8')) as {
      tools: Array<{ name: string; examples?: unknown[] }>
    }
    let attached = 0
    for (const tool of manifest.tools) {
      const cap = byName.get(tool.name)
      if (!cap) continue
      tool.examples = [{
        description: 'Live call against the Notion example graph.',
        input: JSON.stringify(cap.input, null, 2),
        output: cap.output,
      }]
      attached++
    }
    writeFileSync(OUT_MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
    process.stdout.write(`  ↳ overlaid ${attached} captured tool examples onto the manifest\n`)
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
