/**
 * Atomic batch tools. Six handlers wrap multi-row writes in a single
 * `PoolClient` BEGIN/COMMIT, rolling back on any error.
 *
 * Tools: batch_create_nodes, batch_update_nodes, batch_delete_nodes,
 *        batch_create_edges, batch_delete_edges, batch_move_nodes.
 */

import type { UPGBaseNode, UPGEntityType } from '@unified-product-graph/core'
import { getLifecycleForType, resolveEntityType, UnknownEntityTypeError } from '@unified-product-graph/core'
import { type ToolHandler, text, textError } from '../lib/server-context.js'
import {
  inferEdgeTypeWithTier,
  validateEdgeTypePair,
  checkPropertyTypes,
  checkLengthCaps,
  renderPropertyTypeWarning,
} from '@unified-product-graph/sdk/logic'
import { nodeId, edgeId } from '../id-helpers.js'
import { appendAudit } from '../lib/audit.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Column list kept in sync with `UPGPgStore.NODE_COLS`. */
const NODE_COLS = 'id, product_id, type, title, description, status, tags, data'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToNode(row: any): UPGBaseNode & { product_id: string } {
  const node: UPGBaseNode & { product_id: string } = {
    id: row.id,
    type: row.type,
    title: row.title,
    product_id: row.product_id,
  }
  if (row.description != null) node.description = row.description
  if (row.status != null) node.status = row.status
  if (row.tags != null) node.tags = row.tags
  if (row.data != null) node.properties = row.data
  return node
}

// ─── batch_create_nodes ───────────────────────────────────────────────────────

/**
 * Create up to 50 entities in a single atomic Postgres transaction. For each
 * node with a `parent_id`, a containment edge is created in the same
 * transaction. On any failure the entire batch is rolled back.
 *
 * @returns JSON: `{ created: [{ id, type, title }], count, warnings? }`.
 * @throws textError when `nodes` is missing / non-array, any required field
 *   (`type`, `title`) is absent, or any node carries a declared property whose
 *   value type mismatches the schema (rejects the whole batch before BEGIN).
 * @atomicity atomic-with-rollback (BEGIN / COMMIT / ROLLBACK).
 * @warning Validation runs inline before BEGIN; a single bad item rejects
 *   the entire batch before any database mutation. Parent containment edges
 *   are catalog-strict: a non-canonical parent→child pair skips the edge with
 *   a warning rather than fabricating a `_contains_` edge (matches
 *   `create_node`). A missing parent likewise skips the edge.
 * @see create_node
 * @see batch_create_edges
 * @see batch_update_nodes
 */
