/**
 * Node tools: read, search, traverse, mutate, batch, migrate, dedupe.
 * Every batch handler validates the entire payload before any mutation lands.
 * `update_node` delegates to `migrateNodeType` (atomic with rollback) when the
 * caller passes a `type` change.
 */

import type { ToolContext, ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { preflightPayload, getSoftLimit } from '../lib/payload-guard.js'
import { degradeProgressively } from '../lib/payload-degrader.js'
import path from 'node:path'
import { edgeId, UPGFileStore } from '@unified-product-graph/sdk'
import {
  isPortfolioScopedType,
  writePortfolioScopedNode,
  PortfolioRoutingError,
  openPortfolioStoreIfExists,
} from '@unified-product-graph/sdk'
import { resolveScopedProducts } from './portfolio-read.js'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'
import {
  UPG_MIGRATIONS,
  UPG_EDGE_CATALOG,
  UPG_VALID_CHILDREN,
  UPG_VERSION,
  REGISTRY_PRODUCT_ID,
  migrateEdge,
  migrateNodeProperties,
  getPropertySchema,
  resolveContainmentEdge,
  type UPGPropertyMigrationChange,
} from '@unified-product-graph/core'
import {
  normalizeTags,
  searchNodes as searchNodesLib,
  listNodes as listNodesLib,
  getNode as getNodeLib,
  getNodes as getNodesLib,
  createNode as createNodeLib,
  deleteNode as deleteNodeLib,
  validateStatusAgainstLifecycle,
  migrateNodeType as migrateNodeTypeLib,
  batchCreateNodes as batchCreateNodesLib,
  applyScalarToEdgeMigrations,
  UnknownEntityTypeError,
  type GetNodeResult,
} from '@unified-product-graph/sdk'
import { buildEntitySchema, type MigrateTypeResult } from '@unified-product-graph/mcp-tooling'
import {
  checkPropertyTypes,
  renderPropertyTypeWarning,
} from '@unified-product-graph/sdk'
import { checkLengthCaps } from '@unified-product-graph/sdk'
import { resolveConfiguration } from '../lib/configuration-view.js'

// ── Unknown-property guard ─────────────────────────────────────────

/**
 * Validate `properties` against the entity type's property schema.
 *
 * @returns `unknown_properties` (keys not in the schema) and a `warning`
 *   string suitable for embedding in the tool response. Both are empty/undefined
 *   when all properties are canonical.
 *
 * Entity types with no registered schema (no typed properties) are treated as
 * fully permissive: no unknowns reported.
 */
function checkUnknownProperties(
  entityType: string,
  properties: Record<string, unknown> | undefined,
): { unknown_properties: string[]; warning: string | undefined } {
  if (!properties || Object.keys(properties).length === 0) {
    return { unknown_properties: [], warning: undefined }
  }
  const schema = getPropertySchema(entityType)
  if (!schema) {
    // No schema registered for this type; all properties are allowed.
    return { unknown_properties: [], warning: undefined }
  }
  const unknown = Object.keys(properties).filter((k) => !(k in schema))
  if (unknown.length === 0) return { unknown_properties: [], warning: undefined }
  const warning =
    `Unknown properties for type "${entityType}": [${unknown.map((k) => `"${k}"`).join(', ')}]. ` +
    `These will be stored but are not part of the canonical UPG schema. ` +
    `Check get_entity_schema("${entityType}") for the canonical property list.`
  return { unknown_properties: unknown, warning }
}

/**
 * List entities in the graph with filtering, edge inclusion, and count-only
 * mode. Supports pagination. Filters compose with AND semantics; `tags` matches
 * any.
 *
 * For graph-wide edge enumeration, prefer `export_edges` (flat) or `query`
 * (traversal). `list_nodes(include_edges:true)` is for entity-scoped reads,
 * not flat edge dumps.
 *
 * @returns JSON: `{ nodes, total, offset, limit, _hash }`. With
 *   `count_only: true`, returns `{ total, _hash }` only. May include a
 *   `degraded` block when the response was auto-trimmed to fit.
 * @warning Pre-flight payload guardrail: refuses with a steering
 *   error when the estimated response exceeds `UPG_MCP_PAYLOAD_HARD_LIMIT`
 *   (default 150 KB), and attaches a `_warning` field above
 *   `UPG_MCP_PAYLOAD_SOFT_LIMIT` (default 50 KB). For graph-wide reads,
 *   prefer `query` with a tight projection.
 * @warning Auto-degrade: between the soft and hard limits, the
 *   response is automatically truncated. Surfaced as
 *   `degraded.applied: ['truncate_at_count_auto']` on the response.
 * @atomicity atomic (read-only)
 * @see search_nodes
 * @see query
 */
export const listNodes: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const ifChangedList = args.if_changed_since as string | undefined
  const currentHashList = store.getContentHash()
  if (ifChangedList && ifChangedList === currentHashList) {
    return text(JSON.stringify({ changed: false, _hash: currentHashList }, null, 2))
  }

  const countOnly = (args.count_only as boolean) ?? false
  const offset = (args.offset as number) ?? 0
  const limit = Math.min((args.limit as number) ?? 50, 200)
  const includeEdges = (args.include_edges as boolean) ?? false

  const result = listNodesLib(store, {
    type: args.type as string | undefined,
    status: args.status as string | undefined,
    tags: args.tags as string[] | undefined,
    parentId: args.parent_id as string | undefined,
    includeEdges,
    countOnly,
    offset,
    limit,
  })

  if (countOnly) {
    return text(JSON.stringify({ total: result.total, _hash: currentHashList }, null, 2))
  }

  const countEdges = (nodes: typeof result.nodes) =>
    includeEdges
      ? nodes.reduce((sum, n) => sum + ((n.edges as unknown[] | undefined)?.length ?? 0), 0)
      : 0

  const guardOutcome = preflightPayload({
    toolName: 'list_nodes',
    nodeCount: result.nodes.length,
    edgeCount: countEdges(result.nodes),
    compactEdges: true,
    argsHint: `limit=${limit}, include_edges=${includeEdges}`,
  })
  if (guardOutcome.kind === 'refuse') return guardOutcome.result

  const response: Record<string, unknown> = {
    nodes: result.nodes,
    total: result.total,
    offset,
    limit,
    _hash: currentHashList,
  }

  if (guardOutcome.kind === 'warn') {
    // list_nodes already emits a tight projection; the only useful auto-degrade
    // is truncation. Try halving the page until the estimate fits.
    let workingNodes = result.nodes
    const degradeOutcome = degradeProgressively({
      toolName: 'list_nodes',
      initialBytes: guardOutcome.bytes,
      countAfterStage: () => ({
        nodeCount: workingNodes.length,
        edgeCount: countEdges(workingNodes),
        compactEdges: true,
      }),
      stages: [
        {
          name: 'truncate_at_count_auto',
          apply: () => {
            if (workingNodes.length <= 5) return false
            // Slice straight to the largest count that fits under soft;
            // soft / initialBytes is the survival ratio. Apply a 0.85 safety
            // factor so the post-truncate estimate lands clearly under.
            const soft = getSoftLimit()
            const ratio = guardOutcome.bytes < 1 ? 1 : Math.min(1, (soft / guardOutcome.bytes) * 0.85)
            const targetCount = Math.max(5, Math.floor(workingNodes.length * ratio))
            if (targetCount >= workingNodes.length) return false
            workingNodes = workingNodes.slice(0, targetCount)
            return true
          },
        },
      ],
    })
    response.nodes = workingNodes
    if (degradeOutcome.block) {
      response.degraded = degradeOutcome.block
    } else {
      Object.assign(response, guardOutcome.fields)
    }
  }
  return text(JSON.stringify(response, null, 2))
}

/**
 * Get a single entity by ID with its full properties and all connected edges.
 *
 * Accepts `node_id` (canonical) or its alias `id`.
 *
 * @returns JSON: the node object plus an `edges` array. `compact_edges: true`
 *   omits `source_title` and `target_title` (saves ~30% on edge-heavy nodes).
 * @throws Returns a textError when neither `node_id` nor `id` is provided, or
 *   the node does not exist.
 * @atomicity atomic (read-only)
 * @see get_nodes
 */
