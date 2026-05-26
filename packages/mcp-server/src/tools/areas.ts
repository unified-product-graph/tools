/**
 * Area and change-log tools. Covers product areas (the organisational axis),
 * the `.upg-area.json` cwd scoper, and the session change log.
 */

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolContext, ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { preflightPayload, getSoftLimit } from '../lib/payload-guard.js'
import { degradeProgressively } from '../lib/payload-degrader.js'
import {
  writePortfolioScopedNode,
  openPortfolioStoreIfExists,
  PortfolioRoutingError,
} from '@unified-product-graph/sdk'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'

/**
 * List all product areas in the portfolio document
 * (`.upg/portfolio.upg`). Product areas are the organisational axis (who owns
 * what) and live at the portfolio scope alongside portfolios and the
 * organisation.
 *
 * Returns an empty list when no portfolio document exists yet.
 *
 * @returns JSON: `{ areas: Array<{ id, title, strategic_priority?,
 *   parent_area_id?, products? }>, total }`.
 * @atomicity atomic (read-only)
 * @see create_area
 * @see get_area_graph
 */
export const listProductAreas: ToolHandler = async (_args, _ctx): Promise<ToolResult> => {
  const portfolioStore = await openPortfolioStoreIfExists(process.cwd())
  if (!portfolioStore) {
    return text(JSON.stringify({ areas: [], total: 0 }, null, 2))
  }
  const doc = portfolioStore.getDocument()
  const areas = doc?.product_areas ?? []
  const result = areas.map((area) => {
    const row: Record<string, unknown> = { id: area.id, title: area.title }
    if (area.description) row.description = area.description
    if (area.parent_area_id !== undefined) row.parent_area_id = area.parent_area_id
    if (area.strategic_priority) row.strategic_priority = area.strategic_priority
    if (area.products) row.products = area.products
    return row
  })
  return text(JSON.stringify({ areas: result, total: result.length }, null, 2))
}

/**
 * Get all entities and edges that belong to a product area. Returns the
 * subgraph scoped to that area via BFS to `depth` (max 10).
 *
 * @returns JSON: `{ area, nodes, edges, node_count, edge_count }`. May
 *   include a `degraded` block when the response was auto-trimmed.
 * @throws Returns a textError when `area_id` is missing, the node does not
 *   exist, or the node is not a `product_area`.
 * @warning Pre-flight payload guardrail: refuses above
 *   `UPG_MCP_PAYLOAD_HARD_LIMIT` (default 150 KB), warns above
 *   `UPG_MCP_PAYLOAD_SOFT_LIMIT` (default 50 KB). Reduce `depth` or use
 *   `query` with a tight projection if the area has many neighbours.
 * @warning Auto-degrade: between soft and hard, the server may
 *   compact edges, drop optional node fields, or truncate. Surfaced as
 *   `degraded.applied[]` on the response.
 * @atomicity atomic (read-only)
 * @see list_product_areas
 */
export const getAreaGraph: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const areaId = args.area_id as string
  const areaNode = store.getNode(areaId)
  if (!areaNode) return textError(`Area node not found: ${areaId}`)
  if (areaNode.type !== 'product_area')
    return textError(`Node ${areaId} is type "${areaNode.type}", not "product_area"`)

  const maxDepth = Math.min(Math.max((args.depth as number) ?? 3, 1), 10)

  const visited = new Set<string>([areaId])
  const queue: Array<{ id: string; level: number }> = [{ id: areaId, level: 0 }]
  const resultNodes: UPGBaseNode[] = []
  const resultEdges: UPGEdge[] = []

  while (queue.length > 0) {
    const { id, level } = queue.shift()!
    const node = store.getNode(id)
    if (node) resultNodes.push(node)

    if (level < maxDepth) {
      const edges = store.getEdgesForNode(id)
      for (const edge of edges) {
        resultEdges.push(edge)
        const neighborId = edge.source === id ? edge.target : edge.source
        if (!visited.has(neighborId)) {
          visited.add(neighborId)
          queue.push({ id: neighborId, level: level + 1 })
        }
      }
    }
  }

  const uniqueEdges = [...new Map(resultEdges.map((e) => [e.id, e])).values()]

  const guardOutcome = preflightPayload({
    toolName: 'get_area_graph',
    nodeCount: resultNodes.length,
    edgeCount: uniqueEdges.length,
    compactEdges: false,
    argsHint: `area_id=${areaId}, depth=${maxDepth}`,
  })
  if (guardOutcome.kind === 'refuse') return guardOutcome.result

  // Working copies for degradation — operate on cloned shapes so the store's
  // canonical objects aren't mutated by the compact/drop stages.
  let workingNodes: Array<UPGBaseNode | Record<string, unknown>> = resultNodes
  let workingEdges: Array<UPGEdge | Record<string, unknown>> = uniqueEdges
  let compactEdges = false
  let droppedFields = false

  const payload: Record<string, unknown> = {
    area: { id: areaNode.id, title: areaNode.title, type: areaNode.type },
    nodes: workingNodes,
    edges: workingEdges,
    node_count: workingNodes.length,
    edge_count: workingEdges.length,
  }

  if (guardOutcome.kind === 'warn') {
    const degradeOutcome = degradeProgressively({
      toolName: 'get_area_graph',
      initialBytes: guardOutcome.bytes,
      countAfterStage: () => ({
        nodeCount: workingNodes.length,
        edgeCount: workingEdges.length,
        compactEdges,
      }),
      stages: [
        {
          name: 'compact_edges_auto',
          apply: () => {
            if (compactEdges) return false
            workingEdges = workingEdges.map((e) => ({
              id: (e as UPGEdge).id,
              type: (e as UPGEdge).type,
              source: (e as UPGEdge).source,
              target: (e as UPGEdge).target,
            }))
            compactEdges = true
            return true
          },
        },
        {
          name: 'drop_optional_fields_auto',
          apply: () => {
            if (droppedFields) return false
            let changed = false
            workingNodes = workingNodes.map((n) => {
              const node = n as Record<string, unknown>
              const slim: Record<string, unknown> = {
                id: node.id, type: node.type, title: node.title,
              }
              if (node.status !== undefined) slim.status = node.status
              if (node.tags !== undefined) slim.tags = node.tags
              if ('description' in node || 'properties' in node) changed = true
              return slim
            })
            droppedFields = changed
            return changed
          },
        },
        {
          name: 'truncate_at_count_auto',
          apply: () => {
            if (workingNodes.length <= 1) return false
            const soft = getSoftLimit()
            const ratio = guardOutcome.bytes < 1 ? 1 : Math.min(1, (soft / guardOutcome.bytes) * 0.85)
            const targetCount = Math.max(1, Math.floor(workingNodes.length * ratio))
            if (targetCount >= workingNodes.length) return false
            const keepIds = new Set(
              workingNodes.slice(0, targetCount).map((n) => (n as { id: string }).id),
            )
            workingNodes = workingNodes.slice(0, targetCount)
            workingEdges = workingEdges.filter((e) => {
              const edge = e as { source: string; target: string }
              return keepIds.has(edge.source) && keepIds.has(edge.target)
            })
            return true
          },
        },
      ],
    })
    payload.nodes = workingNodes
    payload.edges = workingEdges
    payload.node_count = workingNodes.length
    payload.edge_count = workingEdges.length
    if (degradeOutcome.block) payload.degraded = degradeOutcome.block
    else Object.assign(payload, guardOutcome.fields)
  }
  return text(JSON.stringify(payload, null, 2))
}

