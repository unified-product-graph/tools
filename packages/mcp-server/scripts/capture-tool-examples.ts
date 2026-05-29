/**
 * capture-tool-examples.ts
 *
 * Runs every registered MCP tool against the populated Notion fixture and
 * captures the real input/output, so the tool reference shows true behaviour
 * (not invented JSON). Emits `tool-examples.generated.json`.
 *
 * Safety: the fixture is copied to a temp file before loading, so write tools
 * (create/update/delete/batch/migrate) can run and have their result captured
 * without ever touching the real `.upg`.
 *
 * Run: npx tsx scripts/capture-tool-examples.ts
 */

import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { UPGFileStore } from '@unified-product-graph/sdk'
import {
  UPG_REGIONS, UPG_LENSES, UPG_FRAMEWORKS, UPG_PLAYBOOKS,
  UPG_DOMAINS, UPG_DOMAIN_RINGS, UPG_ANTI_PATTERNS,
} from '@unified-product-graph/core'
import { TOOL_REGISTRY } from '../src/lib/tool-registry.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../src/lib/server-context.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../..')
const FIXTURE = resolve(REPO_ROOT, '.upg/notion-saturated.upg')
const OUT = resolve(__dirname, '../tool-examples.generated.json')

// Truncate very long outputs so example panels stay scannable.
const MAX_OUTPUT_CHARS = 1400

interface CapturedExample {
  name: string
  input: Record<string, unknown>
  output?: string
  ok: boolean
  note?: string
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return s.slice(0, MAX_OUTPUT_CHARS).replace(/\s+\S*$/, '') + '\n… (truncated)'
}

