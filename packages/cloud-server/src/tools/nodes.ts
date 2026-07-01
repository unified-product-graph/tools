/**
 * Node CRUD and read handlers. Every tool scopes to a single product
 * via `product_id` and routes through `PgStore`.
 */

import type { UPGBaseNode, UPGEntityType } from '@unified-product-graph/core'
import { getLifecycleForType, resolveEntityType, UnknownEntityTypeError } from '@unified-product-graph/core'
import { type ToolHandler, text, textError } from '../lib/server-context.js'
import {
  inferEdgeTypeWithTier,
  checkPropertyTypes,
  checkLengthCaps,
  renderPropertyTypeWarning,
} from '@unified-product-graph/sdk/logic'
import { nodeId, edgeId } from '../id-helpers.js'

// ── Pagination helpers (mirrored from spec.ts) ──────────────────────────────

const LIST_NODES_DEFAULT_LIMIT = 1000
const LIST_NODES_MAX_LIMIT = 10000

const EXPORT_DOC_DEFAULT_LIMIT = 1000
const EXPORT_DOC_MAX_LIMIT = 10000

function clampLimit(raw: unknown, def: number, max: number): number {
  const n = typeof raw === 'number' ? raw : def
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.floor(n), max)
}

/** Decode opaque base64 cursor `offset:N` into a numeric offset. Returns 0 on bad input. */
function decodeCursor(raw: unknown): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8')
    const m = decoded.match(/^offset:(\d+)$/)
    if (!m) return 0
    return Number.parseInt(m[1], 10)
  } catch {
    return 0
  }
}

/** Encode a numeric offset into the opaque base64 cursor `offset:N`. */
function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf-8').toString('base64')
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * Page through entities in a product, optionally filtered by type. Returns
 * a slim row shape (id, type, title, status, tags); for the full node plus
 * edges, follow up with `get_node` or `get_nodes`.
 *
 * Supports cursor-based pagination for large products. Pass `next_cursor`
 * from a previous response as `cursor` to advance to the next page.
 * Legacy `offset` parameter is still honoured when `cursor` is absent.
 *
 * @returns JSON: `{ nodes, total, limit, next_cursor? }`. `next_cursor` is
 *   present when more results remain. `total` reflects the filtered count
 *   before pagination.
 * @throws textError when `product_id` is missing.
 * @atomicity atomic (read-only)
 * @warning RLS-bounded: only nodes in products the caller has read access
 *   to are returned. An empty list can mean "no nodes" or "no access".
 *   Default `limit: 1000`, max 10000. For products with 1000+ nodes use
 *   `cursor` pagination: keep calling with the returned `next_cursor` until
 *   it is absent.
 * @see get_node
 * @see get_nodes
 * @see search_nodes
 * @see query
 */
export const listNodes: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  const productId = args.product_id as string
  const filterType = args.type as string | undefined
  const limit = clampLimit(args.limit, LIST_NODES_DEFAULT_LIMIT, LIST_NODES_MAX_LIMIT)

  // Cursor takes precedence over legacy offset param
  const cursorOffset = args.cursor !== undefined
    ? decodeCursor(args.cursor)
    : ((args.offset as number) ?? 0)

  let nodes = await store.getAllNodes(productId)
  if (filterType) nodes = nodes.filter((n) => n.type === filterType)

  const total = nodes.length
  const slice = nodes.slice(cursorOffset, cursorOffset + limit)
  const nextOffset = cursorOffset + slice.length
  const nextCursor = nextOffset < total ? encodeCursor(nextOffset) : undefined

  const page = slice.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    status: n.status,
    tags: n.tags,
  }))

  const body: Record<string, unknown> = { nodes: page, total, limit }
  if (nextCursor) body.next_cursor = nextCursor

  return text(JSON.stringify(body, null, 2))
}

/**
 * Export the full product graph as a UPG document: product metadata,
 * nodes, and edges, suitable for sync, backup, or import into a local
 * .upg file. Used by the `upg pull` CLI command and `apply_pull_changeset`
 * in the local MCP server.
 *
 * Supports cursor-based pagination for large products. Pass `next_cursor`
 * from a previous response as `cursor` to advance to the next page of nodes.
 * All edges are returned regardless of pagination (edges are typically far
 * fewer than nodes and safe to return in full).
 *
 * @returns JSON: `{ product, nodes, edges, total_nodes, limit, next_cursor? }`.
 *   `next_cursor` is present when more node pages remain.
 * @throws textError when `product_id` is missing or the product is
 *   not visible to the caller.
 * @atomicity atomic (read-only)
 * @warning For very large products (10 000+ nodes) iterate via `cursor`
 *   plus `next_cursor` rather than relying on a single call. Every page
 *   returns the full edge set, so deduplicate on the client when
 *   assembling multiple pages.
 * @see apply_pull_changeset
 * @see get_product_graph
 * @see list_nodes
 */