export const getNode: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  // N2 (UPG QA 0.8.7): accept bare `id` as an alias for `node_id`. `node_id` is
  // the canonical key (matches update_node / delete_node / batch ops); `id` is a
  // common first guess. Accept both; `node_id` wins if both are passed.
  const nodeId = (args.node_id ?? args.id) as string | undefined
  if (!nodeId) return textError(`Missing required parameter: node_id (alias: id)`)

  // Registry resolution (Batch-5 #23): a `registry/{id}` reference resolves the
  // canonical node from the portfolio registry — registry entities are first-class
  // for reads, not just for `list_registry`. The instances pointing at it (and
  // whether each is an `alias`) are attached so callers can see the canonical's reach.
  if (nodeId.startsWith(`${REGISTRY_PRODUCT_ID}/`)) {
    const bareId = nodeId.slice(REGISTRY_PRODUCT_ID.length + 1)
    const portfolioStore = await openPortfolioStoreIfExists(process.cwd())
    const canonical = portfolioStore?.getRegistryNode(bareId)
    if (!canonical) return textError(`Registry node not found: ${nodeId}`)
    const target = `${REGISTRY_PRODUCT_ID}/${bareId}`
    const allCross = portfolioStore!.getAllCrossEdges()
    const instances = allCross
      .filter((e) => e.type === 'instance_of' && e.target === target)
      .map((e) => ({ source: e.source, product_id: e.source_product_id, alias: e.alias ?? false }))
    // 0.10.4 (read-path brief A): when the canonical is a classification_value,
    // attach the incoming `*_classified_as_classification_value` edges so
    // "which competitors / nodes are classified as value X?" is one get_node
    // call, with each classification's properties (confidence / assessed_on / ...).
    const classifiedBy = allCross
      .filter((e) => e.type.endsWith('_classified_as_classification_value') && e.target === target)
      .map((e) => ({
        source: e.source,
        product_id: e.source_product_id,
        type: e.type,
        ...((e as { properties?: Record<string, unknown> }).properties
          ? { properties: (e as { properties?: Record<string, unknown> }).properties }
          : {}),
      }))
    // Registry-INTERNAL edges (feedback: registry-edge read path). Without these
    // the canonical's reach was reported from `instance_of` alone, so a canonical
    // held in place by spine or metric-bridge edges still read as unreferenced —
    // even on a correctly-qualified `registry/{id}` call.
    const registryEdges = portfolioStore!
      .listRegistryEdges()
      .filter((e) => e.source === bareId || e.target === bareId)
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: e.type,
        direction: e.source === bareId ? 'outbound' : 'inbound',
      }))
    return text(
      JSON.stringify(
        {
          node: canonical,
          registry: true,
          instance_count: instances.length,
          instances,
          registry_edge_count: registryEdges.length,
          ...(registryEdges.length > 0 ? { registry_edges: registryEdges } : {}),
          ...(classifiedBy.length > 0 ? { classified_by_count: classifiedBy.length, classified_by: classifiedBy } : {}),
        },
        null,
        2,
      ),
    )
  }

  const result = getNodeLib(store, {
    node_id: nodeId,
    compact_edges: (args.compact_edges as boolean) ?? false,
  })
  if (!result) {
    // Scope-mismatch honesty (feedback: registry-edge read path). A bare id that
    // misses in the active product may still be a registry canonical — the
    // registry branch above only fires on a `registry/{id}`-qualified id. Saying
    // "Node not found" for one reads as *does not exist*, which is how a
    // canonical with live registry edges gets planned around as absent.
    const portfolioStore = await openPortfolioStoreIfExists(process.cwd())
    const canonical = portfolioStore?.getRegistryNode(nodeId)
    if (canonical) {
      return textError(
        `"${nodeId}" is a registry canonical (type: ${canonical.type}), not a node in the active product. ` +
        `This tool is product-scoped. Re-run it as \`registry/${nodeId}\` to read the canonical, ` +
        `or see \`list_registry\` / \`list_registry_edges\`.`,
      )
    }
    return textError(`Node not found: ${nodeId}`)
  }

  // Surface unknown-property warnings on read, matching the shape
  // used by write paths (create_node / update_node). Nodes with deprecated
  // inline properties (e.g. persona.goals / persona.frustrations in earlier
  // versions) are flagged here so callers know to migrate without having to
  // run validate_graph.
  const typed = result as GetNodeResult
  if (typed.node.properties) {
    const { unknown_properties, warning } = checkUnknownProperties(typed.node.type as string, typed.node.properties)
    if (unknown_properties.length > 0) {
      const withWarning: Record<string, unknown> = { ...typed, unknown_properties, warning }
      return text(JSON.stringify(withWarning, null, 2))
    }
  }

  return text(JSON.stringify(result, null, 2))
}

/**
 * Batch-fetch multiple entities by ID. Returns each node with its edges. More
 * efficient than multiple `get_node` calls.
 *
 * @returns JSON array of node objects with edges. Missing IDs are silently
 *   skipped. May include a `degraded` block when the response was
 *   auto-trimmed to fit.
 * @throws Returns a textError when `ids` is missing/empty or longer than 50.
 * @warning Pre-flight payload guardrail: refuses above
 *   `UPG_MCP_PAYLOAD_HARD_LIMIT` (default 150 KB), warns above
 *   `UPG_MCP_PAYLOAD_SOFT_LIMIT` (default 50 KB). 50 edge-heavy nodes can
 *   still cross 50 KB. Pass `compact_edges:true` to halve edge size.
 * @warning Auto-degrade: between soft and hard limits, the server
 *   may drop edge titles, optional node fields, or truncate the result list.
 *   Surfaced as `degraded.applied[]` on the response.
 * @atomicity atomic (read-only)
 * @see get_node
 */
export const getNodes: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  const ids = args.ids as string[] | undefined
  if (!ids || !Array.isArray(ids) || ids.length === 0)
    return textError('Missing required parameter: ids (non-empty array)')
  if (ids.length > 50)
    return textError('Maximum 50 IDs per batch request')

  const requestedCompactEdges = (args.compact_edges as boolean) ?? false

  // #34: a bare id reads the active store; a qualified `{product_id}/{node_id}`
  // reads that product's graph (read-only for non-active products) — so the
  // portfolio-wide refs that list_registry / export_edges / cross-edges return
  // resolve to real node content instead of `not_found`, with no serial
  // switch_product sweep.
  const bareIds: string[] = []
  const crossByProduct = new Map<string, string[]>()
  for (const id of ids) {
    const slash = id.indexOf('/')
    if (slash > 0) {
      const productId = id.slice(0, slash)
      const nodeId = id.slice(slash + 1)
      const group = crossByProduct.get(productId)
      if (group) group.push(nodeId)
      else crossByProduct.set(productId, [nodeId])
    } else {
      bareIds.push(id)
    }
  }

  const result = getNodesLib(store, { ids: bareIds, compact_edges: requestedCompactEdges })
  const notFound: string[] = [...(result.not_found ?? [])]

  if (crossByProduct.size > 0) {
    const cwd = process.cwd()
    const activePath = store.getFilePath()
    for (const [productId, nodeIds] of crossByProduct) {
      const { products } = resolveScopedProducts(cwd, [productId])
      const prod = products[0]
      if (!prod) {
        for (const nid of nodeIds) notFound.push(`${productId}/${nid}`)
        continue
      }
      let crossStore: UPGFileStore
      if (activePath && path.resolve(activePath) === path.resolve(prod.absPath)) {
        crossStore = store
      } else {
        crossStore = new UPGFileStore()
        await crossStore.loadReadOnly(prod.absPath)
      }
      const sub = getNodesLib(crossStore, { ids: nodeIds, compact_edges: requestedCompactEdges })
      for (const wrapper of sub.nodes) {
        ;(wrapper as unknown as Record<string, unknown>).product_id = productId
        result.nodes.push(wrapper)
      }
      for (const nf of sub.not_found ?? []) notFound.push(`${productId}/${nf}`)
    }
    result.total = result.nodes.length
  }
  if (notFound.length > 0) result.not_found = notFound

  const countEdges = (nodes: typeof result.nodes) =>
    nodes.reduce((sum, n) => sum + (n.edges_out?.length ?? 0) + (n.edges_in?.length ?? 0), 0)

  const guardOutcome = preflightPayload({
    toolName: 'get_nodes',
    nodeCount: result.nodes.length,
    edgeCount: countEdges(result.nodes),
    compactEdges: requestedCompactEdges,
    argsHint: `${ids.length} ids, compact_edges=${requestedCompactEdges}`,
  })
  if (guardOutcome.kind === 'refuse') return guardOutcome.result

  if (guardOutcome.kind === 'ok') {
    return text(JSON.stringify(result, null, 2))
  }

  // Warn path: try progressive degradation.
  let workingNodes = result.nodes
  let effectiveCompactEdges = requestedCompactEdges
  let droppedFields = false

  const degradeOutcome = degradeProgressively({
    toolName: 'get_nodes',
    initialBytes: guardOutcome.bytes,
    countAfterStage: () => ({
      nodeCount: workingNodes.length,
      edgeCount: countEdges(workingNodes),
      compactEdges: effectiveCompactEdges,
    }),
    stages: [
      {
        name: 'compact_edges_auto',
        apply: () => {
          if (effectiveCompactEdges) return false
          for (const wrapper of workingNodes) {
            wrapper.edges_out = wrapper.edges_out.map((e) => ({
              id: e.id, type: e.type, source: e.source, target: e.target,
            }))
            wrapper.edges_in = wrapper.edges_in.map((e) => ({
              id: e.id, type: e.type, source: e.source, target: e.target,
            }))
          }
          effectiveCompactEdges = true
          return true
        },
      },
      {
        name: 'drop_optional_fields_auto',
        apply: () => {
          if (droppedFields) return false
          let changed = false
          for (const wrapper of workingNodes) {
            const node = wrapper.node as unknown as Record<string, unknown>
            if ('description' in node) { delete node.description; changed = true }
            if ('properties' in node) { delete node.properties; changed = true }
          }
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
          workingNodes = workingNodes.slice(0, targetCount)
          return true
        },
      },
    ],
  })

  const response: Record<string, unknown> = { ...result, nodes: workingNodes }
  if (degradeOutcome.block) response.degraded = degradeOutcome.block
  else Object.assign(response, guardOutcome.fields)
  return text(JSON.stringify(response, null, 2))
}

/**
 * Search entities by text. Default fields: title (score 3) and description
 * (score 1). Pass `fields` to also search `tags` (score 2) and `properties`
 * (score 1). Results include `match_field` and `score` per hit.
 *
 * @returns JSON: `{ results: Array<{ id, type, title, status, tags,
 *   match_field, score }>, total, searched_fields }`.
 * @throws Returns a textError when `query` is missing.
 * @atomicity atomic (read-only)
 * @see list_nodes
 * @see query
 */
export const searchNodes: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  if (!args.query) return textError(`Missing required parameter: query`)
  const searchFields = (args.fields as string[] | undefined) ?? ['title', 'description']

  const scored = searchNodesLib(store, args.query as string, {
    type: args.type as string | undefined,
    fields: searchFields,
    limit: (args.limit as number) ?? 20,
  })

  return text(
    JSON.stringify(
      {
        results: scored.map((s) => ({
          id: s.node.id,
          type: s.node.type,
          title: s.node.title,
          status: s.node.status,
          tags: s.node.tags,
          match_field: s.match_field,
          score: s.score,
        })),
        total: scored.length,
        searched_fields: searchFields,
      },
      null,
      2,
    ),
  )
}