async function main() {
  // 1. Work on a throwaway copy; write tools must never touch the real fixture.
  const tmp = mkdtempSync(join(tmpdir(), 'upg-capture-'))
  const fixtureCopy = join(tmp, 'fixture.upg')
  copyFileSync(FIXTURE, fixtureCopy)

  const store = new UPGFileStore()
  await store.load(fixtureCopy)
  store.stopWatching()
  const ctx: ToolContext = {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }

  // 2. Sample values pulled from the real graph, for arg derivation.
  const nodes = store.getAllNodes()
  const edges = store.getAllEdges()
  const sampleNode = nodes[0]
  const sampleNode2 = nodes[1] ?? nodes[0]
  const sampleEdge = edges[0]
  const typeCounts = new Map<string, number>()
  for (const n of nodes) typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1)
  const commonType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'feature'

  // 3. Best-effort arg derivation from each tool's inputSchema.
  function deriveArgs(schema: { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] }): Record<string, unknown> {
    const args: Record<string, unknown> = {}
    const required = schema.required ?? []
    const props = schema.properties ?? {}
    for (const key of required) {
      const p = props[key] ?? {}
      if (Array.isArray(p.enum) && p.enum.length) { args[key] = p.enum[0]; continue }
      if (/(^|_)(id|node_id|entity_id|source|target)$/.test(key) || key === 'source' || key === 'target') {
        args[key] = sampleNode?.id
      } else if (key === 'ids' || key === 'node_ids') {
        args[key] = [sampleNode?.id, sampleNode2?.id].filter(Boolean)
      } else if (key === 'type' || key === 'entity_type') {
        args[key] = commonType
      } else if (key === 'title') {
        args[key] = 'Example node'
      } else if (key === 'query' || key === 'q') {
        args[key] = (sampleNode?.title ?? '').split(' ')[0] || 'checkout'
      } else if (p.type === 'string') {
        args[key] = 'example'
      } else if (p.type === 'number' || p.type === 'integer') {
        args[key] = 1
      } else if (p.type === 'boolean') {
        args[key] = false
      } else if (p.type === 'array') {
        args[key] = []
      } else if (p.type === 'object') {
        args[key] = {}
      }
    }
    return args
  }

  // Tools that can't meaningfully run against a single local fixture:
  // cloud, multi-product workspace, and portfolio surfaces. No example panel.
  const SKIP = new Set([
    // Cloud / multi-product / portfolio, not runnable on a single local fixture.
    'switch_product', 'push_to_cloud', 'apply_pull_changeset',
    'create_cross_product_edge', 'migrate_cross_edges', 'list_portfolio_cross_edges',
    // Mutations that need a valid canonical pair / hierarchy target, or are
    // overflow-prone; their single-node equivalents (create_node, update_node,
    // delete_node) are captured, so the patterns are covered.
    'create_edge', 'delete_edge', 'batch_create_edges', 'move_node', 'batch_move_nodes',
    'get_area_graph', 'inspect', 'prioritise', 'get_scale',
    'batch_update_nodes', 'rename_edge_type',
  ])

  // Hand-tuned recipes for tools whose required args need a valid id/enum or a
  // real graph reference (catalog ids from @unified-product-graph/core; node /
  // edge ids from the fixture). Write tools run on the throwaway copy.
  const eType = sampleEdge?.type
  const RECIPES: Record<string, Record<string, unknown>> = {
    query: { from: 'persona', traverse: ['persona_pursues_job'], depth: 1, limit: 5, include: ['title'], edge_include: [] },
    get_region: { id: UPG_REGIONS[0]?.id },
    get_region_for_entity_type: { entity_type: 'outcome' },
    get_lens: { id: UPG_LENSES[0]?.id },
    get_framework: { id: UPG_FRAMEWORKS[0]?.id },
    get_playbook: { id: UPG_PLAYBOOKS[0]?.id },
    get_domain_guide: { domain_id: UPG_DOMAINS[0]?.id },
    get_domain_ring: { id: UPG_DOMAIN_RINGS[0]?.id },
    get_anti_pattern: { id: UPG_ANTI_PATTERNS[0]?.id },
    get_entity_meta: { name: commonType },
    get_lifecycle: { entity_type: 'hypothesis' },
    get_edge_type: { type: eType },
    inspect: { region: UPG_REGIONS[0]?.id },
    trace: { anchor: sampleNode?.id, path: eType ? [eType] : [] },
    migrate_type: { from_type: 'jtbd', to_type: 'job', dry_run: true },
    rename_edge_type: { from: eType, to: `${eType}_v2`, dry_run: true },
    create_edge: { source_id: sampleNode?.id, target_title: 'Example target', target_type: commonType },
    delete_edge: { edge_id: sampleEdge?.id },
    move_node: { node_id: sampleNode?.id, new_parent_id: sampleNode2?.id },
    batch_create_nodes: { nodes: [{ type: commonType, title: 'Example node A' }, { type: commonType, title: 'Example node B' }] },
    batch_update_nodes: { updates: [{ node_id: sampleNode?.id, description: 'Updated via batch' }] },
    batch_delete_nodes: { node_ids: [sampleNode2?.id] },
    batch_create_edges: { edges: [{ source_id: sampleNode?.id, target_title: 'Batch target', target_type: commonType }] },
    batch_delete_edges: { edge_ids: [sampleEdge?.id] },
    batch_move_nodes: { moves: [{ node_id: sampleNode?.id, new_parent_id: sampleNode2?.id }] },
  }

  const results: CapturedExample[] = []
  let ok = 0
  let fail = 0
  let skipped = 0

  for (const tool of TOOL_REGISTRY) {
    if (SKIP.has(tool.name)) { results.push({ name: tool.name, input: {}, ok: false, note: 'skipped (not runnable on a single local fixture)' }); skipped++; continue }
    const input = RECIPES[tool.name] ?? deriveArgs(tool.inputSchema as never)
    try {
      const result = await tool.handler(input, ctx)
      const text = result?.content?.[0]?.text ?? ''
      const isErr = Boolean(result?.isError)
      results.push({ name: tool.name, input, output: truncate(String(text)), ok: !isErr, note: isErr ? 'handler returned isError' : undefined })
      isErr ? fail++ : ok++
    } catch (e) {
      results.push({ name: tool.name, input, ok: false, note: `threw: ${(e as Error).message?.slice(0, 120)}` })
      fail++
    }
  }

  writeFileSync(OUT, JSON.stringify(results, null, 2))

  // 4. Report
  console.log(`\nCaptured ${TOOL_REGISTRY.length} tools against notion-saturated.upg`)
  console.log(`  nodes: ${nodes.length}  edges: ${edges.length}  common type: ${commonType}`)
  console.log(`  ✓ ok: ${ok}   ✗ needs-recipe: ${fail - skipped}   ⊘ skipped: ${skipped}`)
  console.log(`  → ${OUT}\n`)
  console.log('Not captured:')
  for (const r of results.filter((r) => !r.ok)) console.log(`  ${r.note?.startsWith('skipped') ? '⊘' : '✗'} ${r.name}: ${r.note}`)

  console.log('\n─── sample real transcripts ───')
  for (const name of ['get_product_context', 'get_graph_digest', 'search_nodes']) {
    const r = results.find((x) => x.name === name)
    if (r?.ok) {
      console.log(`\n### ${name}  input=${JSON.stringify(r.input)}`)
      console.log(r.output)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