/**
 * Check if the current working directory has a `.upg-area.json` that scopes
 * work to a specific product area. Walks up the directory tree from `cwd` to
 * the filesystem root.
 *
 * @returns JSON: `{ has_area_context: false }` or
 *   `{ has_area_context: true, area_id, area_name, found_at }`.
 * @atomicity atomic (read-only)
 */
export const getAreaContext: ToolHandler = async (_args, _ctx): Promise<ToolResult> => {
  let dir = process.cwd()
  const root = path.parse(dir).root

  while (dir !== root) {
    const areaFile = path.join(dir, '.upg-area.json')
    try {
      const raw = await fsp.readFile(areaFile, 'utf-8')
      const area = JSON.parse(raw) as {
        area_id: string
        area_name: string
      }
      return text(
        JSON.stringify(
          {
            has_area_context: true,
            area_id: area.area_id,
            area_name: area.area_name,
            found_at: path.relative(process.cwd(), areaFile) || areaFile,
          },
          null,
          2,
        ),
      )
    } catch {
      // walk up
    }
    dir = path.dirname(dir)
  }

  return text(JSON.stringify({ has_area_context: false }, null, 2))
}

/**
 * Create a product area entity in the portfolio document
 * (`.upg/portfolio.upg`). Product areas represent the organisational axis: who
 * owns what. Supports nesting via `parent_area_id` (stored on the typed
 * record itself; no separate edge is created — portfolio entities use
 * intrinsic parent links rather than per-product hierarchy edges).
 *
 * The portfolio document is created on demand if it does not yet exist.
 *
 * @returns JSON: `{ node, portfolio_file, written_to }`. `node` is the typed
 *   `UPGProductArea` record persisted to `portfolio_areas[]`.
 * @throws Returns a textError when `title` is missing or the portfolio write
 *   fails.
 * @atomicity atomic per write — the portfolio file is read, mutated, and
 *   flushed in one pass.
 * @see list_product_areas
 */
export const createArea: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  if (!args.title) return textError('Missing required parameter: title')

  // Mirror the legacy properties bag — strategic_priority + parent_area_id are
  // hoisted onto the typed UPGProductArea record by writePortfolioScopedNode.
  // `owner` has no slot on UPGProductArea so it is dropped silently (it lived
  // on the deprecated free-form properties bag).
  const properties: Record<string, unknown> = {}
  if (args.strategic_priority) properties.strategic_priority = args.strategic_priority
  if (args.parent_area_id) properties.parent_area_id = args.parent_area_id

  try {
    const result = await writePortfolioScopedNode(process.cwd(), {
      type: 'product_area',
      title: args.title as string,
      description: args.description as string | undefined,
      properties,
    })
    const payload: Record<string, unknown> = {
      node: result.entity,
      portfolio_file: result.portfolio_file,
      written_to: result.written_to,
    }
    if (result.warning) payload.warning = result.warning
    return text(JSON.stringify(payload, null, 2))
  } catch (err) {
    if (err instanceof PortfolioRoutingError) return textError(err.message)
    return textError((err as Error).message)
  }
}

/**
 * Get a log of all mutations made during this session. Use to verify what was
 * created, updated, or deleted without re-fetching nodes.
 *
 * @returns JSON: `{ changes, summary: { create, update, delete }, total }`.
 *   `since` filters to ISO 8601 timestamps after the cutoff.
 * @atomicity atomic (read-only)
 */
export const getChanges: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const since = args.since as string | undefined
  const changes = store.getChanges(since)

  const summary = { create: 0, update: 0, delete: 0 }
  for (const c of changes) {
    summary[c.action]++
  }

  return text(
    JSON.stringify(
      { changes, summary, total: changes.length },
      null,
      2,
    ),
  )
}

export type { ToolContext }