/**
 * Traverse the graph following typed edges. Returns a subgraph (nodes + edges)
 * in a single call. Replaces multi-step fetch patterns for trees and discovery
 * flows. Supports BFS with per-level edge-type filters, negation (`!type`),
 * field projection, and diff-based repeat queries via `diff_from`.
 *
 * @returns JSON: `{ nodes, edges, total_nodes, total_edges, _result_id,
 *   truncated?, truncated_at_depth?, diff? }`. The `_result_id` is a cache
 *   handle for `diff_from`; cache holds the last 20 results.
 * @throws Returns a textError when neither `from` nor `from_id` is provided,
 *   or when `from_id` does not exist.
 * @warning Pre-flight payload guardrail: refuses above
 *   `UPG_MCP_PAYLOAD_HARD_LIMIT` (default 150 KB), warns above
 *   `UPG_MCP_PAYLOAD_SOFT_LIMIT` (default 50 KB). Tighten with `include`
 *   (e.g. `["title"]`) or `edge_include: []` to drop edges from the wire.
 * @atomicity atomic (read-only)
 * @see list_nodes
 * @see get_area_graph
 */
export const query: ToolHandler = (args, ctx): ToolResult => {
  const { store: unprojectedStore, queryCache } = ctx
  // 0.30.0: read one member of the configuration family instead of the union.
  // Resolving to a projected READER rather than mutating anything keeps the
  // union on disk untouched: a projection is a way of looking, never a write.
  const configResolution = resolveConfiguration(args.configuration, unprojectedStore)
  if (configResolution.error) return textError(configResolution.error)
  const store = (configResolution.reader ?? unprojectedStore) as typeof unprojectedStore
  const fromType = args.from as string | undefined
  const fromId = args.from_id as string | undefined
  if (!fromType && !fromId)
    return textError('Provide either "from" (entity type) or "from_id" (node ID)')

  const traverseEdgeTypes = args.traverse as string[] | undefined
  const maxDepth = Math.min(Math.max((args.depth as number) ?? 3, 1), 10)
  const maxNodes = Math.min(Math.max((args.limit as number) ?? 200, 1), 1000)
  const includeFields = new Set(
    (args.include as string[] | undefined) ?? ['title', 'status', 'type'],
  )
  includeFields.add('id')
  includeFields.add('type')

  let startNodes: UPGBaseNode[]
  if (fromId) {
    const node = store.getNode(fromId)
    if (!node) return textError(`Node not found: ${fromId}`)
    startNodes = [node]
  } else {
    startNodes = store.getAllNodes().filter((n) => n.type === fromType)
  }

  if (startNodes.length === 0)
    return text(JSON.stringify({ nodes: [], edges: [], total_nodes: 0, total_edges: 0 }, null, 2))

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

    const edges = store.getEdgesForNode(id)
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
        const neighbor = store.getNode(neighborId)
        if (neighbor) {
          if (collectedNodes.length >= maxNodes) { truncated = true; break }
          collectedNodes.push(neighbor)
          queue.push({ id: neighborId, level: level + 1 })
        }
      }
    }
  }

  const propInclude = args.property_include as string[] | undefined
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

  const edgeInclude = args.edge_include as string[] | undefined
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

  const response: Record<string, unknown> = {
    nodes: projectedNodes,
    edges: edgeArray,
    total_nodes: projectedNodes.length,
    total_edges: edgeArray.length,
  }
  if (truncated) {
    response.truncated = true
    response.truncated_at_depth = maxDepthReached
    response.hint = `Limit of ${maxNodes} nodes reached at depth ${maxDepthReached}. Increase limit to see deeper results.`
  }

  const queryCompactEdges = !edgeInclude || (edgeInclude && !edgeInclude.includes('source_title') && !edgeInclude.includes('target_title'))
  const queryGuard = preflightPayload({
    toolName: 'query',
    nodeCount: projectedNodes.length,
    edgeCount: edgeArray.length,
    compactEdges: queryCompactEdges,
    argsHint: `from=${fromType ?? fromId}, depth=${maxDepth}, limit=${maxNodes}`,
  })
  if (queryGuard.kind === 'refuse') return queryGuard.result

  if (queryGuard.kind === 'warn') {
    let workingNodes = projectedNodes
    let workingEdges = edgeArray
    let droppedFields = false
    const queryDegrade = degradeProgressively({
      toolName: 'query',
      initialBytes: queryGuard.bytes,
      countAfterStage: () => ({
        nodeCount: workingNodes.length,
        edgeCount: workingEdges.length,
        compactEdges: queryCompactEdges,
      }),
      stages: [
        {
          name: 'drop_optional_fields_auto',
          apply: () => {
            if (droppedFields) return false
            let changed = false
            for (const n of workingNodes) {
              if ('description' in n) { delete (n as Record<string, unknown>).description; changed = true }
              if ('properties' in n) { delete (n as Record<string, unknown>).properties; changed = true }
            }
            droppedFields = changed
            return changed
          },
        },
        {
          name: 'truncate_at_count_auto',
          apply: () => {
            if (workingNodes.length <= 1) return false
            const soft = getSoftLimit()
            const ratio = queryGuard.bytes < 1 ? 1 : Math.min(1, (soft / queryGuard.bytes) * 0.85)
            const targetCount = Math.max(1, Math.floor(workingNodes.length * ratio))
            if (targetCount >= workingNodes.length) return false
            const keepIds = new Set(workingNodes.slice(0, targetCount).map((n) => n.id as string))
            workingNodes = workingNodes.slice(0, targetCount)
            workingEdges = workingEdges.filter((e) => keepIds.has(e.source as string) && keepIds.has(e.target as string))
            return true
          },
        },
      ],
    })
    response.nodes = workingNodes
    response.edges = workingEdges
    response.total_nodes = workingNodes.length
    response.total_edges = workingEdges.length
    if (queryDegrade.block) response.degraded = queryDegrade.block
    else Object.assign(response, queryGuard.fields)
  }

  const diffFrom = args.diff_from as string | undefined
  const resultId = `qr_${++queryCache.counter}`
  const cacheEntry = {
    params: JSON.stringify({ from: fromType, from_id: fromId, traverse: traverseEdgeTypes, depth: maxDepth }),
    nodes: projectedNodes.map((n) => ({ id: n.id as string, type: n.type as string })),
    edges: edgeArray.map((e) => ({ id: (e.id ?? '') as string })),
    timestamp: new Date().toISOString(),
  }

  if (diffFrom && queryCache.entries.has(diffFrom)) {
    const prev = queryCache.entries.get(diffFrom)!
    const prevNodeIds = new Set(prev.nodes.map((n) => n.id))
    const currNodeIds = new Set(cacheEntry.nodes.map((n) => n.id))
    const added = projectedNodes.filter((n) => !prevNodeIds.has(n.id as string))
    const removed = prev.nodes.filter((n) => !currNodeIds.has(n.id))
    const diff: Record<string, unknown> = {
      added,
      removed,
      added_count: added.length,
      removed_count: removed.length,
    }

    // 0.30.0: edge deltas, when the caller asked for edges at all.
    //
    // This is what makes two `query` calls that differ only by `configuration`
    // a configuration DIFF, with no new tool. Node deltas alone answer "which
    // surfaces exist differently" but not the case the field report opened
    // with: an occupant that MOVES between rows while the rows and the occupant
    // all persist. That difference is entirely in the edges.
    //
    // Gated on what the CALLER ASKED FOR, not on how many edges came back.
    // `edge_include: []` means "do not send me edges", and reading that as
    // "the edges are gone" reports every edge in the previous result as
    // removed: a diff that invents a deletion from a display preference. The
    // two states are only distinguishable from the argument, so the argument is
    // what the gate reads.
    const edgesExcluded = edgeInclude !== undefined && edgeInclude.length === 0
    if (!edgesExcluded && (edgeArray.length > 0 || (prev.edges?.length ?? 0) > 0)) {
      const prevEdgeIds = new Set((prev.edges ?? []).map((e) => e.id).filter(Boolean))
      const currEdgeIds = new Set(cacheEntry.edges.map((e) => e.id).filter(Boolean))
      const edgesAdded = edgeArray.filter(
        (e) => e.id !== undefined && e.id !== '' && !prevEdgeIds.has(e.id as string),
      )
      const edgesRemoved = (prev.edges ?? []).filter(
        (e) => e.id !== '' && !currEdgeIds.has(e.id),
      )
      if (edgesAdded.length > 0 || edgesRemoved.length > 0) {
        diff.edges_added = edgesAdded
        diff.edges_removed = edgesRemoved
        diff.edges_added_count = edgesAdded.length
        diff.edges_removed_count = edgesRemoved.length
      }
    }
    response.diff = diff
  }

  queryCache.entries.set(resultId, cacheEntry)
  response._result_id = resultId

  if (queryCache.entries.size > 20) {
    const oldest = queryCache.entries.keys().next().value
    if (oldest) queryCache.entries.delete(oldest)
  }

  return text(JSON.stringify(response, null, 2))
}

/**
 *; first-use schema hints.
 *
 * Build a compact hints block when the caller has just created their FIRST
 * node of a given type in this graph. Pulls anti-patterns, the next entity
 * in the domain's creation sequence, and canonical out-edges from
 * `buildEntitySchema`. Intentionally caps the hint surface at the
 * highest-leverage signals; total response stays under ~500 tokens.
 *
 * Returns `undefined` when the type has no usable schema slice (no domain
 * guide, no edges out); silence beats noise.
 */
