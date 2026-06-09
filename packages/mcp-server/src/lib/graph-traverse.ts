/**
 * Shared graph-traversal core for the cross-product read layer (batch-3 #13).
 *
 * `portfolio_query` runs the SAME BFS + projection the single-product `query`
 * tool runs, but against any number of products — the active store or transient
 * read-only stores loaded for non-active products. To keep `portfolio_query`'s
 * per-graph output byte-identical to `query`'s, the algorithm lives here as a
 * pure function over a minimal {@link GraphReader} (which `UPGFileStore`
 * satisfies structurally).
 *
 * NOTE: the `query` handler in `tools/nodes.ts` keeps its own inline copy of
 * this BFS. They are intentionally kept in lockstep — `query` layers a payload
 * guard + result-diff cache on top of the same loop, and that hot path has thin
 * unit coverage, so it is left untouched rather than refactored onto this core.
 * If you change the traversal semantics in one, change both; this function is
 * unit-tested in `graph-traverse.test.ts`.
 */
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'

/** Minimal read surface a traversal needs. `UPGFileStore` satisfies it structurally. */
export interface GraphReader {
  getNode(id: string): UPGBaseNode | undefined
  getAllNodes(): UPGBaseNode[]
  getEdgesForNode(id: string): UPGEdge[]
}

export interface TraverseParams {
  from?: string
  from_id?: string
  traverse?: string[]
  depth?: number
  limit?: number
  include?: string[]
  edge_include?: string[]
  property_include?: string[]
}

export interface TraverseResult {
  nodes: Array<Record<string, unknown>>
  edges: Array<Record<string, unknown>>
  total_nodes: number
  total_edges: number
  truncated: boolean
  truncated_at_depth?: number
}

export type TraverseOutcome =
  | { ok: true; result: TraverseResult }
  | { ok: false; error: string }

/**
 * Breadth-first traversal from a start set, following typed edges, projecting
 * the requested fields. Mirrors the `query` tool's inline loop. Returns
 * `{ ok: false, error }` for the two caller-error cases (`query` surfaces these
 * as a textError) and `{ ok: true, result }` otherwise.
 */
export function traverseGraph(reader: GraphReader, params: TraverseParams): TraverseOutcome {
  const fromType = params.from
  const fromId = params.from_id
  if (!fromType && !fromId) {
    return { ok: false, error: 'Provide either "from" (entity type) or "from_id" (node ID)' }
  }

  const traverseEdgeTypes = params.traverse
  const maxDepth = Math.min(Math.max(params.depth ?? 3, 1), 10)
  const maxNodes = Math.min(Math.max(params.limit ?? 200, 1), 1000)
  const includeFields = new Set(params.include ?? ['title', 'status', 'type'])
  includeFields.add('id')
  includeFields.add('type')

  let startNodes: UPGBaseNode[]
  if (fromId) {
    const node = reader.getNode(fromId)
    if (!node) return { ok: false, error: `Node not found: ${fromId}` }
    startNodes = [node]
  } else {
    startNodes = reader.getAllNodes().filter((n) => n.type === fromType)
  }

  if (startNodes.length === 0) {
    return { ok: true, result: { nodes: [], edges: [], total_nodes: 0, total_edges: 0, truncated: false } }
  }

  const visited = new Set<string>()
  const collectedNodes: UPGBaseNode[] = []
  const collectedEdges = new Map<string, UPGEdge>()
  const queue: Array<{ id: string; level: number }> = []
  let truncated = false
  let maxDepthReached = 0

  for (const n of startNodes) {
    if (collectedNodes.length >= maxNodes) { truncated = true; break }
    visited.add(n.id)
    collectedNodes.push(n)
    queue.push({ id: n.id, level: 0 })
  }

  while (queue.length > 0) {
    if (collectedNodes.length >= maxNodes) { truncated = true; break }
    const { id, level } = queue.shift()!
    if (level > maxDepthReached) maxDepthReached = level
    if (level >= maxDepth) continue

    const edges = reader.getEdgesForNode(id)
    for (const edge of edges) {
      if (edge.source !== id) continue

      if (traverseEdgeTypes && traverseEdgeTypes.length > 0) {
        const edgeTypeForLevel =
          level < traverseEdgeTypes.length
            ? traverseEdgeTypes[level]
            : traverseEdgeTypes[traverseEdgeTypes.length - 1]

        if (edgeTypeForLevel.startsWith('!')) {
          if (edge.type === edgeTypeForLevel.slice(1)) continue
        } else {
          if (edge.type !== edgeTypeForLevel) continue
        }
      }

      collectedEdges.set(edge.id, edge)
      const neighborId = edge.target
      if (!visited.has(neighborId)) {
        visited.add(neighborId)
        const neighbor = reader.getNode(neighborId)
        if (neighbor) {
          if (collectedNodes.length >= maxNodes) { truncated = true; break }
          collectedNodes.push(neighbor)
          queue.push({ id: neighborId, level: level + 1 })
        }
      }
    }
  }

  const propInclude = params.property_include
  const propFilter = propInclude && propInclude.length > 0 ? new Set(propInclude) : null

  const projectedNodes = collectedNodes.map((n) => {
    const projected: Record<string, unknown> = { id: n.id, type: n.type }
    if (includeFields.has('title')) projected.title = n.title
    if (includeFields.has('status')) projected.status = n.status
    if (includeFields.has('tags')) projected.tags = n.tags
    if (includeFields.has('description')) projected.description = n.description
    if (includeFields.has('properties')) {
      if (propFilter && n.properties) {
        const filtered: Record<string, unknown> = {}
        for (const key of propFilter) {
          if (key in n.properties) filtered[key] = n.properties[key]
        }
        projected.properties = filtered
      } else {
        projected.properties = n.properties
      }
    }
    return projected
  })

  const edgeInclude = params.edge_include
  let edgeArray: Array<Record<string, unknown>>
  if (edgeInclude !== undefined && edgeInclude.length === 0) {
    edgeArray = []
  } else {
    const edgeFields = edgeInclude ? new Set(edgeInclude) : null
    edgeArray = [...collectedEdges.values()].map((e) => {
      if (!edgeFields) return { id: e.id, type: e.type, source: e.source, target: e.target }
      const projected: Record<string, unknown> = {}
      if (edgeFields.has('id')) projected.id = e.id
      if (edgeFields.has('type')) projected.type = e.type
      if (edgeFields.has('source')) projected.source = e.source
      if (edgeFields.has('target')) projected.target = e.target
      return projected
    })
  }

  const result: TraverseResult = {
    nodes: projectedNodes,
    edges: edgeArray,
    total_nodes: projectedNodes.length,
    total_edges: edgeArray.length,
    truncated,
  }
  if (truncated) result.truncated_at_depth = maxDepthReached
  return { ok: true, result }
}