export const exportUpgDocument: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  const productId = args.product_id as string
  const product = await store.getProduct(productId)
  if (!product) return textError(`Product not found: ${productId}`)

  const limit = clampLimit(args.limit, EXPORT_DOC_DEFAULT_LIMIT, EXPORT_DOC_MAX_LIMIT)
  const cursorOffset = decodeCursor(args.cursor)

  const allNodes = await store.getAllNodes(productId)
  const edges = await store.getAllEdges(productId)

  const totalNodes = allNodes.length
  const nodeSlice = allNodes.slice(cursorOffset, cursorOffset + limit)
  const nextOffset = cursorOffset + nodeSlice.length
  const nextCursor = nextOffset < totalNodes ? encodeCursor(nextOffset) : undefined

  const body: Record<string, unknown> = {
    product,
    nodes: nodeSlice,
    edges,
    total_nodes: totalNodes,
    limit,
  }
  if (nextCursor) body.next_cursor = nextCursor

  return text(JSON.stringify(body, null, 2))
}

/**
 * Read one node with full properties and every connected edge, separated
 * into `edges_out` and `edges_in`. Edge entries carry the neighbour node's
 * title for a single-call human-readable view.
 *
 * @returns JSON: `{ node, edges_out, edges_in }`. Errors with
 * `Node not found: <id>` for unknown ids.
 * @throws textError when `node_id` is missing or the node does
 *   not exist (or the caller has no access; RLS shares the same shape for
 *   both).
 * @atomicity atomic (read-only)
 * @see list_nodes
 * @see get_nodes
 * @see search_nodes
 * @see query
 */
export const getNode: ToolHandler = async (args, { store }) => {
  if (!args.node_id) return textError(`Missing required parameter: node_id`)
  const nid = args.node_id as string
  const node = await store.getNode(nid)
  if (!node) return textError(`Node not found: ${nid}`)

  const edges = await store.getEdgesForNode(nid)
  const edgesOut = []
  const edgesIn = []

  for (const e of edges) {
    if (e.source === nid) {
      const targetNode = await store.getNode(e.target)
      edgesOut.push({ ...e, target_title: targetNode?.title ?? '(unknown)' })
    }
    if (e.target === nid) {
      const sourceNode = await store.getNode(e.source)
      edgesIn.push({ ...e, source_title: sourceNode?.title ?? '(unknown)' })
    }
  }

  return text(JSON.stringify({ node, edges_out: edgesOut, edges_in: edgesIn }, null, 2))
}

/**
 * Batch-read up to 50 nodes by id, each with their incident edges. Pass
 * `compact_edges: true` to drop neighbour-title hydration for a leaner
 * payload (id/type/source/target only).
 *
 * @returns JSON: `{ nodes, total, not_found? }`. `not_found` lists any
 * requested ids that did not resolve and appears only when at least one
 * miss occurred.
 * @throws textError when `product_id` or `ids` is missing/empty,
 *   or when `ids` exceeds 50.
 * @atomicity atomic (read-only)
 * @warning `not_found` shares the same shape for "node doesn't exist" and
 *   "node exists but caller lacks access" (RLS treats them alike). Pass
 *   `compact_edges: true` to drop neighbour-title hydration on edge-heavy
 *   nodes (~30% smaller wire payload).
 * @see get_node
 * @see list_nodes
 * @see query
 */
