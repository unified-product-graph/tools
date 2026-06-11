/**
 * `upg query` - BFS graph traversal with projection.
 *
 * CLI face of the MCP `query` tool. Reads a .upg file, performs a
 * breadth-first traversal from a start set, projects the requested
 * fields, and renders a compact node/edge listing.
 *
 * Flags:
 *   --from <type>          start set: all nodes of this entity type
 *   --from-id <id>         start set: a single node by ID
 *   --traverse <edge,...>  comma-separated edge types to follow per BFS level
 *                          (supports !negation: follow all except this type)
 *   --depth <n>            max traversal depth (default 3, max 10)
 *   --include <field,...>  node fields to project (title,status,tags,description,properties)
 *   --edge-include <f,...> edge fields to project (id,type,source,target); pass empty to omit all
 *   --limit <n>            max nodes to collect (default 200)
 *   --file <path>          target a specific .upg file
 *   --json                 emit raw JSON matching the MCP query output shape
 */

import { Command, InvalidArgumentError } from 'commander'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { formatNode, upgHeader, label } from '../lib/formatter.js'
import { die, runtimeError, usageError } from '../lib/errors.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'

// ── BFS traversal ──────────────────────────────────────────────────────────

interface TraverseParams {
  from?: string
  fromId?: string
  traverse?: string[]
  depth: number
  limit: number
  include: Set<string>
  edgeInclude?: string[]
}

interface TraverseResult {
  nodes: Array<Record<string, unknown>>
  edges: Array<Record<string, unknown>>
  total_nodes: number
  total_edges: number
  truncated: boolean
  truncated_at_depth?: number
}

interface GraphReader {
  getNode(id: string): UPGBaseNode | undefined
  getAllNodes(): UPGBaseNode[]
  getEdgesForNode(id: string): UPGEdge[]
}

/**
 * Breadth-first traversal from a start set, following typed edges, projecting
 * the requested fields. Mirrors the MCP `query` tool semantics from nodes.ts
 * and graph-traverse.ts.
 */
