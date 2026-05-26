/**
 * Context, digest, traversal, and change-feed handlers. Multi-product
 * scoping via `product_id`.
 */

import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'
import { type ToolHandler, text, textError } from '../lib/server-context.js'

const BUSINESS_AREAS: Record<string, string[]> = {
  identity: ['product', 'vision', 'mission'],
  understanding: ['persona', 'jtbd', 'pain_point', 'need', 'research_study', 'research_insight'],
  // : post- canonical type names (hypothesis_claim/evidence, experiment_plan/run).
  discovery: ['opportunity', 'solution', 'competitor', 'hypothesis_claim', 'hypothesis_evidence', 'experiment_plan', 'experiment_run', 'learning'],
  reaching: ['ideal_customer_profile', 'positioning', 'messaging', 'acquisition_channel', 'content_strategy'],
  converting: ['value_proposition', 'pricing_tier', 'funnel', 'funnel_step'],
  building: ['feature', 'user_story', 'epic', 'release', 'user_journey', 'user_flow'],
  sustaining: ['business_model', 'revenue_stream', 'cost_structure', 'unit_economics', 'pricing_strategy'],
  learning: ['outcome', 'kpi', 'metric', 'objective', 'key_result', 'retrospective'],
}

const LIFECYCLE_PHASES: Record<string, string[]> = {
  strategy: ['product', 'outcome', 'metric', 'kpi', 'objective', 'key_result', 'vision', 'mission'],
  users: ['persona', 'jtbd', 'need', 'pain_point', 'desired_outcome'],
  discovery: ['opportunity', 'solution', 'research_study', 'insight', 'research_insight', 'competitor'],
  // : canonical names + legacy back-compat.
  validation: ['hypothesis_claim', 'hypothesis_evidence', 'experiment_plan', 'experiment_run', 'learning', 'evidence', 'hypothesis', 'experiment'],
  execution: ['feature', 'epic', 'user_story', 'release', 'task', 'bug'],
}

/**
 * Product summary, entity counts by type, and a human-readable overview.
 * Use this as the first call to orient an agent in a freshly-loaded product.
 *
 * @returns Text: `## <product title>` followed by description/stage,
 * graph stats (node/edge/type counts), and a sorted breakdown of entities
 * per type. Errors with `Product not found: <id>` for unknown products.
 * @throws textError when `product_id` is missing or the product
 *   is not visible to the caller.
 * @atomicity atomic (read-only)
 * @see get_graph_digest
 * @see get_graph_analytics
 * @see get_entity_schema
 * @see list_nodes
 */
export const getProductContext: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  const productId = args.product_id as string
  const product = await store.getProduct(productId)
  if (!product) return textError(`Product not found: ${productId}`)

  const nodes = await store.getAllNodes(productId)
  const edges = await store.getAllEdges(productId)

  const countsByType: Record<string, number> = {}
  for (const n of nodes) {
    countsByType[n.type] = (countsByType[n.type] ?? 0) + 1
  }

  const lines: string[] = [
    `## ${product.title}`,
    product.description ? `\n${product.description}` : '',
    product.stage ? `\nStage: ${product.stage}` : '',
    `\n### Graph Stats`,
    `- Nodes: ${nodes.length}`,
    `- Edges: ${edges.length}`,
    `- Entity types: ${Object.keys(countsByType).length}`,
    `\n### Entities by Type`,
    ...Object.entries(countsByType)
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => `- ${type}: ${count}`),
  ]

  return text(lines.filter(Boolean).join('\n'))
}

/**
 * Pre-computed analytics digest: counts by type, health metrics
 * (orphan rate, connectivity, validation rate, user coverage), key chain
 * stats (persona→jtbd→pain_point, opportunity→solution, hypothesis→
 * experiment→learning), business-area coverage, lifecycle counts.
 *
 * Cheaper than re-deriving from `list_nodes` or `query`; the agent's first
 * stop for "how healthy is this graph?".
 *
 * @returns JSON with `product`, `counts`, `health`, `chains`, `coverage`,
 * `lifecycle` keys (~500 tokens of summary). Note: chain keys still use the
 * v0.1 names (`persona_with_jtbd` etc.) pending a canonical rename.
 * @throws textError when `product_id` is missing.
 * @atomicity atomic (read-only)
 * @warning Chain keys carry v0.1 names (`persona_with_jtbd`,
 * `hypothesis_total`) pending a canonical rename. Lifecycle bucketing
 *   uses local heuristics (`BUSINESS_AREAS` / `LIFECYCLE_PHASES`
 *   constants in this file) rather than the canonical `UPG_DOMAINS` ring,
 *   so it may drift from spec across versions.
 * @see get_product_context
 * @see get_graph_analytics
 * @see list_benchmarks
 * @see validate_graph
 */
