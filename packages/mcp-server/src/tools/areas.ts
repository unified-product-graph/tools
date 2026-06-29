/**
 * Area and change-log tools. Covers product areas (the organisational axis),
 * the `.upg-area.json` cwd scoper, and the session change log.
 */

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolContext, ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { UPG_PORTFOLIO_KINDS } from '@unified-product-graph/core'
import { preflightPayload, getSoftLimit } from '../lib/payload-guard.js'
import { degradeProgressively } from '../lib/payload-degrader.js'
import {
  writePortfolioScopedNode,
  openPortfolioStoreIfExists,
  assignProductToArea,
  updateProductArea,
  removeProductFromArea,
  deleteArea,
  moveProductToArea,
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
    if (area.owner) row.owner = area.owner
    if (area.products) row.products = area.products
    return row
  })
  return text(JSON.stringify({ areas: result, total: result.length }, null, 2))
}

/**
 * Place an existing product under a product_area (`area.products[]`), resolving
 * the area against `portfolio.upg` (NOT the active product graph). The product
 * is also auto-registered on the portfolio registry. §A — the area side
 * of the workspace write surface.
 *
 * @returns JSON: `{ product_id, container_id, container_kind: "product_area",
 *   container_title?, already_member, registered }`.
 * @throws textError on a missing workspace, an unknown product, or an unknown
 *   area id (the message points at list_product_areas / list_local_products).
 * @atomicity atomic (single portfolio.upg flush).
 * @see attach_product_to_portfolio
 * @see create_product
 */
export const assignProductToAreaTool: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const productId = args.product_id as string | undefined
  const areaId = args.area_id as string | undefined
  if (!productId) return textError('Missing required parameter: product_id')
  if (!areaId) return textError('Missing required parameter: area_id')
  try {
    const result = await assignProductToArea(process.cwd(), { product_id: productId, area_id: areaId })
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
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

  // Working copies for degradation; operate on cloned shapes so the store's
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
 * record itself; no separate edge is created. Portfolio entities use
 * intrinsic parent links rather than per-product hierarchy edges).
 *
 * The portfolio document is created on demand if it does not yet exist.
 *
 * @returns JSON: `{ node, portfolio_file, written_to }`. `node` is the typed
 *   `UPGProductArea` record persisted to `portfolio_areas[]`.
 * @throws Returns a textError when `title` is missing or the portfolio write
 *   fails.
 * @atomicity atomic per write; the portfolio file is read, mutated, and
 *   flushed in one pass.
 * @see list_product_areas
 */
export const createArea: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  if (!args.title) return textError('Missing required parameter: title')

  // strategic_priority + parent_area_id + owner are hoisted onto the typed
  // UPGProductArea record by writePortfolioScopedNode (owner is a declared
  // product_area property as of 0.8.15 / §C).
  const properties: Record<string, unknown> = {}
  if (args.strategic_priority) properties.strategic_priority = args.strategic_priority
  if (args.parent_area_id) properties.parent_area_id = args.parent_area_id
  if (args.owner) properties.owner = args.owner

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
 * Create a portfolio entity in the portfolio document (`.upg/portfolio.upg`). A
 * portfolio is the investment / grouping container that products and operating
 * functions belong to. A first-class wrapper over `create_node({type:
 * "portfolio"})` (0.17.x, closing gap G2 / #39), so the kind and nesting are
 * obvious at the call site.
 *
 * `kind` is the portfolio's posture / grouping: `owned` (default), `watched` (an
 * externally-monitored landscape, the only kind that relaxes product grading),
 * or one of the owned-side groupings `strategic` / `internal` / `gtm` (e.g. a
 * Go-to-Market portfolio of revenue operating_functions). The portfolio document
 * is created on demand.
 *
 * @returns JSON: `{ node, portfolio_file, written_to }`. `node` is the typed
 *   `UPGPortfolio` record persisted to `portfolios[]`.
 * @throws textError when `title` is missing, `kind` is invalid, or the write fails.
 * @atomicity atomic per write.
 * @see list_portfolios
 * @see create_area
 */