function runBFS(reader: GraphReader, params: TraverseParams): TraverseResult {
  const { from, fromId, traverse: traverseEdgeTypes, depth: maxDepth, limit: maxNodes } = params
  const includeFields = params.include

  let startNodes: UPGBaseNode[]
  if (fromId) {
    const node = reader.getNode(fromId)
    if (!node) {
      throw runtimeError(`Node not found: ${fromId}`)
    }
    startNodes = [node]
  } else {
    startNodes = reader.getAllNodes().filter((n) => n.type === from)
  }

  if (startNodes.length === 0) {
    return { nodes: [], edges: [], total_nodes: 0, total_edges: 0, truncated: false }
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

  const projectedNodes = collectedNodes.map((n) => {
    const projected: Record<string, unknown> = { id: n.id, type: n.type }
    if (includeFields.has('title')) projected.title = n.title
    if (includeFields.has('status')) projected.status = n.status
    if (includeFields.has('tags')) projected.tags = n.tags
    if (includeFields.has('description')) projected.description = n.description
    if (includeFields.has('properties')) projected.properties = n.properties
    return projected
  })

  const edgeInclude = params.edgeInclude
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
  return result
}

// ── Human renderer ────────────────────────────────────────────────────────

/**
 * Render traversal result as a compact human listing.
 * Nodes are printed with formatNode; edges as a dim one-liner underneath.
 */
function renderResult(result: TraverseResult): void {
  if (result.total_nodes === 0) {
    process.stderr.write('No matching entities.\n')
    return
  }

  // Print nodes
  for (const n of result.nodes) {
    // Re-use formatNode by casting to the expected shape. formatNode only reads
    // id, type, title, status - all always present after projection adds type.
    const asNode = n as unknown as UPGBaseNode
    console.log(formatNode(asNode, '  '))
  }

  // Print edges
  if (result.edges.length > 0) {
    console.log()
    for (const e of result.edges) {
      const src = sanitizeForTerminal(String(e.source ?? ''))
      const tgt = sanitizeForTerminal(String(e.target ?? ''))
      const typ = sanitizeForTerminal(String(e.type ?? ''))
      console.log(label(`  ${src} --[${typ}]--> ${tgt}`))
    }
  }

  console.log()
  const truncNote = result.truncated
    ? ` (truncated at depth ${result.truncated_at_depth ?? '?'}, increase --limit to see more)`
    : ''
  process.stderr.write(`  ${result.total_nodes} nodes, ${result.total_edges} edges${truncNote}\n`)
}

// ── Command definition ────────────────────────────────────────────────────

export const queryCommand = new Command('query')
  .description('BFS traversal with projection. Follows edges from a start set.')
  .option('--from <type>', 'Start set: all nodes of this entity type')
  .option('--from-id <id>', 'Start set: a single node by ID')
  .option(
    '--traverse <edges>',
    'Comma-separated edge types per BFS level. Supports !negation. Repeats the last entry for deeper levels.',
  )
  .option('--depth <n>', 'Max traversal depth (default 3, max 10)', (v) => {
    const n = parseInt(v, 10)
    if (!Number.isFinite(n) || n < 1) throw new InvalidArgumentError('--depth must be a positive integer.')
    return n
  }, 3)
  .option('--include <fields>', 'Node fields to project: title,status,tags,description,properties (comma-separated)')
  .option('--edge-include <fields>', 'Edge fields to project: id,type,source,target. Pass "" to omit edges.')
  .option('--limit <n>', 'Max nodes to collect (default 200)', (v) => {
    const n = parseInt(v, 10)
    if (!Number.isFinite(n) || n < 1) throw new InvalidArgumentError('--limit must be a positive integer.')
    return n
  }, 200)
  .option('--file <path>', 'Path to .upg file')
  .option('--json', 'Machine-readable JSON output matching the MCP query shape')
  .action(async (opts) => {
    try {
      if (!opts.from && !opts.fromId) {
        die(usageError('Provide --from <type> or --from-id <id> to define the start set.'))
      }

      // Parse --traverse: split on comma, trim whitespace
      let traverseEdgeTypes: string[] | undefined
      if (opts.traverse) {
        traverseEdgeTypes = (opts.traverse as string)
          .split(',')
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)
        if (traverseEdgeTypes.length === 0) traverseEdgeTypes = undefined
      }

      // Parse --include fields
      const defaultIncludeFields = ['title', 'status', 'type']
      const includeFields = opts.include
        ? new Set(
            (opts.include as string)
              .split(',')
              .map((s: string) => s.trim())
              .filter((s: string) => s.length > 0),
          )
        : new Set(defaultIncludeFields)
      includeFields.add('id')
      includeFields.add('type')

      // Parse --edge-include fields
      // An explicitly empty string means "omit all edges"
      let edgeInclude: string[] | undefined
      if (opts.edgeInclude !== undefined) {
        const raw = (opts.edgeInclude as string).trim()
        edgeInclude = raw === ''
          ? []
          : raw.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
      }

      const maxDepth = Math.min(Math.max(opts.depth as number, 1), 10)
      const maxNodes = Math.min(Math.max(opts.limit as number, 1), 1000)

      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const result = runBFS(store, {
        from: opts.from as string | undefined,
        fromId: opts.fromId as string | undefined,
        traverse: traverseEdgeTypes,
        depth: maxDepth,
        limit: maxNodes,
        include: includeFields,
        edgeInclude,
      })

      store.stopWatching()

      if (opts.json) {
        // Emit MCP-compatible shape: nodes, edges, total_nodes, total_edges,
        // and conditionally truncated / truncated_at_depth.
        const output: Record<string, unknown> = {
          nodes: result.nodes,
          edges: result.edges,
          total_nodes: result.total_nodes,
          total_edges: result.total_edges,
        }
        if (result.truncated) {
          output.truncated = true
          output.truncated_at_depth = result.truncated_at_depth
        }
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
        return
      }

      const subtitle = opts.from
        ? `Query - from:${opts.from}`
        : `Query - from-id:${opts.fromId}`
      process.stderr.write(upgHeader(subtitle) + '\n')

      renderResult(result)
    } catch (err) {
      die(err)
    }
  })