function buildFirstUseHints(canonicalType: string): Record<string, unknown> | undefined {
  let schema: ReturnType<typeof buildEntitySchema>
  try {
    schema = buildEntitySchema(canonicalType)
  } catch {
    return undefined
  }

  const antiPatterns = schema.domain_guide?.anti_patterns ?? []
  const sequence = schema.domain_guide?.creation_sequence ?? []
  const position = schema.domain_guide?.position_in_sequence ?? -1
  const nextInSequence =
    position >= 0 && position + 1 < sequence.length ? sequence[position + 1] : undefined

  // Cap to the 3 highest-signal items per axis. Anti-patterns are 1-line
  // strings (~150 chars each); edges are short identifiers (~40 chars).
  // Combined hint surface stays well under 500 tokens.
  const antiPatternStrings = antiPatterns
    .slice(0, 3)
    .map((ap) => (ap.name ? `${ap.name}: ${ap.description}` : ap.description))
    .filter((s) => s.length > 0)
  const edgesOut = schema.edges_out.slice(0, 5).map((e) => e.edge_type)

  if (antiPatternStrings.length === 0 && edgesOut.length === 0 && !nextInSequence) {
    return undefined
  }

  const hints: Record<string, unknown> = {
    schema_call: `get_entity_schema("${canonicalType}")`,
  }
  if (antiPatternStrings.length > 0) hints.anti_patterns = antiPatternStrings
  if (nextInSequence) hints.next_in_creation_sequence = nextInSequence
  if (edgesOut.length > 0) hints.canonical_edges_out = edgesOut
  return hints
}

/**
 * (orphan warning). When a node is created with no parent, warn if its
 * type is one the spec expects to hang off a parent. The signal is the domain
 * guide's creation sequence: a type at `position_in_sequence > 0` is a child of
 * some parent. Returns `undefined` for anchors, roots, and types with no guide,
 * so standalone entities never get a spurious warning.
 *
 * Parent resolution: the domain anchor is a reasonable default, but for types
 * whose real containment parent is a mid-cascade level it names the wrong node —
 * e.g. `strategic_theme` nests under `strategic_pillar`, not the strategy-domain
 * anchor `outcome`, which has no containment edge to it. So we name the anchor
 * only when it is genuinely a containment parent of this type; otherwise we
 * resolve the actual parent from `UPG_VALID_CHILDREN`, preferring one that has a
 * canonical containment edge. This fixes the whole class, not just one type.
 */
function buildOrphanWarning(canonicalType: string): string | undefined {
  let schema: ReturnType<typeof buildEntitySchema>
  try {
    schema = buildEntitySchema(canonicalType)
  } catch {
    return undefined
  }
  const guide = schema.domain_guide
  if (!guide || guide.position_in_sequence <= 0) return undefined

  const anchor = guide.anchor_entity
  let target: string | undefined
  if (anchor && anchor !== canonicalType && resolveContainmentEdge(anchor, canonicalType)) {
    target = anchor
  } else {
    const parents = Object.entries(UPG_VALID_CHILDREN)
      .filter(([, children]) => children.includes(canonicalType))
      .map(([parent]) => parent)
    target = parents.find((parent) => resolveContainmentEdge(parent, canonicalType)) ?? parents[0]
  }
  if (!target || target === canonicalType) return undefined

  const edge = resolveContainmentEdge(target, canonicalType)
  const via = edge ? ` (canonical edge: ${edge})` : ''
  return `Orphan: created ${canonicalType} with no parent. ${canonicalType} typically attaches under ${target}${via}. Pass parent_id on create, or wire it later with create_edge.`
}

/**
 * Create a new entity in the graph. Optionally connect it to a parent node via
 * `parent_id` (the edge type is inferred from the parent→child types). For 3+
 * entities, ALWAYS use `batch_create_nodes` instead.
 *
 * **Portfolio-scoped routing:** When `type` is `portfolio`,
 * `organization`, or `product_area`, the entity is written to
 * `.upg/portfolio.upg` (the portfolio document), NOT to the active product's
 * `nodes[]`. The portfolio document is created on demand. `organization` is a
 * singleton; pass `overwrite_organization: true` to replace an existing one.
 * `parent_id` is currently ignored for portfolio-scoped writes (the portfolio
 * document has its own parent edges modelled inside each typed record, e.g.
 * `parent_portfolio_id`).
 *
 * @returns JSON: `{ node, edge?, unknown_properties?, warning? }`. The `edge`
 *   field is present only when `parent_id` was supplied and a canonical
 *   hierarchy edge could be inferred. `unknown_properties` and `warning` are
 *   present when the caller passed properties not in the entity's schema.
 *   Pass `strict: true` to reject unknown properties instead of
 *   warning. For portfolio-scoped types the response shape is
 *   `{ node, portfolio_file, written_to, warning? }` where `node` is the
 *   persisted typed record.
 * @throws Returns a textError when `type` or `title` is missing, when the type
 *   is unknown (`UnknownEntityTypeError`), when `strict: true` and unknown
 *   properties are present, or when the underlying store rejects the write.
 * @atomicity atomic-with-rollback. Schema validation runs before mutation.
 * @see batch_create_nodes
 * @see update_node
 */

