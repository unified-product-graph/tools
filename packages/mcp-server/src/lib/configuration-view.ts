/**
 * The `configuration` read parameter (0.30.0).
 *
 * A read tool that accepts `configuration` answers from ONE member of the
 * configuration family instead of from the union. The whole mechanism is the
 * spec's projection operator plus a reader over its result, so every tool that
 * opts in gets identical semantics rather than its own approximation.
 *
 * UNKNOWN AXES AND VALUES ARE ERRORS, NEVER SILENT NO-OPS. A typo in an axis id
 * that quietly returned the union would be the worst possible outcome: the
 * caller believes they are looking at one configuration and are in fact looking
 * at all of them superposed, which is exactly the confusion this release
 * exists to remove.
 */

import {
  projectGraph,
  type Configuration,
  type ProjectableEdge,
  type ProjectableNode,
} from '@unified-product-graph/core'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'

/**
 * What a projected read exposes: the three methods `assembleTree` and `query`
 * consume, matching the SDK's `GraphReader`.
 */
export interface GraphReaderLike {
  getNode(id: string): UPGBaseNode | undefined
  getAllNodes(): UPGBaseNode[]
  getEdgesForNode(id: string): UPGEdge[]
}

/**
 * What resolving a configuration needs to READ. Every caller passes the real
 * store, which exposes the whole edge list directly, so the edge set is taken
 * from `getAllEdges` rather than reassembled node by node: the fan-out version
 * visited each edge twice and needed its own deduplication to undo that.
 */
export interface ProjectableSource extends GraphReaderLike {
  getAllEdges(): UPGEdge[]
}

export interface ConfigurationResolution {
  /** Present when the caller asked for a configuration and it resolved. */
  reader?: GraphReaderLike
  /** The resolved configuration, echoed so a tool can report what it applied. */
  configuration?: Configuration
  /** A caller-facing message when the requested configuration cannot be honoured. */
  error?: string
  /** Counts of what the projection removed, for the tool's response envelope. */
  projection?: {
    excluded_nodes: number
    deactivated_edges: number
    dangling_edges: number
  }
}

/**
 * Resolve a `configuration` argument against a graph.
 *
 * Accepts an axis by node id or, when unambiguous, by title: an agent that has
 * just read a graph knows the axis by name, and forcing an id lookup for a
 * two-axis product is friction with no safety benefit. Ambiguity is refused
 * rather than guessed.
 *
 * @returns `{}` when no configuration was requested (the tool reads the union,
 *   exactly as before), `{ error }` when it cannot be honoured, or
 *   `{ reader, configuration, projection }` when it can.
 */
export function resolveConfiguration(
  raw: unknown,
  store: ProjectableSource,
): ConfigurationResolution {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'configuration must be an object mapping axis id to a single value.' }
  }
  const requested = raw as Record<string, unknown>
  const keys = Object.keys(requested)
  if (keys.length === 0) return {}

  const nodes = store.getAllNodes()
  const axes = nodes.filter((n) => (n.type as string) === 'configuration_axis')
  if (axes.length === 0) {
    return {
      error:
        'This graph declares no configuration_axis nodes, so it has only one configuration. Remove the `configuration` argument to read it.',
    }
  }

  const resolved: Record<string, string> = {}
  for (const key of keys) {
    const value = requested[key]
    if (typeof value !== 'string') {
      return { error: `configuration["${key}"] must be a string naming one value of that axis.` }
    }

    let axis = axes.find((a) => a.id === key)
    if (!axis) {
      const byTitle = axes.filter((a) => (a.title as string) === key)
      if (byTitle.length > 1) {
        return {
          error: `"${key}" matches ${byTitle.length} configuration axes by title. Use the axis node id instead.`,
        }
      }
      axis = byTitle[0]
    }
    if (!axis) {
      return {
        error: `Unknown configuration axis "${key}". This graph declares: ${axes
          .map((a) => `${a.id} (${a.title as string})`)
          .join(', ')}.`,
      }
    }

    const values = readValues(axis)
    if (!values.includes(value)) {
      return {
        error: `Axis "${axis.id}" does not declare the value "${value}". Its values are [${values.join(', ')}].`,
      }
    }
    resolved[axis.id] = value
  }

  const allEdges = store.getAllEdges()
  const projected = projectGraph(
    nodes as unknown as ProjectableNode[],
    allEdges as unknown as ProjectableEdge[],
    resolved,
  )

  const survivingNodes = projected.nodes as unknown as UPGBaseNode[]
  const survivingEdges = projected.edges as unknown as UPGEdge[]
  const byId = new Map(survivingNodes.map((n) => [n.id, n]))
  const edgesByNode = new Map<string, UPGEdge[]>()
  for (const edge of survivingEdges) {
    for (const endpoint of [edge.source, edge.target]) {
      const list = edgesByNode.get(endpoint) ?? []
      list.push(edge)
      edgesByNode.set(endpoint, list)
    }
  }

  return {
    configuration: resolved,
    projection: {
      excluded_nodes: projected.excluded_node_ids.length,
      deactivated_edges: projected.deactivated_edge_count,
      dangling_edges: projected.dangling_edge_count,
    },
    reader: {
      getNode: (id) => byId.get(id),
      getAllNodes: () => survivingNodes,
      getEdgesForNode: (id) => edgesByNode.get(id) ?? [],
    },
  }
}

function readValues(axis: UPGBaseNode): string[] {
  const raw = (axis as { properties?: Record<string, unknown> }).properties?.values
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string')
}