export const batchCreateNodes: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const nodes = args.nodes as Array<Record<string, unknown>> | undefined
  if (!nodes || !Array.isArray(nodes)) return textError('Missing required parameter: nodes (array)')
  if (nodes.length === 0) return textError('nodes array is empty')
  if (nodes.length > 50) return textError('Maximum 50 nodes per batch')

  // Validate before touching the database. Property-type violations reject the
  // whole batch before BEGIN, matching the local server's batch_create_nodes.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n.type) return textError(`Node at index ${i}: missing required field "type"`)
    if (!n.title) return textError(`Node at index ${i}: missing required field "title"`)
    try {
      resolveEntityType(n.type)
    } catch (err) {
      if (err instanceof UnknownEntityTypeError) return textError(`Node at index ${i}: ${err.message}`)
      throw err
    }
    if (n.properties !== undefined) {
      const { violations } = checkPropertyTypes(n.type as string, n.properties as Record<string, unknown>)
      if (violations.length > 0) {
        return textError(`Node at index ${i}: ${renderPropertyTypeWarning(n.type as string, violations)!}`)
      }
    }
  }

  const productId = args.product_id as string
  const warnings: string[] = []

  // Access the underlying pool via the store's private field.
  // PgStore exposes pool via the constructor closure; we reach it through
  // the store's pool property which is typed as `private` but accessible
  // at runtime via bracket notation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = (store as any).pool as import('pg').Pool
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const created: Array<{ id: string; type: string; title: string }> = []

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const nodeType = resolveEntityType(n.type).canonical
      const newId = nodeId()

      let status: string | null = null
      if (n.status) {
        status = n.status as string
      } else {
        const lifecycle = getLifecycleForType(nodeType)
        if (lifecycle) status = lifecycle.initial_phase
      }

      await client.query(
        `INSERT INTO upg.nodes (id, product_id, type, title, description, status, tags, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newId,
          productId,
          nodeType,
          n.title as string,
          (n.description as string | undefined) ?? null,
          status,
          (n.tags as string[] | undefined) ?? null,
          n.properties ? JSON.stringify(n.properties) : null,
        ],
      )
      await appendAudit(client, {
        productId, action: 'create', entityType: 'node', entityId: newId,
        changes: { type: nodeType, title: n.title as string },
      })

      // Length-cap soft warnings (per-item, never refusals).
      const { warnings: lengthWarnings } = checkLengthCaps({
        title: n.title as string,
        description: n.description as string | undefined,
        properties: n.properties as Record<string, unknown> | undefined,
      })
      for (const w of lengthWarnings) warnings.push(`Node "${newId}": ${w}`)

      // If a parent_id was supplied, look up the parent and create a
      // catalog-strict containment edge inferred from parent type → new type.
      const parentId = n.parent_id as string | undefined
      if (parentId) {
        const { rows: parentRows } = await client.query(
          `SELECT ${NODE_COLS} FROM upg.nodes WHERE id = $1 AND product_id = $2`,
          [parentId, productId],
        )
        if (parentRows.length > 0) {
          const parentType = parentRows[0].type as string
          // Do NOT fabricate a `_contains_` edge: skip with a warning when the
          // pair has no canonical edge, matching create_node.
          const inference = inferEdgeTypeWithTier(parentType, nodeType)
          if (!inference.ok) {
            warnings.push(`Node "${newId}": parent edge not created; no canonical edge for ${parentType} → ${nodeType}.`)
          } else {
            const eid = edgeId()
            await client.query(
              `INSERT INTO upg.edges (id, product_id, source, target, type)
               VALUES ($1, $2, $3, $4, $5)`,
              [eid, productId, parentId, newId, inference.edgeType],
            )
            await appendAudit(client, {
              productId, action: 'create', entityType: 'edge', entityId: eid,
              changes: { source: parentId, target: newId, type: inference.edgeType },
            })
          }
        } else {
          warnings.push(`Node "${newId}": parent ${parentId} not found. Node created without edge.`)
        }
      }

      created.push({ id: newId, type: nodeType, title: n.title as string })
    }

    await client.query('COMMIT')
    // Emit post-commit. (Auto-created parent containment edges are not emitted
    // individually; the node.created event is the primary signal.)
    for (const c of created) store.emit(productId, 'node.created', { id: c.id, type: c.type, title: c.title })
    const body: Record<string, unknown> = { created, count: created.length }
    if (warnings.length > 0) body.warnings = warnings
    return text(JSON.stringify(body, null, 2))
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── batch_update_nodes ───────────────────────────────────────────────────────

/**
 * Update up to 50 existing entities in a single atomic transaction. Properties
 * are MERGED with existing (not replaced). Unspecified fields are preserved.
 * All node IDs are resolved before the transaction opens; a missing ID rejects
 * the whole batch before any mutation lands.
 *
 * @returns JSON: `{ updated: [id], count }`.
 * @throws textError when `nodes` is missing / non-array / empty / >50, or any
 *   item is missing `id`, or any `id` does not resolve.
 * @atomicity atomic-with-rollback (BEGIN / COMMIT / ROLLBACK).
 * @warning Properties merge with `||`: top-level keys overwrite while nested
 *   keys stay shallow (deep-merge stays out of scope). To clear a property,
 *   pass it as `null`. Items with no setClauses (every field undefined) are
 *   silently skipped.
 * @see update_node
 * @see batch_create_nodes
 * @see migrate_type
 */
export const batchUpdateNodes: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const nodes = args.nodes as Array<Record<string, unknown>> | undefined
  if (!nodes || !Array.isArray(nodes)) return textError('Missing required parameter: nodes (array)')
  if (nodes.length === 0) return textError('nodes array is empty')
  if (nodes.length > 50) return textError('Maximum 50 updates per batch')

  // Pre-validate: all IDs must exist. Property-type violations reject the
  // whole batch before BEGIN, matching the local server's batch_update_nodes.
  // Cache the resolved type so the mutation loop need not re-fetch.
  const typeById = new Map<string, string>()
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n.id) return textError(`Node at index ${i}: missing required field "id"`)
    const existing = await store.getNode(n.id as string)
    if (!existing) return textError(`Node at index ${i}: node "${n.id}" not found`)
    typeById.set(n.id as string, existing.type)
    if (n.properties !== undefined) {
      const { violations } = checkPropertyTypes(existing.type, n.properties as Record<string, unknown>)
      if (violations.length > 0) {
        return textError(`Node at index ${i}: ${renderPropertyTypeWarning(existing.type, violations)!}`)
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = (store as any).pool as import('pg').Pool
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const updated: string[] = []
    const warnings: string[] = []

    for (const n of nodes) {
      const nid = n.id as string
      const setClauses: string[] = []
      const values: unknown[] = []
      let p = 1

      if (n.title !== undefined) { setClauses.push(`title = $${p++}`); values.push(n.title) }
      if (n.description !== undefined) { setClauses.push(`description = $${p++}`); values.push(n.description) }
      if (n.status !== undefined) { setClauses.push(`status = $${p++}`); values.push(n.status) }
      if (n.tags !== undefined) { setClauses.push(`tags = $${p++}`); values.push(n.tags) }
      if (n.properties !== undefined) {
        setClauses.push(`data = COALESCE(data, '{}'::jsonb) || $${p++}::jsonb`)
        values.push(JSON.stringify(n.properties))
      }

      if (setClauses.length > 0) {
        values.push(nid)
        await client.query(
          `UPDATE upg.nodes SET ${setClauses.join(', ')} WHERE id = $${p}`,
          values,
        )
        await appendAudit(client, {
          productId: args.product_id as string,
          action: 'update', entityType: 'node', entityId: nid,
          changes: {
            ...(n.title !== undefined ? { title: n.title } : {}),
            ...(n.description !== undefined ? { description: n.description } : {}),
            ...(n.status !== undefined ? { status: n.status } : {}),
            ...(n.tags !== undefined ? { tags: n.tags } : {}),
            ...(n.properties !== undefined ? { properties: n.properties } : {}),
          },
        })
      }

      // Status lifecycle + length-cap soft warnings (per-item, never refusals).
      if (n.status !== undefined) {
        const entityType = typeById.get(nid)
        if (entityType) {
          const lifecycle = getLifecycleForType(entityType)
          if (lifecycle) {
            const validPhases = lifecycle.phases.map((ph) => ph.id)
            if (!validPhases.includes(n.status as string)) {
              warnings.push(`Node "${nid}": status "${n.status}" is not a valid phase for type "${entityType}". Valid phases: [${validPhases.join(', ')}]`)
            }
          }
        }
      }
      const { warnings: lengthWarnings } = checkLengthCaps({
        title: n.title as string | undefined,
        description: n.description as string | undefined,
        properties: n.properties as Record<string, unknown> | undefined,
      })
      for (const w of lengthWarnings) warnings.push(`Node "${nid}": ${w}`)

      updated.push(nid)
    }

    await client.query('COMMIT')
    for (const nid of updated) store.emit(args.product_id as string, 'node.updated', { id: nid })
    const body: Record<string, unknown> = { updated, count: updated.length }
    if (warnings.length > 0) body.warnings = warnings
    return text(JSON.stringify(body, null, 2))
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── batch_delete_nodes ───────────────────────────────────────────────────────

/**
 * Delete up to 50 entities and all their connected edges in a single atomic
 * transaction. All IDs are resolved before the transaction opens.
 *
 * @returns JSON: `{ deleted: [id], count }`.
 * @throws textError when `node_ids` is missing / non-array / empty / >50, or
 *   any ID does not resolve.
 * @atomicity atomic-with-rollback (BEGIN / COMMIT / ROLLBACK).
 * @warning Cascade-deletes ALL edges incident on each node, in either
 *   direction. Removal is hard; recovery flows through the audit log,
 *   which records each removal for the retention window.
 * @see delete_node
 * @see batch_delete_edges
 * @see deduplicate_nodes
 */
export const batchDeleteNodes: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const nodeIds = args.node_ids as string[] | undefined
  if (!nodeIds || !Array.isArray(nodeIds)) return textError('Missing required parameter: node_ids (array)')
  if (nodeIds.length === 0) return textError('node_ids array is empty')
  if (nodeIds.length > 50) return textError('Maximum 50 node IDs per batch')

  // Pre-validate: all IDs must exist
  for (let i = 0; i < nodeIds.length; i++) {
    const existing = await store.getNode(nodeIds[i])
    if (!existing) return textError(`Node at index ${i}: "${nodeIds[i]}" not found`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = (store as any).pool as import('pg').Pool
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const deleted: string[] = []

    for (const nid of nodeIds) {
      // Cascade-delete connected edges first
      await client.query(
        `DELETE FROM upg.edges WHERE source = $1 OR target = $1`,
        [nid],
      )
      await client.query(`DELETE FROM upg.nodes WHERE id = $1`, [nid])
      await appendAudit(client, {
        productId: args.product_id as string,
        action: 'delete', entityType: 'node', entityId: nid,
      })
      deleted.push(nid)
    }

    await client.query('COMMIT')
    for (const nid of deleted) store.emit(args.product_id as string, 'node.deleted', { id: nid })
    return text(JSON.stringify({ deleted, count: deleted.length }, null, 2))
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── batch_create_edges ───────────────────────────────────────────────────────

/**
 * Create up to 50 edges in a single atomic transaction. Edge type is
 * auto-inferred from source/target node types when omitted.
 *
 * @returns JSON: `{ created: [{ id, source_id, target_id, type }], count }`.
 * @throws textError when `edges` is missing / non-array / empty / >50, any
 *   item is missing `source_id` / `target_id`, any endpoint does not exist, an
 *   explicit `type` violates the catalog's source/target pair, or an inferred
 *   pair has no canonical edge. Any such failure rejects the whole batch
 *   before BEGIN.
 * @atomicity atomic-with-rollback (BEGIN / COMMIT / ROLLBACK).
 * @warning Inference is catalog-strict: an unmapped pair is refused rather
 *   than fabricating a `${source}_contains_${target}` edge. Pass an explicit
 *   `type` (resolved via `resolve_edge_for_pair`) for non-catalog edges.
 * @see create_edge
 * @see resolve_edge_for_pair
 * @see batch_delete_edges
 */
export const batchCreateEdges: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const edges = args.edges as Array<Record<string, unknown>> | undefined
  if (!edges || !Array.isArray(edges)) return textError('Missing required parameter: edges (array)')
  if (edges.length === 0) return textError('edges array is empty')
  if (edges.length > 50) return textError('Maximum 50 edges per batch')

  const productId = args.product_id as string

  // Pre-validate all edges before opening the transaction. Catalog-strict:
  // resolve every edge type up front and reject the whole batch on the first
  // invalid pair / unmapped inference; no `_contains_` fabrication.
  const resolvedEdgeTypes: string[] = []
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    if (!e.source_id) return textError(`Edge at index ${i}: missing required field "source_id"`)
    if (!e.target_id) return textError(`Edge at index ${i}: missing required field "target_id"`)
    if (e.source_id === e.target_id) return textError(`Edge at index ${i}: self-loop refused (source equals target "${e.source_id}").`)
    const source = await store.getNode(e.source_id as string)
    const target = await store.getNode(e.target_id as string)
    if (!source) return textError(`Edge at index ${i}: source node "${e.source_id}" not found`)
    if (!target) return textError(`Edge at index ${i}: target node "${e.target_id}" not found`)

    const explicitType = e.type as string | undefined
    if (explicitType) {
      const pairCheck = validateEdgeTypePair(explicitType, source.type, target.type)
      if (!pairCheck.valid) return textError(`Edge at index ${i}: ${pairCheck.reason}`)
      resolvedEdgeTypes.push(explicitType)
    } else {
      const inference = inferEdgeTypeWithTier(source.type, target.type)
      if (!inference.ok) {
        const suggestion = inference.suggestions.length > 0
          ? ` Try one of: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
          : ''
        return textError(`Edge at index ${i}: no canonical edge type for ${source.type} → ${target.type}.${suggestion} Pass an explicit \`type\` if you need a non-catalog edge.`)
      }
      resolvedEdgeTypes.push(inference.edgeType)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = (store as any).pool as import('pg').Pool
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const created: Array<{ id: string; source_id: string; target_id: string; type: string }> = []

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]
      const eid = edgeId()
      const edgeType = resolvedEdgeTypes[i]

      await client.query(
        `INSERT INTO upg.edges (id, product_id, source, target, type)
         VALUES ($1, $2, $3, $4, $5)`,
        [eid, productId, e.source_id as string, e.target_id as string, edgeType],
      )
      await appendAudit(client, {
        productId, action: 'create', entityType: 'edge', entityId: eid,
        changes: { source: e.source_id as string, target: e.target_id as string, type: edgeType },
      })

      created.push({
        id: eid,
        source_id: e.source_id as string,
        target_id: e.target_id as string,
        type: edgeType,
      })
    }

    await client.query('COMMIT')
    for (const c of created) store.emit(productId, 'edge.created', { id: c.id, source: c.source_id, target: c.target_id, type: c.type })
    return text(JSON.stringify({ created, count: created.length }, null, 2))
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── batch_delete_edges ───────────────────────────────────────────────────────