export const createNode: ToolHandler = async (args, ctx): Promise<ToolResult> => {
  const { store } = ctx
  if (!args.type) return textError(`Missing required parameter: type`)
  if (!args.title) return textError(`Missing required parameter: title`)

  const entityType = args.type as string
  const properties = args.properties as Record<string, unknown> | undefined
  const strict = (args.strict as boolean) ?? false

  // Portfolio-scoped routing. `portfolio`, `organization`, and
  // `product_area` belong in `.upg/portfolio.upg` and never in a product's
  // `nodes[]`. Routed before the schema check because these types are managed
  // by the portfolio-document shape (UPGPortfolio / UPGProductArea /
  // UPGOrganization), not by the entity-property schema registry used for
  // product nodes.
  if (isPortfolioScopedType(entityType)) {
    try {
      const result = await writePortfolioScopedNode(process.cwd(), {
        type: entityType,
        title: args.title as string,
        description: args.description as string | undefined,
        properties,
        overwrite_organization: (args.overwrite_organization as boolean | undefined) ?? false,
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

  const { unknown_properties, warning } = checkUnknownProperties(entityType, properties)
  if (strict && unknown_properties.length > 0) {
    return textError(
      `[strict mode] ${warning ?? `Unknown properties for type "${entityType}": [${unknown_properties.join(', ')}]`}`,
    )
  }

  // Property type validation; refuses declared-but-mismatched-type values.
  // F4 (2026-05-20). Undeclared properties are handled separately above.
  const { violations } = checkPropertyTypes(entityType, properties)
  if (violations.length > 0) {
    return textError(renderPropertyTypeWarning(entityType, violations)!)
  }

  // Length caps; soft warnings only, never refusals. F8 (2026-05-20).
  const { warnings: lengthWarnings } = checkLengthCaps({
    title: args.title as string,
    description: args.description as string | undefined,
    properties,
  })

  //: detect "first node of type" BEFORE the write lands. We compare
  // against the canonical type (post-alias resolution) so that authors who
  // pass a deprecated alias don't get hints on every call.
  let isFirstOfType = false
  try {
    const canonicalTypeForCheck = buildEntitySchema(entityType).type
    isFirstOfType = !store
      .getAllNodes()
      .some((n) => n.type === canonicalTypeForCheck)
  } catch {
    // Unknown type; let createNodeLib raise the canonical error below.
  }


  try {
    const result = createNodeLib(store, {
      type: entityType,
      title: args.title as string,
      description: args.description as string | undefined,
      tags: args.tags,
      status: args.status as string | undefined,
      properties,
      parent_id: args.parent_id as string | undefined,
    })

    //: attach first-use hints. Resolve the canonical type from the
    // returned node so aliases (e.g. `jtbd → job`) hint against the correct
    // canonical schema. Skipped on second-and-later calls of the same type.
    let hints: Record<string, unknown> | undefined
    if (isFirstOfType) {
      hints = buildFirstUseHints((result.node as { type: string }).type)
    }

    //: aggregate length-cap warnings with any existing warning.
    const aggregatedWarnings: string[] = []
    if (warning) aggregatedWarnings.push(warning)
    if (lengthWarnings.length > 0) aggregatedWarnings.push(...lengthWarnings)
    //: orphan warning. Only when no parent was supplied AND a canonical
    // parent edge was not inferred by the lib (a parent_id that resolved to an
    // edge means the node is wired). Resolve against the created node's
    // canonical type so aliases warn correctly.
    if (!args.parent_id && !(result as { edge?: unknown }).edge) {
      const orphanWarning = buildOrphanWarning((result.node as { type: string }).type)
      if (orphanWarning) aggregatedWarnings.push(orphanWarning)
    }
    // A3 (0.9.14): a parent_id whose (parent_type -> child_type) pair has no
    // canonical containment edge still resolves a lateral edge and writes it
    // silently. Surface it so the author can decide link-vs-nest (never a refusal).
    const a3LateralWarning = lateralParentWarning(store, args.parent_id as string | undefined, result)
    if (a3LateralWarning) aggregatedWarnings.push(a3LateralWarning)
    const libWarning = (result as { warning?: string }).warning
    const combinedWarning = libWarning
      ? aggregatedWarnings.length > 0
        ? `${libWarning} | ${aggregatedWarnings.join(' | ')}`
        : libWarning
      : aggregatedWarnings.length > 0
        ? aggregatedWarnings.join(' | ')
        : undefined

    if (unknown_properties.length > 0 || combinedWarning || hints) {
      const withExtras: Record<string, unknown> = { ...result }
      if (combinedWarning) withExtras.warning = combinedWarning
      if (unknown_properties.length > 0) withExtras.unknown_properties = unknown_properties
      if (hints) withExtras.hints = hints
      return text(JSON.stringify(withExtras, null, 2))
    }
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    if (err instanceof UnknownEntityTypeError) {
      return textError(err.message)
    }
    return textError((err as Error).message)
  }
}

/**
 * Update an existing entity. Unspecified fields are preserved. Passing `type`
 * performs a single-node migration (delegates to `migrateNodeType`): every
 * incident edge is re-inferred against the catalog and the change is atomic
 * with rollback. For 3+ entities, ALWAYS use `batch_update_nodes` instead.
 *
 * Pass `unset_properties: ["key", ...]` to DELETE property keys (applied
 * after the `properties` merge, so one call can set some keys and drop
 * others). An invalid lifecycle `status` is REJECTED (parity with
 * `create_node` / `batch_update_nodes`), not warned.
 *
 * @returns JSON: `{ node, warning?, unknown_properties?, unset? }`. `warning`
 *   aggregates migration warnings and any unknown-property notice.
 *   `unknown_properties` lists property keys not in the entity's schema.
 *   `unset` lists the keys actually removed. Pass `strict: true` to reject
 *   unknown properties instead of warning.
 * @throws Returns a textError when `node_id` is missing, the type migration
 *   fails, the `status` is not a valid lifecycle phase for the type, when
 *   `strict: true` and unknown properties are present, or when the underlying
 *   store rejects the patch.
 * @atomicity atomic-with-rollback (when `type` is changed); atomic for
 *   shallow-merge patches.
 * @see migrate_type
 * @see batch_update_nodes
 */
export const updateNode: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  if (!args.node_id) return textError(`Missing required parameter: node_id`)
  const nid = args.node_id as string
  const warnings: string[] = []
  const strict = (args.strict as boolean) ?? false

  if (args.type !== undefined) {
    const migrationResult = migrateNodeTypeLib(store, {
      node_id: nid,
      new_type: args.type as string,
    })
    if (!migrationResult.migrated) {
      return textError(migrationResult.error)
    }
    if (migrationResult.warning) warnings.push(migrationResult.warning)
  }

  const patch: Record<string, unknown> = {}
  if (args.title !== undefined) patch.title = args.title
  if (args.description !== undefined) patch.description = args.description
  if (args.tags !== undefined) patch.tags = normalizeTags(args.tags) ?? []
  if (args.status !== undefined) patch.status = args.status
  if (args.properties !== undefined) patch.properties = args.properties

  if (args.status !== undefined) {
    const existingNode = store.getNode(nid)
    if (existingNode) {
      // (Seam 1): REJECT an invalid lifecycle status, matching
      // create_node / batch (createNodeLib → validateNodeWrite throws). Update
      // previously only warned, so `update_node({status:"bogus"})` landed a
      // bad value silently. Single + batch + create are now consistent.
      const sw = validateStatusAgainstLifecycle(existingNode.type, args.status as string)
      if (sw) return textError(sw)
    }
  }

  // Unknown-property guard: check against the effective entity type
  // (post-migration type when args.type was provided, otherwise existing type).
  let unknownProperties: string[] = []
  if (args.properties !== undefined) {
    const nodeAfterTypeMigration = store.getNode(nid)
    const effectiveType = nodeAfterTypeMigration?.type ?? (args.type as string | undefined) ?? ''
    const { unknown_properties, warning: propWarning } = checkUnknownProperties(
      effectiveType,
      args.properties as Record<string, unknown>,
    )
    unknownProperties = unknown_properties
    if (strict && unknownProperties.length > 0) {
      return textError(
        `[strict mode] ${propWarning ?? `Unknown properties for type "${effectiveType}": [${unknownProperties.join(', ')}]`}`,
      )
    }
    if (propWarning) warnings.push(propWarning)

    // Property type validation; refuses declared-but-mismatched-type values.
    // F4 (2026-05-20).
    const { violations } = checkPropertyTypes(
      effectiveType,
      args.properties as Record<string, unknown>,
    )
    if (violations.length > 0) {
      return textError(renderPropertyTypeWarning(effectiveType, violations)!)
    }
  }

  // Length caps; soft warnings only, never refusals. F8 (2026-05-20).
  const { warnings: lengthWarnings } = checkLengthCaps({
    title: args.title as string | undefined,
    description: args.description as string | undefined,
    properties: args.properties as Record<string, unknown> | undefined,
  })
  if (lengthWarnings.length > 0) warnings.push(...lengthWarnings)

  try {
    let updated = store.updateNode(nid, patch)
    //: wire `unset_properties`. The handler previously ignored this
    // arg entirely (silent no-op) even though the store + SDK lib support it.
    // Applied AFTER the property merge so a single call can set some keys and
    // drop others. Unknown keys are simply not present in `removed`.
    let removedKeys: string[] | undefined
    const unsetArg = args.unset_properties
    if (Array.isArray(unsetArg) && unsetArg.length > 0) {
      const r = store.unsetNodeProperties(nid, unsetArg as string[])
      updated = r.node
      if (r.removed.length > 0) removedKeys = r.removed
    }
    const result: Record<string, unknown> = { node: updated }
    if (warnings.length > 0) result.warning = warnings.join(' | ')
    if (unknownProperties.length > 0) result.unknown_properties = unknownProperties
    if (removedKeys && removedKeys.length > 0) result.unset = removedKeys
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Remove an entity and all its connected edges from the graph. For 3+
 * entities, ALWAYS use `batch_delete_nodes` instead.
 *
 * @returns JSON: `{ node, removed_edge_ids }`.
 * @throws Returns a textError when `node_id` is missing or the node does not
 *   exist.
 * @atomicity atomic. Node + cascading edges removed in one mutation.
 * @see batch_delete_nodes
 */
export const deleteNode: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  if (!args.node_id) return textError(`Missing required parameter: node_id`)
  try {
    const result = deleteNodeLib(store, { node_id: args.node_id as string })
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Create up to 50 entities in a single call, optionally with explicit edges in
 * the same atomic transaction. Reference nodes created earlier in the batch via
 * `parent_ref` / `edges[].from_ref` / `to_ref`, using either a positional `$N`
 * (`"$0"`, `"$1"`) or a batch-local `ref` alias declared on a node (Batch-4
 * #16) — aliases remove the index-counting that most often breaks a batch. The
 * `edges` endpoints also accept existing node IDs. All nodes + edges are
 * validated against the schema BEFORE any mutation; on failure nothing lands
 * and the response carries the full `errors` list plus the alias `ref_map`.
 *
 * Pass `validate_only: true` (Batch-4 #15) for a dry-run: the full validation
 * pass runs and reports `{ valid, errors, would_create_nodes,
 * would_create_edges }` WITHOUT writing, so an agent can self-correct an entire
 * batch (bad type, wrong edge direction, invalid status, mis-counted ref)
 * before committing.
 *
 * @returns JSON: on commit, `{ created, edges, explicit_edges?, count,
 *   warnings? }`. On `validate_only`, `{ validate_only, valid, errors,
 *   would_create_nodes, would_create_edges, ref_map?, warnings? }`. On a failed
 *   commit, a `{ error, errors?, ref_map? }` error envelope.
 * @throws Returns an error envelope when `nodes` is missing/non-array or any
 *   validation fails (the batch is rejected atomically).
 * @atomicity atomic-with-rollback. Full validation pass first, then commit.
 *   `validate_only` never mutates.
 * @see create_node
 * @see batch_create_edges
 */
export const batchCreateNodes: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const nodes = args.nodes as Array<Record<string, unknown>> | undefined
  const explicitEdges = args.edges as Array<Record<string, unknown>> | undefined
  if (!nodes || !Array.isArray(nodes)) return textError('Missing required parameter: nodes (array)')

  const result = batchCreateNodesLib(store, {
    nodes: nodes as never,
    edges: explicitEdges as never,
    validateOnly: (args.validate_only as boolean) ?? false,
  })
  if (!result.ok) {
    // Batch-4 #15/#16: surface the full error list + alias ref_map as a JSON
    // envelope so the caller can self-correct, not just the first message.
    if ((result.errors && result.errors.length > 0) || result.ref_map) {
      const body: Record<string, unknown> = { error: result.error }
      if (result.errors) body.errors = result.errors
      if (result.ref_map) body.ref_map = result.ref_map
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true }
    }
    return textError(result.error)
  }
  const { ok: _ok, ...payload } = result
  void _ok
  // A3 (0.9.14): surface silent lateral-parent nestings (validate_only + commit).
  const a3 = batchLateralParentWarnings(store, nodes)
  if (a3.length > 0) {
    const existing = (payload as { warnings?: unknown }).warnings
    ;(payload as { warnings?: unknown }).warnings = Array.isArray(existing)
      ? [...existing, ...a3]
      : typeof existing === 'string'
        ? [existing, ...a3]
        : a3
  }
  return text(JSON.stringify(payload, null, 2))
}

/**
 * Update up to 50 entities in a single call. Unspecified fields are preserved.
 * Properties are merged with existing. Atomic: all succeed or all fail.
 *
 * Pass `unset_properties: ["key", ...]` on an entry to DELETE keys from that
 * node (0.29.0), applied after the merge. Because the merge preserves
 * unspecified keys, omitting a key never removes it; removal has to be asked
 * for. Writing `{ key: null }` stores a literal null, which on a numeric
 * property is a third state distinct from both a value and absence, so it is
 * rarely what a caller means.
 *
 * @returns JSON: `{ updated, count, unset?, warnings? }`. `unset` maps node id
 *   to the keys actually removed. `warnings` carries lifecycle-phase hints
 *   aggregated across the batch.
 * @throws Returns a textError when `updates` is missing/non-array, the array
 *   is empty, longer than 50, or any item references a missing node.
 * @atomicity atomic. Validation pass rejects the entire batch before any
 *   mutation lands.
 * @see update_node
 */
export const batchUpdateNodes: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const updates = args.updates as Array<Record<string, unknown>> | undefined
  if (!updates || !Array.isArray(updates)) return textError('Missing required parameter: updates (array)')
  if (updates.length === 0) return textError('updates array is empty')
  if (updates.length > 50) return textError('Maximum 50 updates per batch')

  for (let i = 0; i < updates.length; i++) {
    const u = updates[i]
    if (!u.node_id) return textError(`Update at index ${i}: missing required field "node_id"`)
    const existing = store.getNode(u.node_id as string)
    if (!existing) return textError(`Update at index ${i}: node "${u.node_id}" not found`)

    // Property type validation up-front, before any mutation. Reject the
    // whole batch on the first violation. F4 (2026-05-20).
    if (u.properties !== undefined) {
      const { violations } = checkPropertyTypes(
        existing.type as string,
        u.properties as Record<string, unknown>,
      )
      if (violations.length > 0) {
        return textError(
          `Update at index ${i}: ${renderPropertyTypeWarning(existing.type as string, violations)!}`,
        )
      }
    }
  }

  const updatedNodes: Array<{ id: string; type: string; title: string; status?: string }> = []
  const updateWarnings: string[] = []

  const unsetByNode: Record<string, string[]> = {}
  for (const u of updates) {
    const patch: Record<string, unknown> = {}
    if (u.title !== undefined) patch.title = u.title
    if (u.description !== undefined) patch.description = u.description
    if (u.status !== undefined) patch.status = u.status
    if (u.tags !== undefined) patch.tags = normalizeTags(u.tags) ?? []
    if (u.properties !== undefined) patch.properties = u.properties

    if (u.status !== undefined) {
      const existingNode = store.getNode(u.node_id as string)
      const entityType = existingNode?.type
      if (entityType) {
        const sw = validateStatusAgainstLifecycle(entityType, u.status as string)
        if (sw) updateWarnings.push(`Node "${u.node_id}": ${sw}`)
      }
    }

    // Length-cap soft warnings (per-item, never refusals). F8.
    const { warnings: lengthWarnings } = checkLengthCaps({
      title: u.title as string | undefined,
      description: u.description as string | undefined,
      properties: u.properties as Record<string, unknown> | undefined,
    })
    for (const w of lengthWarnings) updateWarnings.push(`Node "${u.node_id}": ${w}`)

    let updated = store.updateNode(u.node_id as string, patch)
    // 0.29.0: `unset_properties` reaches the batch path. It has worked on
    // `update_node` since, and the asymmetry was invisible from the
    // outside: a caller clearing one key per node across a graph had to fall
    // back to writing literal nulls, which is a different state from absent and
    // means something different again on a numeric property. Same semantics as
    // the single-node path, applied AFTER the merge so one entry can set some
    // keys and drop others.
    const unsetArg = u.unset_properties
    if (Array.isArray(unsetArg) && unsetArg.length > 0) {
      const r = store.unsetNodeProperties(u.node_id as string, unsetArg as string[])
      updated = r.node
      if (r.removed.length > 0) unsetByNode[u.node_id as string] = r.removed
    }
    updatedNodes.push({ id: updated.id, type: updated.type, title: updated.title, status: updated.status })
  }

  const batchUpdateResult: Record<string, unknown> = { updated: updatedNodes, count: updatedNodes.length }
  if (Object.keys(unsetByNode).length > 0) batchUpdateResult.unset = unsetByNode
  if (updateWarnings.length > 0) batchUpdateResult.warnings = updateWarnings
  return text(JSON.stringify(batchUpdateResult, null, 2))
}

/**
 * Delete up to 50 entities and their connected edges in a single call.
 * Atomic: all succeed or all fail.
 *
 * @returns JSON: `{ deleted, edges_removed, count }`.
 * @throws Returns a textError when `node_ids` is missing/non-array, empty,
 *   longer than 50, or any ID does not resolve.
 * @atomicity atomic. Validation pass rejects the entire batch before any
 *   mutation lands.
 * @see delete_node
 */
export const batchDeleteNodes: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const nodeIds = args.node_ids as string[] | undefined
  if (!nodeIds || !Array.isArray(nodeIds)) return textError('Missing required parameter: node_ids (array)')
  if (nodeIds.length === 0) return textError('node_ids array is empty')
  if (nodeIds.length > 50) return textError('Maximum 50 node IDs per batch')

  for (let i = 0; i < nodeIds.length; i++) {
    if (!store.getNode(nodeIds[i])) return textError(`Node at index ${i}: "${nodeIds[i]}" not found`)
  }

  const deleted: Array<{ id: string; title: string }> = []
  let edgesRemoved = 0

  for (const nid of nodeIds) {
    const { node, removedEdgeIds } = store.removeNode(nid)
    deleted.push({ id: node.id, title: node.title })
    edgesRemoved += removedEdgeIds.length
  }

  return text(JSON.stringify({ deleted, edges_removed: edgesRemoved, count: deleted.length }, null, 2))
}

/**
 * Migrate all entities of one type to another, applying registered defaults
 * from `UPG_MIGRATIONS` to migrated nodes. Use for entity-type schema
 * migrations (e.g. `pain_point → need`).
 *
 * **Edge migration is catalog-aware (since v0.2.10).** After node
 * migration completes, every edge in the graph is run through
 * `UPG_EDGE_MIGRATIONS`. Renames retarget the edge to its canonical form;
 * flipped renames swap source/target; drops remove edges that have been
 * retired without replacement. Endpoint guards (`requires_source_type` /
 * `requires_target_type`) check post-migration node types.
 *
 * Edges whose type has no rule in `UPG_EDGE_MIGRATIONS` AND no entry in
 * `UPG_EDGE_CATALOG` are surfaced under `unmapped_legacy_edges` rather
 * than silently substring-substituted (which is what v0.2.0–v0.2.9 did).
 * The caller can decide whether to leave them, hand-migrate via
 * `rename_edge_type`, or escalate.
 *
 * @returns JSON: `{ migrated_nodes, migrated_edges, edge_renames,
 *   dropped_edges, unmapped_legacy_edges, defaults_applied, dry_run }`.
 *   `edge_renames` is `[{ id, from, to, flipped }]`; `dropped_edges` is
 *   `[{ id, from }]`; `unmapped_legacy_edges` is `[{ type, count }]`.
 *   `migrated_edges` is the total mutated count (renames + drops).
 * @throws Returns a textError when `from_type` or `to_type` is missing.
 * @atomicity atomic. Single store-level migration call commits or fails as
 *   one mutation. Note: full graph canonicalisation runs as a side-effect of
 *   any node-type migration, so unrelated legacy edges may also be retargeted.
 * @see rename_edge_type
 * @see export_edges
 * @see update_node
 */
export const migrateType: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const fromType = args.from_type as string | undefined
  const toType = args.to_type as string | undefined
  if (!fromType) return textError('Missing required parameter: from_type')
  if (!toType) return textError('Missing required parameter: to_type')

  const dryRun = (args.dry_run as boolean) ?? false
  const force = (args.force as boolean) ?? false

  // Strict-by-default: refuse pairs without a registered UPG_MIGRATIONS rule
  // unless the caller explicitly opts in. F6 (2026-05-20). Without a
  // registered rule there are no defaults to apply and no semantic substrate
  // for the migration.
  let registeredRule: { from: string; to: string; defaults?: Record<string, unknown>; reason: string } | undefined
  const availableFromThisFrom: string[] = []
  for (const migrations of Object.values(UPG_MIGRATIONS)) {
    for (const m of migrations) {
      if (m.from === fromType) {
        availableFromThisFrom.push(m.to)
        if (m.to === toType) {
          registeredRule = m
        }
      }
    }
  }

  if (!registeredRule && !force) {
    const availableHint =
      availableFromThisFrom.length > 0
        ? ` Available migrations from "${fromType}": [${[...new Set(availableFromThisFrom)].join(', ')}].`
        : ` No migration rules registered from "${fromType}".`
    return textError(
      `No UPG_MIGRATIONS rule for (${fromType} → ${toType}).` +
      availableHint +
      ` Refusing by default to prevent semantic-nonsense type rewrites. ` +
      `Pass \`force: true\` to override; be aware that all type-specific properties will be carried verbatim and may not match the new type's schema.`,
    )
  }

  const defaults = registeredRule?.defaults && Object.keys(registeredRule.defaults).length > 0
    ? registeredRule.defaults
    : undefined

  const allNodes = store.getAllNodes()
  const allEdges = store.getAllEdges()
  const matchingNodes = allNodes.filter((n) => n.type === fromType)

  // Compute unmapped_legacy_edges: types in the graph that are NOT in
  // UPG_EDGE_CATALOG AND would not be migrated (no rule fires under
  // post-node-migration endpoint context).
  const canonicalEdgeKeys = new Set(Object.keys(UPG_EDGE_CATALOG))
  const unmappedCounts: Record<string, number> = {}

  if (dryRun) {
    const plannedRenames: Array<{ id: string; from: string; to: string; flipped: boolean }> = []
    const plannedDrops: Array<{ id: string; from: string }> = []
    for (const edge of allEdges) {
      const sourceNode = store.getNode(edge.source)
      const targetNode = store.getNode(edge.target)
      // Simulate post-node-migration endpoint types
      const sourceType =
        sourceNode?.type === fromType ? toType : (sourceNode?.type as string | undefined)
      const targetType =
        targetNode?.type === fromType ? toType : (targetNode?.type as string | undefined)
      const result = migrateEdge(edge, '0.0.0', UPG_VERSION, { sourceType, targetType })
      if (result === null) {
        plannedDrops.push({ id: edge.id, from: edge.type })
      } else if (result !== edge) {
        const flipped = result.source !== edge.source
        plannedRenames.push({
          id: edge.id,
          from: edge.type,
          to: result.type,
          flipped,
        })
      } else if (!canonicalEdgeKeys.has(edge.type)) {
        unmappedCounts[edge.type] = (unmappedCounts[edge.type] ?? 0) + 1
      }
    }
    const unmappedLegacyEdges = Object.entries(unmappedCounts).map(([type, count]) => ({
      type,
      count,
    }))
    const dryResponse: MigrateTypeResult = {
      migrated_nodes: matchingNodes.length,
      migrated_edges: plannedRenames.length + plannedDrops.length,
      edge_renames: plannedRenames,
      dropped_edges: plannedDrops,
      unmapped_legacy_edges: unmappedLegacyEdges,
      defaults_applied: defaults ?? null,
      dry_run: true,
    }
    return text(JSON.stringify(dryResponse, null, 2))
  }

  const result = store.migrateType(fromType, toType, defaults)

  // Re-scan post-migration edges for unmapped legacy types
  for (const edge of store.getAllEdges()) {
    if (!canonicalEdgeKeys.has(edge.type)) {
      unmappedCounts[edge.type] = (unmappedCounts[edge.type] ?? 0) + 1
    }
  }
  const unmappedLegacyEdges = Object.entries(unmappedCounts).map(([type, count]) => ({
    type,
    count,
  }))

  const applyResponse: MigrateTypeResult = {
    migrated_nodes: result.migratedNodes,
    migrated_edges: result.edgeRenames.length + result.edgeDrops.length,
    edge_renames: result.edgeRenames,
    dropped_edges: result.edgeDrops,
    unmapped_legacy_edges: unmappedLegacyEdges,
    defaults_applied: defaults ?? null,
    dry_run: false,
  }
  return text(JSON.stringify(applyResponse, null, 2))
}

/**
 * Walk every node and apply `UPG_PROPERTY_MIGRATIONS` (renames, lifts, drops,
 * value remaps, and number-to-assessment reshapes). Skips entity-type renames
 * and edge changes. Use `dry_run: true` (default) to preview. Pass
 * `dry_run: false` to commit. Value-aware rules (`remap_property_value`,
 * `reshape_value_to_assessment`) heal the enum and shape tightenings that
 * `validate_graph` property_drift now flags.
 *
 * @returns JSON: `{ top_level_renames, lifted_properties, dropped_props,
 *   dropped_self_referential, dry_run }`.
 * @atomicity non-atomic. Mutations are applied node-by-node; a mid-flight
 *   error may leave the graph partially migrated.
 * @warning Default is `dry_run: true`. Pass `dry_run: false` to commit.
 *   Re-running with `dry_run: true` after a successful commit reports zero
 *   changes (idempotent on the canonical-properties shape).
 * @see migrate_type
 * @see validate_graph
 * @see list_type_migrations
 */
export const migrateProperties: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const dryRun = (args.dry_run as boolean) ?? true

  if (dryRun) {
    const top_level_renames: Array<{ id: string; from: string; to: string; value_changed: boolean }> = []
    const lifted_properties: Array<{ id: string; from_property: string; to: string; value_changed: boolean }> = []
    const dropped_props: Array<{ id: string; key: string }> = []
    const dropped_self_referential: Array<{ id: string; field: string }> = []

    for (const node of store.getAllNodes()) {
      const { changes } = migrateNodeProperties(
        node as unknown as Record<string, unknown> & { id?: string; type: string; properties?: Record<string, unknown> },
        '0.0.0',
        UPG_VERSION,
      )
      for (const change of changes as UPGPropertyMigrationChange[]) {
        switch (change.kind) {
          case 'dropped': dropped_props.push({ id: node.id, key: change.key }); break
          case 'renamed_top_level': top_level_renames.push({ id: node.id, from: change.from, to: change.to, value_changed: change.value_changed }); break
          case 'lifted_to_top_level': lifted_properties.push({ id: node.id, from_property: change.from_property, to: change.to, value_changed: change.value_changed }); break
          case 'self_ref_dropped': dropped_self_referential.push({ id: node.id, field: change.field }); break
        }
      }
    }
    return text(JSON.stringify({ top_level_renames, lifted_properties, dropped_props, dropped_self_referential, dry_run: true }, null, 2))
  }

  const result = store.applyPropertyMigrations('0.0.0', UPG_VERSION)
  return text(JSON.stringify({ ...result, dry_run: false }, null, 2))
}

/**
 * Apply `UPG_SCALAR_TO_EDGE_MIGRATIONS` graph-wide (P14 conformance): promote
 * scalar properties that name a first-class entity into canonical edges. For
 * each rule, find-or-create the referenced entity by normalized title, link it
 * with the canonical edge, and drop the now-redundant scalar (unless the rule
 * keeps it as an actor display-cache). Lossless — the string's value becomes a
 * real node. Idempotent — re-running mints/links nothing new. Snapshot the .upg
 * first (reversible-by-snapshot).
 *
 * Default `dry_run=true` previews the per-rule plan (minted / linked / dropped /
 * skipped); pass `dry_run=false` to commit.
 *
 * @returns JSON: the `ApplyScalarToEdgeResult` plus `dry_run`.
 * @atomicity atomic per call (one save)
 * @see list_scalar_to_edge_migrations
 * @see migrate_properties
 */
export const promoteScalarsToEdges: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const dryRun = (args.dry_run as boolean) ?? true
  const result = applyScalarToEdgeMigrations(store, '0.0.0', UPG_VERSION, { dryRun })
  return text(JSON.stringify({ ...result, dry_run: dryRun }, null, 2))
}

/** Normalise a title to comparable lowercase word tokens (0.17.2, similar dedup).
 *  Keeps `%` so "reuse rate %" and "reuse %" share a token; drops other punctuation. */
function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9%]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0),
  )
}