export const createPortfolio: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  if (!args.title) return textError('Missing required parameter: title')
  const kind = args.kind as string | undefined
  if (kind !== undefined && !(UPG_PORTFOLIO_KINDS as readonly string[]).includes(kind)) {
    return textError(`Invalid kind: "${kind}". Valid: ${UPG_PORTFOLIO_KINDS.join(', ')}.`)
  }

  const properties: Record<string, unknown> = {}
  if (kind) properties.kind = kind
  if (args.parent_portfolio_id) properties.parent_portfolio_id = args.parent_portfolio_id
  if (args.hierarchy_model) properties.hierarchy_model = args.hierarchy_model

  try {
    const result = await writePortfolioScopedNode(process.cwd(), {
      type: 'portfolio',
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

/**
 * Edit a product area in `portfolio.upg` (title / description / strategic_priority /
 * owner) and/or re-parent it via `parent_area_id` (`null` un-nests). The mirror of
 * `update_product` for the organisational axis. §7.
 *
 * `parent_area_id` is tri-state: omit to leave the parent unchanged, pass `null` to
 * un-nest (make top-level), or pass an area id to re-parent (validated against cycles).
 *
 * @returns JSON: `{ message, area, updated: string[] }`.
 * @throws textError on a missing workspace, unknown area/parent, a re-parent cycle, or
 *   when no editable field is supplied.
 * @atomicity atomic (single portfolio.upg flush).
 * @see create_area
 * @see list_product_areas
 */
export const updateAreaTool: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const areaId = args.area_id as string | undefined
  if (!areaId) return textError('Missing required parameter: area_id')
  const hasField =
    args.title !== undefined ||
    args.description !== undefined ||
    args.strategic_priority !== undefined ||
    args.owner !== undefined ||
    'parent_area_id' in args
  if (!hasField) {
    return textError(
      'Nothing to update: pass at least one of: title, description, strategic_priority, owner, parent_area_id.',
    )
  }
  try {
    const result = await updateProductArea(process.cwd(), areaId, {
      title: args.title as string | undefined,
      description: args.description as string | undefined,
      strategic_priority: args.strategic_priority as string | undefined,
      owner: args.owner as string | undefined,
      // Tri-state: present (incl. null) re-parents/un-nests; absent leaves unchanged.
      ...('parent_area_id' in args
        ? { parent_area_id: (args.parent_area_id as string | null) ?? null }
        : {}),
    })
    return text(
      JSON.stringify({ message: `Updated area (${result.updated.join(', ')})`, ...result }, null, 2),
    )
  } catch (err) {
    if (err instanceof PortfolioRoutingError) return textError(err.message)
    return textError((err as Error).message)
  }
}

/**
 * Remove a product from a product area's `products[]` (it stays registered on the
 * portfolio and in any other container). The inverse of `assign_product_to_area`.
 * §8.
 *
 * @returns JSON: `{ product_id, container_id, container_kind: "product_area",
 *   container_title?, removed }`. `removed: false` (not an error) when the product
 *   was not a member, so retries are idempotent.
 * @throws textError on a missing workspace or an unknown area id.
 * @atomicity atomic (single portfolio.upg flush).
 * @see assign_product_to_area
 * @see move_product_to_area
 */
export const removeProductFromAreaTool: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const productId = args.product_id as string | undefined
  const areaId = args.area_id as string | undefined
  if (!productId) return textError('Missing required parameter: product_id')
  if (!areaId) return textError('Missing required parameter: area_id')
  try {
    const result = await removeProductFromArea(process.cwd(), { product_id: productId, area_id: areaId })
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    if (err instanceof PortfolioRoutingError) return textError(err.message)
    return textError((err as Error).message)
  }
}

/**
 * Delete a product area from `portfolio.upg`. Guarded: refuses while the area still
 * has products unless `force: true` is passed, so a mis-delete can't silently strand
 * memberships. Child areas are un-nested (their `parent_area_id` set to null) so no
 * parent reference dangles. §8.
 *
 * @returns JSON: `{ message, area_id, deleted, unnested_children: string[] }`.
 * @throws textError on a missing workspace, unknown area, or a non-empty area without
 *   `force`.
 * @atomicity atomic (single portfolio.upg flush).
 * @see create_area
 * @see remove_product_from_area
 */
export const deleteAreaTool: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const areaId = args.area_id as string | undefined
  if (!areaId) return textError('Missing required parameter: area_id')
  try {
    const result = await deleteArea(process.cwd(), areaId, { force: args.force as boolean | undefined })
    return text(JSON.stringify({ message: `Deleted area ${areaId}`, ...result }, null, 2))
  } catch (err) {
    if (err instanceof PortfolioRoutingError) return textError(err.message)
    return textError((err as Error).message)
  }
}

/**
 * Move a product to a different product area: remove it from `from_area_id` (or, when
 * omitted, from every area it currently sits in) and add it to `to_area_id` (dedup).
 * Convenience over remove + assign. §8.
 *
 * @returns JSON: `{ product_id, to_area_id, to_area_title?, removed_from: string[], added }`.
 * @throws textError on a missing workspace, unknown product, or unknown target area.
 * @atomicity atomic (single portfolio.upg flush).
 * @see assign_product_to_area
 * @see remove_product_from_area
 */
export const moveProductToAreaTool: ToolHandler = async (args, _ctx): Promise<ToolResult> => {
  const productId = args.product_id as string | undefined
  const toAreaId = args.to_area_id as string | undefined
  if (!productId) return textError('Missing required parameter: product_id')
  if (!toAreaId) return textError('Missing required parameter: to_area_id')
  try {
    const result = await moveProductToArea(process.cwd(), {
      product_id: productId,
      to_area_id: toAreaId,
      from_area_id: args.from_area_id as string | undefined,
    })
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    if (err instanceof PortfolioRoutingError) return textError(err.message)
    return textError((err as Error).message)
  }
}

export type { ToolContext }