export const getGraphDigest: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const productId = args.product_id as string
  const nodes = await store.getAllNodes(productId)
  const edges = await store.getAllEdges(productId)
  const product = await store.getProduct(productId)

  const byType: Record<string, number> = {}
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1

  const connected = new Set<string>()
  for (const e of edges) { connected.add(e.source); connected.add(e.target) }
  const orphanCount = nodes.filter((n) => !connected.has(n.id)).length

  const hypothesisCount = byType['hypothesis'] ?? 0
  const experimentCount = byType['experiment'] ?? 0
  const personaCount = byType['persona'] ?? 0

  const chainStats = (parentType: string, pattern: string) => {
    let w = 0
    const parents = nodes.filter((n) => n.type === parentType)
    for (const p of parents) {
      if (edges.some((e) => e.source === p.id && e.type.includes(pattern))) w++
    }
    return { with_child: w, total: parents.length }
  }

  const pj = chainStats('persona', 'jtbd')
  const jp = chainStats('jtbd', 'pain_point')
  const os = chainStats('opportunity', 'solution')
  const he = chainStats('hypothesis', 'experiment')
  const el = chainStats('experiment', 'learning')

  const typeSet = new Set(Object.keys(byType))
  const coverage: Record<string, { covered: number; total: number; types_present: string[]; types_missing: string[] }> = {}
  for (const [area, types] of Object.entries(BUSINESS_AREAS)) {
    const present = types.filter((t) => typeSet.has(t))
    const missing = types.filter((t) => !typeSet.has(t))
    coverage[area] = { covered: present.length, total: types.length, types_present: present, types_missing: missing }
  }

  const lifecycle: Record<string, number> = {}
  for (const [phase, types] of Object.entries(LIFECYCLE_PHASES)) {
    lifecycle[phase] = types.reduce((s, t) => s + (byType[t] ?? 0), 0)
  }

  return text(JSON.stringify({
    product: { title: product?.title ?? 'Unknown', stage: product?.stage ?? 'unknown' },
    counts: { total_nodes: nodes.length, total_edges: edges.length, by_type: byType },
    health: {
      orphan_count: orphanCount,
      orphan_rate: nodes.length > 0 ? Math.round((orphanCount / nodes.length) * 100) / 100 : 0,
      connectivity: nodes.length > 0 ? Math.round(((nodes.length - orphanCount) / nodes.length) * 100) / 100 : 0,
      validation_rate: hypothesisCount > 0 ? Math.round((experimentCount / hypothesisCount) * 100) / 100 : 0,
      user_coverage: personaCount > 0 ? Math.round((pj.with_child / personaCount) * 100) / 100 : 0,
    },
    chains: {
      persona_with_jtbd: pj.with_child, persona_total: pj.total,
      jtbd_with_pain_point: jp.with_child, jtbd_total: jp.total,
      opportunity_with_solution: os.with_child, opportunity_total: os.total,
      hypothesis_untested: hypothesisCount - he.with_child, hypothesis_total: hypothesisCount,
      experiment_with_learning: el.with_child, experiment_total: experimentCount,
    },
    coverage,
    lifecycle,
  }, null, 2))
}

/**
 * BFS traversal from a starting node (or every node of a given type),
 * following typed edges and returning a projected subgraph in one call.
 * Far cheaper than walking via `list_nodes` plus `get_node` for graph-wide
 * reads.
 *
 * Edge filtering: pass `traverse: ['persona_pursues_job', '!noisy_edge']`
 * to require the first edge type at depth 0 and exclude `noisy_edge` at
 * deeper levels. The last entry repeats for any depth beyond the array
 * length.
 *
 * Field projection: `include` is a whitelist of node fields (id and type
 * are returned by default). `edge_include` of `[]` returns the empty set of
 * edge metadata.
 *
 * @returns JSON: `{ nodes, edges, total_nodes, total_edges,
 * truncated?, truncated_at_depth?, hint? }`. Truncates with a hint when
 * `limit` is reached.
 * @throws textError when `product_id` is missing, or when
 *   neither `from` nor `from_id` is provided, or when `from_id` does not
 *   resolve.
 * @atomicity atomic (read-only)
 * @warning Pre-loads the entire product graph into memory before
 *   filtering; for products beyond ~10K nodes this can be heavy. Use
 *   `from_id` plus a tight `depth` for narrow slices, and pair with
 *   `include` / `edge_include` to trim wire payload. Truncation is silent
 *   beyond `limit`, so check `truncated` before assuming the result is
 *   complete.
 * @see list_nodes
 * @see get_node
 * @see get_area_graph
 * @see search_nodes
 * @see resolve_edge_for_pair
 * @see trace
 */