/** Jaccard overlap of two token sets: |A∩B| / |A∪B|. Two empty sets score 0. */
function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/** A node's containment "area" scope: the sources of its incoming hierarchy
 *  (containment) edges. Two metrics under the same outcome / area / product share
 *  a scope. Used to keep the same-statistical_function rule from clumping every
 *  "rate" metric in the graph together. */
function scopeOf(store: ToolContext['store'], nodeId: string): Set<string> {
  const out = new Set<string>()
  for (const e of store.getEdgesForNode(nodeId)) {
    if (e.target !== nodeId) continue
    if (UPG_EDGE_CATALOG[e.type]?.classification === 'hierarchy') out.add(e.source)
  }
  return out
}

const statFn = (n: UPGBaseNode): string | undefined => {
  const v = (n.properties as Record<string, unknown> | undefined)?.statistical_function
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Read-only near-duplicate detection (0.17.2, brief item G). Surfaces candidate
 *  merges that exact title matching misses, without ever mutating: same-type
 *  entities whose titles are fuzzy-similar, plus metrics that share a
 *  statistical_function and an area with some title overlap. Returns grouped
 *  candidates for human review; the caller aligns and merges by hand. */
function suggestSimilar(
  store: ToolContext['store'],
  nodes: UPGBaseNode[],
  threshold: number,
): ToolResult {
  // Bucket by type first: only ever compare like with like, which also bounds the
  // pairwise scan to within-type sets.
  const byType = new Map<string, UPGBaseNode[]>()
  for (const n of nodes) {
    const arr = byType.get(n.type) ?? []
    arr.push(n)
    byType.set(n.type, arr)
  }

  // Union-find over candidate pairs so transitive near-duplicates land in one group.
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const union = (a: string, b: string) => {
    parent.set(a, parent.get(a) ?? a)
    parent.set(b, parent.get(b) ?? b)
    parent.set(find(a), find(b))
  }
  const pairReason = new Map<string, { reason: string; similarity: number; shared_scope: boolean }>()
  const reasonKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

  for (const group of byType.values()) {
    if (group.length < 2) continue
    const tokens = new Map<string, Set<string>>()
    for (const n of group) tokens.set(n.id, titleTokens(n.title))
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j]
        // Skip exact-title pairs; those are deduplicate_nodes' "exact" job.
        if (a.title.toLowerCase().trim() === b.title.toLowerCase().trim()) continue
        const jac = tokenJaccard(tokens.get(a.id)!, tokens.get(b.id)!)
        const sameFn = a.type === 'metric' && statFn(a) !== undefined && statFn(a) === statFn(b)
        const sharedScope = (() => {
          const sa = scopeOf(store, a.id), sb = scopeOf(store, b.id)
          for (const s of sa) if (sb.has(s)) return true
          return false
        })()
        // Fuzzy title (any type), or a metric sharing a statistical_function with
        // a real title overlap (avoids grouping unrelated same-function metrics).
        const titleMatch = jac >= threshold
        const fnMatch = sameFn && jac >= 0.34
        if (!titleMatch && !fnMatch) continue
        const reason = titleMatch
          ? 'similar_title'
          : sharedScope ? 'same_statistical_function_and_area' : 'same_statistical_function'
        union(a.id, b.id)
        pairReason.set(reasonKey(a.id, b.id), { reason, similarity: Math.round(jac * 100) / 100, shared_scope: sharedScope })
      }
    }
  }

  // Assemble groups from the union-find roots.
  const byRoot = new Map<string, UPGBaseNode[]>()
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  for (const id of parent.keys()) {
    const root = find(id)
    const arr = byRoot.get(root) ?? []
    const n = nodeById.get(id)
    if (n) arr.push(n)
    byRoot.set(root, arr)
  }

  const candidates = [...byRoot.values()]
    .filter((g) => g.length >= 2)
    .map((g) => {
      // Best (max) pairwise similarity and a representative reason for the group.
      let similarity = 0
      let reason = 'similar_title'
      let sharedScope = false
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          const pr = pairReason.get(reasonKey(g[i].id, g[j].id))
          if (!pr) continue
          if (pr.similarity > similarity) similarity = pr.similarity
          if (pr.reason !== 'similar_title') reason = pr.reason
          if (pr.shared_scope) sharedScope = true
        }
      }
      const fn = g[0].type === 'metric' ? statFn(g[0]) : undefined
      return {
        type: g[0].type,
        reason,
        similarity,
        shared_scope: sharedScope,
        ...(fn ? { statistical_function: fn } : {}),
        members: g.map((n) => ({
          id: n.id,
          title: n.title,
          ...(n.type === 'metric' && statFn(n) ? { statistical_function: statFn(n) } : {}),
        })),
      }
    })
    .sort((a, b) => b.similarity - a.similarity)

  return text(
    JSON.stringify(
      {
        match: 'similar',
        dry_run: true,
        similar_candidates: candidates,
        total_groups: candidates.length,
        message:
          candidates.length === 0
            ? 'No near-duplicate candidates found.'
            : `Found ${candidates.length} near-duplicate candidate group(s). These are advisory only and were NOT merged. Review each, then align by hand: rename the survivors and run deduplicate_nodes with match: "exact", or merge with update_node / batch_delete_nodes.`,
      },
      null,
      2,
    ),
  )
}