/**
 * Delete up to 50 edges in a single atomic transaction. All edge IDs are
 * resolved before the transaction opens.
 *
 * @returns JSON: `{ deleted: [id], count }`.
 * @throws textError when `edge_ids` is missing / non-array / empty / >50, or
 *   any ID does not resolve in the given product.
 * @atomicity atomic-with-rollback (BEGIN / COMMIT / ROLLBACK).
 * @see delete_edge
 * @see batch_create_edges
 * @see export_edges
 */
export const batchDeleteEdges: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const edgeIds = args.edge_ids as string[] | undefined
  if (!edgeIds || !Array.isArray(edgeIds)) return textError('Missing required parameter: edge_ids (array)')
  if (edgeIds.length === 0) return textError('edge_ids array is empty')
  if (edgeIds.length > 50) return textError('Maximum 50 edge IDs per batch')

  const productId = args.product_id as string

  // Pre-validate: verify all edge IDs exist in this product
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = (store as any).pool as import('pg').Pool

  // Quick existence check outside the transaction
  for (let i = 0; i < edgeIds.length; i++) {
    const { rows } = await pool.query(
      `SELECT id FROM upg.edges WHERE id = $1 AND product_id = $2`,
      [edgeIds[i], productId],
    )
    if (rows.length === 0) {
      return textError(`Edge at index ${i}: "${edgeIds[i]}" not found in product "${productId}"`)
    }
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const deleted: string[] = []

    for (const eid of edgeIds) {
      await client.query(`DELETE FROM upg.edges WHERE id = $1`, [eid])
      await appendAudit(client, {
        productId, action: 'delete', entityType: 'edge', entityId: eid,
      })
      deleted.push(eid)
    }

    await client.query('COMMIT')
    for (const eid of deleted) store.emit(productId, 'edge.deleted', { id: eid })
    return text(JSON.stringify({ deleted, count: deleted.length }, null, 2))
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── batch_move_nodes ─────────────────────────────────────────────────────────

/**
 * Re-parent up to 50 nodes in a single atomic transaction. For each move,
 * the old containment edge is deleted and a new containment edge to
 * `new_parent_id` is created (type inferred from parent→child types). The
 * transaction is rolled back entirely if any step fails.
 *
 * @returns JSON: `{ moved: [{ node_id, new_parent_id }], count }`.
 * @throws textError when `moves` is missing / non-array / empty / >50, or any
 *   `node_id` / `new_parent_id` does not resolve.
 * @atomicity atomic-with-rollback (BEGIN / COMMIT / ROLLBACK).
 * @warning Heuristic deletion of "old containment" edges relies on LIKE
 *   patterns (`%_contains_%`, `%_has_%`, `%_produces_%`) rather than the
 *   canonical edge catalog. Edges matching the patterns yet semantically
 *   non-containment may be removed alongside the intended ones. A follow-up
 *   will tighten this to catalog-aware classification.
 * @see move_node
 * @see batch_create_edges
 * @see resolve_edge_for_pair
 */
export const batchMoveNodes: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const moves = args.moves as Array<Record<string, unknown>> | undefined
  if (!moves || !Array.isArray(moves)) return textError('Missing required parameter: moves (array)')
  if (moves.length === 0) return textError('moves array is empty')
  if (moves.length > 50) return textError('Maximum 50 moves per batch')

  const productId = args.product_id as string

  // Pre-validate all moves before opening the transaction. Catalog-strict:
  // resolve each new containment edge up front and reject the whole batch on a
  // non-canonical pair; no `_contains_` fabrication.
  const resolvedMoveEdgeTypes: string[] = []
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    if (!m.node_id) return textError(`Move at index ${i}: missing required field "node_id"`)
    if (!m.new_parent_id) return textError(`Move at index ${i}: missing required field "new_parent_id"`)
    const node = await store.getNode(m.node_id as string)
    if (!node) return textError(`Move at index ${i}: node "${m.node_id}" not found`)
    const newParent = await store.getNode(m.new_parent_id as string)
    if (!newParent) return textError(`Move at index ${i}: new parent "${m.new_parent_id}" not found`)
    const inference = inferEdgeTypeWithTier(newParent.type, node.type)
    if (!inference.ok) {
      const suggestion = inference.suggestions.length > 0
        ? ` Suggestions: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
        : ''
      return textError(`Move at index ${i}: no canonical edge type for ${newParent.type} → ${node.type}.${suggestion} Reparenting refused.`)
    }
    resolvedMoveEdgeTypes.push(inference.edgeType)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = (store as any).pool as import('pg').Pool
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const moved: Array<{ node_id: string; new_parent_id: string }> = []

    for (let i = 0; i < moves.length; i++) {
      const m = moves[i]
      const nid = m.node_id as string
      const newParentId = m.new_parent_id as string

      // Existence re-check inside the tx for consistency; the edge type was
      // resolved catalog-strict in the pre-validate pass above.
      const { rows: nodeRows } = await client.query(
        `SELECT type FROM upg.nodes WHERE id = $1 AND product_id = $2`,
        [nid, productId],
      )
      const { rows: parentRows } = await client.query(
        `SELECT type FROM upg.nodes WHERE id = $1 AND product_id = $2`,
        [newParentId, productId],
      )

      if (nodeRows.length === 0) throw new Error(`Node not found in transaction: ${nid}`)
      if (parentRows.length === 0) throw new Error(`New parent not found in transaction: ${newParentId}`)

      const newEdgeType = resolvedMoveEdgeTypes[i]

      // Delete ALL existing containment edges targeting this node from within
      // this product. "Containment" edges are those whose target is this node.
      // We delete based on the inferred edge type pattern: edges where this
      // node is the target, scoped to the product.
      await client.query(
        `DELETE FROM upg.edges
         WHERE product_id = $1 AND target = $2
           AND type LIKE '%_contains_%'
           OR (product_id = $1 AND target = $2 AND type LIKE '%_has_%')
           OR (product_id = $1 AND target = $2 AND type LIKE '%_produces_%')`,
        [productId, nid],
      )

      // Create the new containment edge to the new parent
      const eid = edgeId()
      await client.query(
        `INSERT INTO upg.edges (id, product_id, source, target, type)
         VALUES ($1, $2, $3, $4, $5)`,
        [eid, productId, newParentId, nid, newEdgeType],
      )
      await appendAudit(client, {
        productId, action: 'update', entityType: 'node', entityId: nid,
        changes: { new_parent_id: newParentId, edge_type: newEdgeType },
      })

      moved.push({ node_id: nid, new_parent_id: newParentId })
    }

    await client.query('COMMIT')
    for (const m of moved) store.emit(productId, 'node.updated', { id: m.node_id, new_parent_id: m.new_parent_id })
    return text(JSON.stringify({ moved, count: moved.length }, null, 2))
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