export const query: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const productId = args.product_id as string
  const fromType = args.from as string | undefined
  const fromId = args.from_id as string | undefined
  if (!fromType && !fromId) return textError('Provide either "from" or "from_id"')

  const traverseEdgeTypes = args.traverse as string[] | undefined
  const maxDepth = Math.min(Math.max((args.depth as number) ?? 3, 1), 10)
  const maxNodes = Math.min(Math.max((args.limit as number) ?? 200, 1), 1000)
  const includeFields = new Set((args.include as string[] | undefined) ?? ['title', 'status', 'type'])
  includeFields.add('id'); includeFields.add('type')

  const allNodes = await store.getAllNodes(productId)
  const allEdges = await store.getAllEdges(productId)

  const edgesBySource = new Map<string, UPGEdge[]>()
  for (const e of allEdges) {
    let list = edgesBySource.get(e.source)
    if (!list) { list = []; edgesBySource.set(e.source, list) }
    list.push(e)
  }

  let startNodes: UPGBaseNode[]
  if (fromId) {
    const n = allNodes.find((n) => n.id === fromId)
    if (!n) return textError(`Node not found: ${fromId}`)
    startNodes = [n]
  } else {
    startNodes = allNodes.filter((n) => n.type === fromType)
  }

  const visited = new Set<string>()
  const collectedNodes: UPGBaseNode[] = []
  const collectedEdges: UPGEdge[] = []
  const queue: Array<{ id: string; level: number }> = []
  let truncated = false
  let maxDepthReached = 0

  for (const n of startNodes) {
    if (collectedNodes.length >= maxNodes) { truncated = true; break }
    visited.add(n.id); collectedNodes.push(n); queue.push({ id: n.id, level: 0 })
  }

  while (queue.length > 0) {
    if (collectedNodes.length >= maxNodes) { truncated = true; break }
    const { id, level } = queue.shift()!
    if (level > maxDepthReached) maxDepthReached = level
    if (level >= maxDepth) continue

    for (const edge of edgesBySource.get(id) ?? []) {
      if (traverseEdgeTypes && traverseEdgeTypes.length > 0) {
        const etl = level < traverseEdgeTypes.length ? traverseEdgeTypes[level] : traverseEdgeTypes[traverseEdgeTypes.length - 1]
        if (etl.startsWith('!')) { if (edge.type === etl.slice(1)) continue }
        else { if (edge.type !== etl) continue }
      }
      collectedEdges.push(edge)
      if (!visited.has(edge.target)) {
        visited.add(edge.target)
        const neighbor = allNodes.find((n) => n.id === edge.target)
        if (neighbor) {
          if (collectedNodes.length >= maxNodes) { truncated = true; break }
          collectedNodes.push(neighbor); queue.push({ id: edge.target, level: level + 1 })
        }
      }
    }
  }

  const edgeInclude = args.edge_include as string[] | undefined
  const projectedNodes = collectedNodes.map((n) => {
    const p: Record<string, unknown> = { id: n.id, type: n.type }
    if (includeFields.has('title')) p.title = n.title
    if (includeFields.has('status')) p.status = n.status
    if (includeFields.has('tags')) p.tags = n.tags
    if (includeFields.has('description')) p.description = n.description
    if (includeFields.has('properties')) p.properties = n.properties
    return p
  })

  let edgeArray: Array<Record<string, unknown>>
  if (edgeInclude !== undefined && edgeInclude.length === 0) {
    edgeArray = []
  } else {
    const ef = edgeInclude ? new Set(edgeInclude) : null
    edgeArray = collectedEdges.map((e) => {
      if (!ef) return { id: e.id, type: e.type, source: e.source, target: e.target }
      const p: Record<string, unknown> = {}
      if (ef.has('id')) p.id = e.id
      if (ef.has('type')) p.type = e.type
      if (ef.has('source')) p.source = e.source
      if (ef.has('target')) p.target = e.target
      return p
    })
  }

  const resp: Record<string, unknown> = {
    nodes: projectedNodes,
    edges: edgeArray,
    total_nodes: projectedNodes.length,
    total_edges: edgeArray.length,
  }
  if (truncated) {
    resp.truncated = true
    resp.truncated_at_depth = maxDepthReached
    resp.hint = `Limit of ${maxNodes} reached at depth ${maxDepthReached}.`
  }
  return text(JSON.stringify(resp, null, 2))
}

/**
 * Audit-log feed scoped to a single product. Returns mutations newer than
 * the optional `since` timestamp, capped at `limit` (default 50, max 200).
 * Cloud equivalent of the local server's `get_changes`.
 *
 * @returns JSON: `{ changes: AuditEntry[], total }`.
 * @throws textError when `product_id` is missing.
 * @atomicity atomic (read-only)
 * @warning Backed by the audit log: entries beyond the plan-tier
 *   retention window are pruned and stay out of this surface. The `since`
 *   filter runs in-memory after the store fetches up to `limit` entries,
 *   so narrow `since` windows on busy products may surface fewer rows
 *   than expected (raise `limit` to compensate).
 * @see get_audit_log
 * @see get_graph_digest
 * @see get_product_context
 */
export const getChanges: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const since = args.since as string | undefined
  const limit = Math.min((args.limit as number) ?? 50, 200)
  const entries = await store.getAuditLog(args.product_id as string, limit)
  const filtered = since ? entries.filter((e) => e.created_at >= since) : entries
  return text(JSON.stringify({ changes: filtered, total: filtered.length }, null, 2))
}