/**
 * Find and resolve duplicate entities (same title + type, case-insensitive).
 * Returns groups of duplicates. Use `dry_run` to preview, or pass
 * `dry_run: false` to keep one per group and redirect the others' edges to
 * the keeper. `keep` selects `"newest"` (default) or `"oldest"`.
 *
 * `match: "similar"` switches to a read-only near-duplicate suggestion pass
 * (fuzzy title, or metrics sharing a statistical_function and area); it never
 * merges. See `suggestSimilar`.
 *
 * @returns JSON: with `dry_run: true`, `{ duplicates, total_groups,
 *   total_duplicate_nodes, dry_run, message }`. With `dry_run: false`,
 *   `{ merged: true, groups_merged, nodes_removed, edges_redirected,
 *   strategy }`.
 * @throws Returns a textError when `keep` is provided but is not
 *   `"newest"` or `"oldest"`.
 * @atomicity non-atomic. Merges are applied group-by-group; a mid-flight
 *   error leaves earlier groups merged.
 * @warning Default is `dry_run: true`. Pass `dry_run: false` to commit.
 *   Idempotent on retry: a second `dry_run: false` against an
 *   already-deduplicated graph reports zero merges.
 * @see search_nodes
 * @see list_nodes
 * @see batch_delete_nodes
 * @see validate_graph
 */
