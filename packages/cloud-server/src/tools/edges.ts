/**
 * Edge create / delete handlers.
 */

import { type ToolHandler, text, textError, type ToolResult } from '../lib/server-context.js'
import {
  inferEdgeTypeWithTier,
  validateEdgeTypePair,
  buildResolverHints,
} from '@unified-product-graph/sdk/logic'
import { edgeId } from '../id-helpers.js'

/**
 * Build an `isError` result whose body carries the UPG-505/UPG-515 resolver
 * enrichment (`anchor_hint` / `alternate_anchors` / `adjacent_edges`) for a
 * "no canonical edge" miss. Falls back to a plain `textError` when no
 * enrichment applies. Mirrors the local MCP server's `edgeResolverError` so
 * the failure boundary is identical on both servers.
 */
function edgeResolverError(message: string, sourceType: string, targetType: string): ToolResult {
  const hints = buildResolverHints(sourceType, targetType)
  if (
    !hints.anchor_hint &&
    (!hints.alternate_anchors || hints.alternate_anchors.length === 0) &&
    (!hints.adjacent_edges || hints.adjacent_edges.length === 0)
  ) {
    return textError(message)
  }
  const body: Record<string, unknown> = {
    error: message,
    source_type: sourceType,
    target_type: targetType,
    ...hints,
  }
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true }
}

/**
 * Create a relationship between two existing nodes. Edge type is inferred
 * from the source/target types when `type` is omitted. Inference is
 * catalog-strict — an unmapped pair is refused (with resolver hints) rather
 * than fabricating a `${source}_contains_${target}` edge — matching the
 * local MCP server's `create_edge`.
 *
 * @returns JSON: `{ edge: { id, source, target, type }, warning? }`.
 * @throws textError when `source_id`/`target_id` is missing, an endpoint
 *   lookup fails, source and target resolve to the same node, an explicit
 *   `type` violates the catalog's source/target pair, or no canonical edge
 *   exists for the pair and no `type` was supplied (enriched with resolver
 *   hints).
 * @atomicity atomic-with-rollback
 * @see resolve_edge_for_pair
 * @see list_edge_types
 * @see get_edge_type
 * @see batch_create_edges
 */
export const createEdge: ToolHandler = async (args, { store }) => {
  if (!args.source_id) return textError(`Missing required parameter: source_id`)
  if (!args.target_id) return textError(`Missing required parameter: target_id`)
  const sourceId = args.source_id as string
  const targetId = args.target_id as string
  const source = await store.getNode(sourceId)
  const target = await store.getNode(targetId)
  if (!source) return textError(`Source not found: ${sourceId}`)
  if (!target) return textError(`Target not found: ${targetId}`)

  // Refuse graph-topology self-loops up front. No canonical UPG edge type is
  // self-referential.
  if (sourceId === targetId) {
    return textError(
      `Self-loop refused: source and target resolve to the same node "${sourceId}". ` +
        `No canonical UPG edge type is self-referential. ` +
        `If you genuinely need a self-referential edge, file a spec proposal first.`,
    )
  }

  let edgeType: string
  let warning: string | undefined
  const explicitType = args.type as string | undefined
  if (explicitType) {
    // Verify a user-supplied canonical type against the catalog's expected
    // source/target pair. Non-canonical types fall through (surfaced later by
    // validate_graph as edge_drift).
    const pairCheck = validateEdgeTypePair(explicitType, source.type, target.type)
    if (!pairCheck.valid) return textError(pairCheck.reason!)
    edgeType = explicitType
  } else {
    const inference = inferEdgeTypeWithTier(source.type, target.type)
    if (!inference.ok) {
      const suggestion =
        inference.suggestions.length > 0
          ? ` Try one of: ${inference.suggestions
              .map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`)
              .join('; ')}.`
          : ''
      return edgeResolverError(
        `No canonical edge type for ${source.type} → ${target.type}.${suggestion} Pass an explicit \`type\` if you need a non-catalog edge.`,
        source.type,
        target.type,
      )
    }
    edgeType = inference.edgeType
    if (inference.aliased) {
      warning = `Edge inferred from canonical (${inference.aliased.map((a) => `${a.from} → ${a.to}`).join(', ')}).`
    }
  }

  const edge = { id: edgeId(), source: sourceId, target: targetId, type: edgeType }

  try {
    await store.addEdge(source.product_id, edge as Parameters<typeof store.addEdge>[1])
    const body: Record<string, unknown> = { edge }
    if (warning) body.warning = warning
    return text(JSON.stringify(body, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Drop a single edge by id.
 *
 * @returns JSON: `{ deleted_edge_id }`.
 * @throws textError when `edge_id` is missing or unknown.
 * @atomicity atomic-with-rollback
 * @see batch_delete_edges
 * @see export_edges
 */
export const deleteEdge: ToolHandler = async (args, { store }) => {
  if (!args.edge_id) return textError(`Missing required parameter: edge_id`)
  try {
    const edge = await store.removeEdge(args.edge_id as string)
    return text(JSON.stringify({ deleted_edge_id: edge.id }, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Flat enumeration of all edges for a product, optionally filtered by type.
 * Returns the full edge set in one payload; for large products page via
 * `query` with edge filters.
 *
 * @returns JSON: `{ edges: [{ id, source, target, type }], total: number }`.
 * @throws textError when `product_id` is missing or the store rejects the read.
 * @atomicity atomic (read-only)
 * @see list_edge_types
 * @see rename_edge_type
 * @see query
 */
export const exportEdges: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const types = args.types as string[] | undefined
  try {
    const edges = await store.exportEdges(args.product_id as string, types)
    return text(JSON.stringify({ edges, total: edges.length }, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Rename all edges of one type to another across a product. Default
 * `dry_run: true`; pass `dry_run: false` to commit. Idempotent: a second
 * commit after a successful rename reports `affected: 0`. Catalog-aware
 * migrations should look up the canonical `from → to` via `list_edge_migrations`.
 *
 * @returns JSON: `{ from, to, affected: number, dry_run: boolean }`.
 * @throws textError when `product_id`, `from`, or `to` is missing.
 * @atomicity atomic-with-rollback (write path)
 * @see list_edge_types
 * @see get_edge_type
 * @see export_edges
 * @see migrate_type
 */
export const renameEdgeType: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  if (!args.from) return textError('Missing required parameter: from')
  if (!args.to) return textError('Missing required parameter: to')
  const dryRun = args.dry_run !== undefined ? Boolean(args.dry_run) : true
  try {
    const affected = await store.renameEdgeType(
      args.product_id as string,
      args.from as string,
      args.to as string,
      dryRun,
    )
    return text(JSON.stringify({ from: args.from, to: args.to, affected, dry_run: dryRun }, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}