export const getNodes: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const ids = args.ids as string[] | undefined
  if (!ids || ids.length === 0) return textError('Missing required parameter: ids')
  if (ids.length > 50) return textError('Maximum 50 IDs per batch')

  const productId = args.product_id as string
  const compact = (args.compact_edges as boolean) ?? false
  const allNodes = await store.getAllNodes(productId)
  const allEdges = await store.getAllEdges(productId)
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]))

  const results: Array<Record<string, unknown>> = []
  const notFound: string[] = []

  for (const id of ids) {
    const node = nodeMap.get(id)
    if (!node) { notFound.push(id); continue }
    const edgesOut = allEdges.filter((e) => e.source === id)
    const edgesIn = allEdges.filter((e) => e.target === id)
    results.push({
      node,
      edges_out: compact
        ? edgesOut.map((e) => ({ id: e.id, type: e.type, source: e.source, target: e.target }))
        : edgesOut.map((e) => ({ ...e, target_title: nodeMap.get(e.target)?.title ?? '(unknown)' })),
      edges_in: compact
        ? edgesIn.map((e) => ({ id: e.id, type: e.type, source: e.source, target: e.target }))
        : edgesIn.map((e) => ({ ...e, source_title: nodeMap.get(e.source)?.title ?? '(unknown)' })),
    })
  }

  const resp: Record<string, unknown> = { nodes: results, total: results.length }
  if (notFound.length > 0) resp.not_found = notFound
  return text(JSON.stringify(resp, null, 2))
}

/**
 * Substring search over node titles plus descriptions. Title hits score 2,
 * description hits score 1, results sorted by score then truncated to
 * `limit` (default 20, max 100).
 *
 * @returns JSON: `{ results: Array<node & { match_field }>, total }`.
 * @throws textError when `product_id` or `query` is missing.
 * @atomicity atomic (read-only)
 * @warning RLS-bounded: only nodes in products the caller has read
 *   access to participate. Substring match is case-insensitive and runs
 *   in-memory after a full product fetch; for very large products this
 *   can be heavy. A Postgres-side full-text index is a future optimisation.
 * @see list_nodes
 * @see get_node
 * @see query
 */
export const searchNodes: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  if (!args.query) return textError(`Missing required parameter: query`)
  const productId = args.product_id as string
  const q = (args.query as string).toLowerCase()
  const filterType = args.type as string | undefined
  const limit = Math.min((args.limit as number) ?? 20, 100)

  let nodes = await store.getAllNodes(productId)
  if (filterType) nodes = nodes.filter((n) => n.type === filterType)

  const scored = nodes
    .map((n) => {
      const titleMatch = n.title.toLowerCase().includes(q)
      const descMatch = n.description?.toLowerCase().includes(q) ?? false
      if (!titleMatch && !descMatch) return null
      return {
        node: n,
        score: titleMatch ? 2 : 1,
        match_field: titleMatch ? 'title' : 'description',
      }
    })
    .filter((s): s is { node: (typeof nodes)[0]; score: number; match_field: string } => s !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return text(JSON.stringify({
    results: scored.map((s) => ({ ...s.node, match_field: s.match_field })),
    total: scored.length,
  }, null, 2))
}

/**
 * Create a new entity, optionally connected to a parent via an inferred
 * edge type. Lifecycle-aware: when `status` is omitted and the type has a
 * registered lifecycle, the initial phase is set automatically. When
 * `status` is provided but doesn't match the lifecycle's phases, the
 * response carries a `warning` (the node is still created).
 *
 * @returns JSON: `{ node, edge?, warning? }`. `edge` is null when no
 * `parent_id` is passed; `warning` is present on lifecycle/parent issues.
 * @throws textError when `product_id`, `type`, or `title` is
 *   missing.
 * @atomicity atomic-with-rollback
 * @warning Pass `parent_id` to auto-create a containment edge with inferred
 *   type; missing parents are reported via `warning` rather than failing
 *   the create.
 * @see batch_create_nodes
 * @see update_node
 * @see get_entity_schema
 * @see list_entity_types
 * @see get_valid_children
 */