export const deduplicateNodes: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const filterType = args.type as string | undefined
  const dryRun = (args.dry_run as boolean) ?? true
  const keepStrategy = (args.keep as string) ?? 'newest'
  const match = (args.match as string) ?? 'exact'
  if (match !== 'exact' && match !== 'similar') {
    return textError(`Invalid match: "${match}". Valid: "exact" (default) or "similar".`)
  }

  let nodes = store.getAllNodes()
  if (filterType) nodes = nodes.filter((n) => n.type === filterType)

  // Read-only near-duplicate suggestion pass (0.17.2, brief item G). Never mutates,
  // regardless of dry_run; surfaces fuzzy-title / same-statistical_function candidates.
  if (match === 'similar') {
    const rawThreshold = args.similarity_threshold
    const threshold = typeof rawThreshold === 'number' ? rawThreshold : 0.6
    if (threshold < 0 || threshold > 1) {
      return textError(`Invalid similarity_threshold: ${threshold}. Must be between 0 and 1.`)
    }
    return suggestSimilar(store, nodes, threshold)
  }

  const groups = new Map<string, UPGBaseNode[]>()
  for (const n of nodes) {
    const key = `${n.type}::${n.title.toLowerCase().trim()}`
    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
    }
    group.push(n)
  }

  const duplicates: Array<{ title: string; type: string; count: number; ids: string[] }> = []
  for (const [, group] of groups) {
    if (group.length < 2) continue
    duplicates.push({
      title: group[0].title,
      type: group[0].type,
      count: group.length,
      ids: group.map((n) => n.id),
    })
  }

  if (duplicates.length === 0) {
    return text(JSON.stringify({ duplicates: [], message: 'No duplicate entities found.' }, null, 2))
  }

  if (dryRun) {
    return text(
      JSON.stringify(
        {
          duplicates,
          total_groups: duplicates.length,
          total_duplicate_nodes: duplicates.reduce((sum, d) => sum + d.count - 1, 0),
          dry_run: true,
          message: `Found ${duplicates.length} groups of duplicates. Set dry_run: false to merge.`,
        },
        null,
        2,
      ),
    )
  }

  let nodesRemoved = 0
  let edgesRedirected = 0
  let edgesDropped = 0
  const structuralWarnings: string[] = []

  // Keeper selection by provenance timestamp (mirrors the SDK ordering ladder:
  // properties.created_at / created / node.created_at). The old code used a
  // constant comparator that did not actually sort by age.
  const createdAt = (n: UPGBaseNode): number => {
    const props = (n.properties ?? {}) as Record<string, unknown>
    const raw = props.created_at ?? props.created ?? (n as { created_at?: unknown }).created_at
    const t = typeof raw === 'string' ? Date.parse(raw) : NaN
    return Number.isNaN(t) ? 0 : t
  }

  for (const group of duplicates) {
    const inGroup = store.getAllNodes().filter((n) => group.ids.includes(n.id))
    inGroup.sort((a, b) => {
      const d = keepStrategy === 'oldest' ? createdAt(a) - createdAt(b) : createdAt(b) - createdAt(a)
      return d !== 0 ? d : a.id.localeCompare(b.id)
    })

    const keeper = inGroup[0]
    const removeIds = new Set(inGroup.slice(1).map((n) => n.id))
    if (removeIds.size === 0) continue
    const groupIds = new Set<string>([keeper.id, ...removeIds])

    // The external inbound (parent) edges the GROUP had — the structural edges
    // that MUST survive on the keeper. The previous bug dropped these (a
    // best-effort redirect + cascading removeNode), orphaning the kept node
    // from its parent so it vanished from the tree. We assert they survive.
    const expectedInbound = new Set<string>()
    for (const nid of groupIds) {
      for (const e of store.getEdgesForNode(nid)) {
        if (e.target === nid && !groupIds.has(e.source)) expectedInbound.add(`${e.source}|${e.type}`)
      }
    }

    // Re-home EVERY removed node's edges (inbound + outbound) onto the keeper
    // BEFORE removing any node, so removeNode's cascade can't drop a structural
    // edge the keeper needs. Both endpoints route through the group map, so an
    // intra-group edge collapses to a self-loop and is dropped. addEdge unions
    // an identical (source, target, type) onto the existing edge, so
    // duplicates merge rather than multiply.
    for (const dupId of removeIds) {
      for (const edge of store.getEdgesForNode(dupId)) {
        const source = removeIds.has(edge.source) ? keeper.id : edge.source
        const target = removeIds.has(edge.target) ? keeper.id : edge.target
        if (source === target) continue // self-loop (intra-group or self-edge)
        try {
          store.addEdge({ id: edgeId(), source, target, type: edge.type })
          edgesRedirected++
        } catch {
          // An endpoint no longer resolves; count it rather than hide it.
          edgesDropped++
        }
      }
    }
    for (const dupId of removeIds) {
      store.removeNode(dupId)
      nodesRemoved++
    }

    // Structural-parent guarantee: every external inbound edge the group had
    // must now be on the keeper. Surface any that are not (should be none).
    const keeperInbound = new Set(
      store.getEdgesForNode(keeper.id)
        .filter((e) => e.target === keeper.id)
        .map((e) => `${e.source}|${e.type}`),
    )
    for (const sig of expectedInbound) {
      if (!keeperInbound.has(sig)) {
        const [src, type] = sig.split('|')
        structuralWarnings.push(`"${keeper.title}" (${keeper.type}): inbound ${type} from ${src} was not preserved`)
      }
    }
  }

  const payload: Record<string, unknown> = {
    merged: true,
    groups_merged: duplicates.length,
    nodes_removed: nodesRemoved,
    edges_redirected: edgesRedirected,
    strategy: keepStrategy,
  }
  if (edgesDropped > 0) payload.edges_dropped = edgesDropped
  if (structuralWarnings.length > 0) payload.structural_warnings = structuralWarnings

  return text(JSON.stringify(payload, null, 2))
}

export type { ToolContext }

/**
 * A3 (0.9.14): when a `parent_id` is supplied but the (parent_type -> child_type)
 * pair has no canonical containment edge, the create path still resolves a lateral
 * edge via the pair map and writes it silently. Return a warning (never a refusal)
 * so the author can decide nest-vs-link. Returns undefined when the parent IS a
 * valid containment parent or when no parent edge was created.
 */
function lateralParentWarning(
  store: { getNode: (id: string) => { type?: string } | undefined },
  parentId: string | undefined,
  result: unknown,
): string | undefined {
  if (!parentId) return undefined
  const childType = (result as { node?: { type?: string } }).node?.type
  const parentType = store.getNode(parentId)?.type
  if (!parentType || !childType) return undefined
  if (resolveContainmentEdge(parentType, childType)) return undefined // genuine containment nesting
  // Non-containment parent: either a silent lateral edge resolved, OR the node
  // orphaned (no edge) while parent_id suppressed the orphan hint. Both are
  // "parent_id did not nest as expected" and were silent before; warn either way.
  const edge = (result as { edge?: { type?: string } }).edge
  const outcome = edge?.type ? `a lateral edge ("${edge.type}")` : 'no parent edge (the node is orphaned)'
  return (
    `parent_id "${parentId}" (${parentType}) is not a containment parent of ${childType}: ` +
    `it produced ${outcome}, not nesting. Use create_edge to link laterally, or pass a valid containment parent to nest.`
  )
}

/**
 * A3 (0.9.14), batch form: scan each batch node's `parent_id` / `parent_ref` and
 * warn when the parent type is not a containment parent of the child type (the
 * parent would resolve to a lateral edge, not nesting). Computed from inputs +
 * types, so it fires on `validate_only` too. `parent_ref` "$N" resolves against
 * the same batch's node N; a bare id resolves against the live store.
 */
function batchLateralParentWarnings(
  store: { getNode: (id: string) => { type?: string } | undefined },
  nodes: Array<Record<string, unknown>>,
): string[] {
  const typeOfRef = (ref: string): string | undefined => {
    const m = /^\$(\d+)$/.exec(ref)
    if (m) return nodes[Number(m[1])]?.type as string | undefined
    return store.getNode(ref)?.type
  }
  const warnings: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    const childType = n.type as string | undefined
    const parentRef = (n.parent_id ?? n.parent_ref) as string | undefined
    if (!childType || !parentRef) continue
    const parentType = typeOfRef(parentRef)
    if (!parentType || resolveContainmentEdge(parentType, childType)) continue
    warnings.push(
      `nodes[${i}] (${childType}): parent "${parentRef}" (${parentType}) is not a containment parent of ${childType}; ` +
        `parent_id will not nest it (it resolves to a lateral edge, or no edge at all). ` +
        `Use an explicit edge to link, or a valid containment parent to nest.`,
    )
  }
  return warnings
}