export const createNode: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  if (!args.type) return textError(`Missing required parameter: type`)
  if (!args.title) return textError(`Missing required parameter: title`)

  // Entity-type validation: resolve aliases to canonical, refuse uncatalogued
  // types before the write lands. Matches the local MCP server's create_node.
  let resolvedType: ReturnType<typeof resolveEntityType>
  try {
    resolvedType = resolveEntityType(args.type)
  } catch (err) {
    if (err instanceof UnknownEntityTypeError) return textError(err.message)
    throw err
  }
  const canonicalType = resolvedType.canonical

  const productId = args.product_id as string
  const newNode: UPGBaseNode = {
    id: nodeId(),
    type: canonicalType as UPGEntityType,
    title: args.title as string,
  }
  if (args.description) newNode.description = args.description as string
  if (args.tags) newNode.tags = args.tags as string[]
  if (args.properties) newNode.properties = args.properties as Record<string, unknown>

  const nodeType = canonicalType
  const nId = newNode.id
  const properties = newNode.properties

  // Property type validation: refuse declared-but-mismatched-type values
  // before the write lands. Matches the local MCP server's create_node.
  const { violations } = checkPropertyTypes(nodeType, properties)
  if (violations.length > 0) {
    return textError(renderPropertyTypeWarning(nodeType, violations)!)
  }

  // Length caps: soft warnings only, never refusals.
  const { warnings: lengthWarnings } = checkLengthCaps({
    title: args.title as string,
    description: args.description as string | undefined,
    properties,
  })

  const warnings: string[] = [...lengthWarnings]
  if (resolvedType.alias) {
    warnings.push(`Type "${resolvedType.alias.from}" is deprecated; using canonical "${resolvedType.alias.to}".`)
  }
  if (args.status) {
    newNode.status = args.status as string
    const lifecycle = getLifecycleForType(nodeType)
    if (lifecycle) {
      const validPhases = lifecycle.phases.map((p) => p.id)
      if (!validPhases.includes(newNode.status)) {
        warnings.push(`Status "${newNode.status}" is not a valid phase for type "${nodeType}". Valid phases: [${validPhases.join(', ')}]`)
      }
    }
  } else {
    const lifecycle = getLifecycleForType(nodeType)
    if (lifecycle) newNode.status = lifecycle.initial_phase
  }
  await store.addNode(productId, newNode)

  let edge = null
  const parentId = args.parent_id as string | undefined
  if (parentId) {
    const parent = await store.getNode(parentId)
    if (!parent) {
      warnings.push(`Parent node ${parentId} not found. Node created without edge.`)
    } else {
      // Catalog-strict parent-edge inference. Do NOT fabricate a
      // `_contains_` edge: the node still lands, but a non-canonical pair
      // yields a warning so the caller can wire an explicit edge type.
      const inference = inferEdgeTypeWithTier(parent.type, nodeType, { forAutoNest: true })
      if (!inference.ok) {
        const suggestion = inference.suggestions.length > 0
          ? ` Suggestions: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
          : ''
        warnings.push(`Parent edge not created; no canonical edge for ${parent.type} → ${nodeType}.${suggestion}`)
      } else {
        edge = { id: edgeId(), source: parentId, target: nId, type: inference.edgeType }
        await store.addEdge(productId, edge as Parameters<typeof store.addEdge>[1])
      }
    }
  }

  const result: Record<string, unknown> = { node: newNode, edge }
  if (warnings.length > 0) result.warning = warnings.join(' | ')
  return text(JSON.stringify(result, null, 2))
}

/**
 * Merge-update a node's fields. Unspecified fields are preserved.
 * Lifecycle-aware: when `status` changes to a phase not declared in the
 * type's lifecycle, the response carries a `warning` (update still
 * applied).
 *
 * @returns JSON: `{ node: updatedNode, warning? }`. Errors propagate from
 * the store (e.g. unknown node id).
 * @throws textError when `node_id` is missing or the store
 *   rejects the update (unknown id).
 * @atomicity atomic-with-rollback
 * @warning Lifecycle-aware: invalid status values produce a `warning` but
 *   the update still applies. For type changes, use `migrate_type`
 *   instead; direct type mutation via this tool is unsupported.
 * @see migrate_type
 * @see batch_update_nodes
 * @see get_lifecycle
 */
export const updateNode: ToolHandler = async (args, { store }) => {
  if (!args.node_id) return textError(`Missing required parameter: node_id`)
  const nid = args.node_id as string
  const patch: Record<string, unknown> = {}
  if (args.title !== undefined) patch.title = args.title
  if (args.description !== undefined) patch.description = args.description
  if (args.tags !== undefined) patch.tags = args.tags
  if (args.status !== undefined) patch.status = args.status
  if (args.properties !== undefined) patch.properties = args.properties

  const warnings: string[] = []
  // Resolve the entity type once if either a status or property check needs it.
  let entityType: string | undefined
  if (args.status !== undefined || args.properties !== undefined) {
    const existingNode = await store.getNode(nid)
    entityType = existingNode?.type
  }

  if (args.status !== undefined && entityType) {
    const lifecycle = getLifecycleForType(entityType)
    if (lifecycle) {
      const validPhases = lifecycle.phases.map((p) => p.id)
      if (!validPhases.includes(args.status as string)) {
        warnings.push(`Status "${args.status}" is not a valid phase for type "${entityType}". Valid phases: [${validPhases.join(', ')}]`)
      }
    }
  }

  if (args.properties !== undefined && entityType) {
    // Property type validation: refuse declared-but-mismatched-type values.
    const { violations } = checkPropertyTypes(entityType, args.properties as Record<string, unknown>)
    if (violations.length > 0) {
      return textError(renderPropertyTypeWarning(entityType, violations)!)
    }
  }

  // Length caps: soft warnings only, never refusals.
  const { warnings: lengthWarnings } = checkLengthCaps({
    title: args.title as string | undefined,
    description: args.description as string | undefined,
    properties: args.properties as Record<string, unknown> | undefined,
  })
  warnings.push(...lengthWarnings)

  try {
    const updated = await store.updateNode(nid, patch)
    const result: Record<string, unknown> = { node: updated }
    if (warnings.length > 0) result.warning = warnings.join(' | ')
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Delete a node and cascade-delete every connected edge in a single store
 * call. The response surfaces the dropped edge ids so the caller can
 * reconcile any local mirror.
 *
 * @returns JSON: `{ deleted_node_id, deleted_node_title, deleted_edge_ids }`.
 * Errors propagate from the store (e.g. unknown id).
 * @throws textError when `node_id` is missing or the store
 *   rejects the deletion.
 * @atomicity atomic-with-rollback
 * @warning Cascade-deletes ALL incident edges, including cross-product
 *   edges where the node is an endpoint. The operation is permanent (no
 *   soft-delete or undo); the audit log records the removal. Pair with
 *   `get_node` first if you need a snapshot.
 * @see batch_delete_nodes
 * @see get_node
 * @see deduplicate_nodes
 */
export const deleteNode: ToolHandler = async (args, { store }) => {
  if (!args.node_id) return textError(`Missing required parameter: node_id`)
  try {
    const { node, removedEdgeIds } = await store.removeNode(args.node_id as string)
    return text(JSON.stringify({
      deleted_node_id: node.id,
      deleted_node_title: node.title,
      deleted_edge_ids: removedEdgeIds,
    }, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Reparent a node to a new parent within the same product. Removes any
 * existing containment edge where the node is the target, then creates a
 * new edge from `new_parent_id` to `node_id` with an inferred type. All
 * mutations run inside a single Postgres transaction.
 *
 * @returns JSON: `{ node_id, old_parent_id, new_parent_id, edge_created }`.
 *   `old_parent_id` is `null` when the node had no prior containment edge.
 * @throws textError when either node is missing, the nodes belong
 *   to different products (cross-product reparenting is not allowed), or
 *   the caller tries to move a node onto itself.
 * @atomicity atomic-with-rollback
 * @see batch_move_nodes
 * @see resolve_edge_for_pair
 * @see get_valid_children
 */
export const moveNode: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  if (!args.node_id) return textError('Missing required parameter: node_id')
  if (!args.new_parent_id) return textError('Missing required parameter: new_parent_id')

  const productId = args.product_id as string
  const nid = args.node_id as string
  const newParentId = args.new_parent_id as string

  if (nid === newParentId) return textError('Cannot move a node onto itself.')

  // Ownership checks (both nodes must exist and belong to this product)
  const node = await store.getNode(nid)
  if (!node) return textError(`Node not found: ${nid}`)
  if (node.product_id !== productId) return textError(`Node ${nid} does not belong to product ${productId}`)

  const newParent = await store.getNode(newParentId)
  if (!newParent) return textError(`New parent not found: ${newParentId}`)
  if (newParent.product_id !== productId) return textError(`New parent ${newParentId} does not belong to product ${productId}`)

  // Catalog-strict: validate the new containment edge BEFORE any mutation.
  // On a non-canonical pair the graph is left exactly as it started.
  const inference = inferEdgeTypeWithTier(newParent.type, node.type, { forAutoNest: true })
  if (!inference.ok) {
    const suggestion = inference.suggestions.length > 0
      ? ` Suggestions: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
      : ''
    return textError(`No canonical edge type for ${newParent.type} → ${node.type}.${suggestion} Reparenting refused.`)
  }
  const newEdgeId = edgeId()

  try {
    const result = await store.moveNode(productId, nid, newParentId, inference.edgeType, newEdgeId)
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Merge a set of duplicate nodes into a canonical node and delete the
 * duplicates. All edge rebinding, self-loop cleanup, duplicate-edge removal,
 * property merge, and deletion run inside a single Postgres transaction
 * (all-or-nothing). Default `dry_run: true` previews what would change
 * without touching any data.
 *
 * @returns With `dry_run: true` (default): `{ canonical_id, duplicate_ids,
 *   edges_to_rebind, nodes_to_delete, dry_run }`. With `dry_run: false`:
 *   `{ canonical_id, merged_ids, rebound_edges, removed_self_loops,
 *   removed_duplicate_edges, dry_run }`.
 * @throws textError when `product_id`, `canonical_id`, or
 *   `duplicate_ids` are missing, when the arrays exceed limits, when
 *   `canonical_id` appears in `duplicate_ids`, or when any node does not
 *   exist / does not belong to the product.
 * @atomicity atomic-with-rollback (all mutations committed or rolled back
 *   together).
 * @warning Default `dry_run: true`; pass `dry_run: false` to commit. The
 *   merge is permanent: duplicates are deleted, their edges rebound to
 *   the canonical, self-loops removed, and duplicate edges deduplicated.
 *   The change stands once committed (no undo); the audit log records
 *   each merge for the retention window.
 * @see search_nodes
 * @see get_nodes
 * @see delete_node
 * @see validate_graph
 */
export const deduplicateNodes: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  if (!args.canonical_id) return textError('Missing required parameter: canonical_id')
  if (!args.duplicate_ids || !Array.isArray(args.duplicate_ids) || (args.duplicate_ids as string[]).length === 0)
    return textError('Missing required parameter: duplicate_ids (non-empty array)')

  const productId = args.product_id as string
  const canonicalId = args.canonical_id as string
  const duplicateIds = args.duplicate_ids as string[]
  const dryRun = (args.dry_run as boolean) ?? true

  if (duplicateIds.length > 20)
    return textError('Maximum 20 duplicate IDs per call')
  if (duplicateIds.includes(canonicalId))
    return textError('canonical_id must not appear in duplicate_ids')

  // Ownership validation: all nodes must exist and belong to product_id
  const allIds = [canonicalId, ...duplicateIds]
  for (const id of allIds) {
    const node = await store.getNode(id)
    if (!node) return textError(`Node not found: ${id}`)
    if (node.product_id !== productId)
      return textError(`Node ${id} does not belong to product ${productId}`)
  }

  if (dryRun) {
    // Count edges that would be rebound (all edges incident on any duplicate)
    let edgesToRebind = 0
    for (const dupId of duplicateIds) {
      const edges = await store.getEdgesForNode(dupId)
      edgesToRebind += edges.length
    }
    return text(JSON.stringify({
      canonical_id: canonicalId,
      duplicate_ids: duplicateIds,
      edges_to_rebind: edgesToRebind,
      nodes_to_delete: duplicateIds.length,
      dry_run: true,
    }, null, 2))
  }

  // Execute merge in a single Postgres transaction
  const result = await store.deduplicateNodes(productId, canonicalId, duplicateIds)
  return text(JSON.stringify({ ...result, dry_run: false }, null, 2))
}

/**
 * Whole-product graph dump: every node and edge, along with the product
 * row. Cloud-only convenience for full snapshots; expensive on large
 * products. Prefer `query` with a depth limit when you need a slice.
 *
 * @returns JSON: `{ product, nodes, edges }`.
 * @throws textError when `product_id` is missing or the product
 *   is not visible to the caller.
 * @atomicity atomic (read-only)
 * @warning Returns the **entire** graph in one payload; for products
 *   with thousands of nodes/edges this can be tens of MB. Prefer `query`
 *   with a depth limit plus `include` projection for slices, or
 *   `list_nodes` plus cursor pagination for full enumeration without the
 *   wire-size hit.
 * @see query
 * @see list_nodes
 * @see get_graph_digest
 * @see get_graph_analytics
 */
export const getProductGraph: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  const productId = args.product_id as string
  const product = await store.getProduct(productId)
  if (!product) return textError(`Product not found: ${productId}`)

  const nodes = await store.getAllNodes(productId)
  const edges = await store.getAllEdges(productId)

  return text(JSON.stringify({ product, nodes, edges }, null, 2))
}
