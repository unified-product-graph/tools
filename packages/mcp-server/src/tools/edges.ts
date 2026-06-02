/**
 * Edge tools: single create/delete/move plus matching atomic batches.
 * Edge writes validate against `UPG_EDGE_CATALOG` ahead of mutation for
 * moves and batches; the lib helper covers single-edge create.
 */

import type { ToolContext, ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { edgeId } from '@unified-product-graph/sdk'
import type { UPGEdge, UPGEdgeType } from '@unified-product-graph/core'
import { UPG_EDGE_CATALOG } from '@unified-product-graph/core'
import { inferEdgeTypeWithTier } from '@unified-product-graph/sdk'
import { validateExplicitEdgeType } from '@unified-product-graph/sdk'
import { preflightPayload } from '../lib/payload-guard.js'
import { buildResolverHints } from '@unified-product-graph/sdk'
import {
  createEdge as createEdgeLib,
  deleteEdge as deleteEdgeLib,
  moveNode as moveNodeLib,
  batchMoveNodes as batchMoveNodesLib,
} from '@unified-product-graph/sdk'
import type {
  ExportEdgesResult,
  ExportEdgesEdge,
  RenameEdgeTypeResult,
} from '@unified-product-graph/mcp-tooling'

/**
 * Build an `isError` result whose text body is a JSON envelope carrying both
 * the error message and the + resolver enrichment blocks.
 * Used by `create_edge` and `batch_create_edges` when the failure is a
 * "no canonical edge" miss; the consumer can parse the body for
 * `anchor_hint` / `alternate_anchors` / `adjacent_edges`.
 *
 * Falls back to plain `textError` when no enrichment applies, keeping the
 * existing wire shape for non-resolver failures.
 */
function edgeResolverError(
  message: string,
  sourceType: string,
  targetType: string,
): ToolResult {
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
 * Create a relationship between two nodes. Edge type is auto-inferred from
 * source/target types when omitted. Target can be specified by ID or by
 * `target_title + target_type` (server resolves). For 3+ edges, ALWAYS use
 * `batch_create_edges` instead.
 *
 * @example
 * // Wire a persona to a job using the canonical edge type persona_pursues_job
 * // Input:
 * { "source_id": "persona_01", "target_id": "job_03", "type": "persona_pursues_job" }
 * // Output (truncated):
 * {
 *   "edge": { "id": "edge_15", "type": "persona_pursues_job", "source": "persona_01", "target": "job_03" },
 *   "inferred": false
 * }
 *
 * @returns JSON: the created edge object plus optional resolution metadata.
 * @throws Returns a textError when `source_id` is missing, the target cannot
 *   be resolved, or the edge violates the catalog.
 * @atomicity atomic. Single store mutation.
 * @see batch_create_edges
 * @see resolve_edge_for_pair
 * @see list_edge_types
 * @see get_edge_type
 */
export const createEdge: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  if (!args.source_id) return textError(`Missing required parameter: source_id`)

  const result = createEdgeLib(store, {
    source_id: args.source_id as string,
    target_id: args.target_id as string | undefined,
    target_title: args.target_title as string | undefined,
    target_type: args.target_type as string | undefined,
    type: args.type as string | undefined,
    properties: args.properties as Record<string, unknown> | undefined,
  })

  if ('error' in result) {
    // +: enrich "no canonical edge" failures with hint
    // blocks so the failure boundary becomes a teaching moment.
    if (result.no_canonical_edge_for) {
      return edgeResolverError(
        result.error,
        result.no_canonical_edge_for.source_type,
        result.no_canonical_edge_for.target_type,
      )
    }
    return textError(result.error)
  }
  return text(JSON.stringify(result, null, 2))
}

/**
 * Remove a relationship between two nodes.
 *
 * @returns JSON: the removed edge object.
 * @throws Returns a textError when `edge_id` is missing or does not resolve.
 * @atomicity atomic.
 * @see batch_delete_edges
 * @see export_edges
 * @see repair_dangling_edges
 */
export const deleteEdge: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  if (!args.edge_id) return textError(`Missing required parameter: edge_id`)
  try {
    const result = deleteEdgeLib(store, { edge_id: args.edge_id as string })
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Atomic re-parent. Removes the node's existing hierarchy edge (if any) and
 * creates a new one to `new_parent_id`. Validates the new edge against
 * `UPG_EDGE_CATALOG` before any mutation; on failure the graph is left
 * exactly as it started.
 *
 * @returns JSON: `{ moved: true, node_id, new_parent_id, new_edge,
 *   old_edge_id?, warning? }`. The internal `removed_edge` field is stripped
 *   from the wire payload.
 * @throws Returns a textError when `node_id` or `new_parent_id` is missing,
 *   when the inferred edge type is invalid, or when the node has multiple
 *   hierarchy edges and `old_edge_id` was not supplied.
 * @atomicity atomic-with-rollback. Pre-validates the new edge before
 *   touching the old one.
 * @see batch_move_nodes
 */
export const moveNode: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  if (!args.node_id) return textError('Missing required parameter: node_id')
  if (!args.new_parent_id) return textError('Missing required parameter: new_parent_id')
  const result = moveNodeLib(store, {
    node_id: args.node_id as string,
    new_parent_id: args.new_parent_id as string,
    new_edge_type: args.new_edge_type as string | undefined,
    old_edge_id: args.old_edge_id as string | undefined,
  })
  if (!result.moved) return textError(result.error)
  const { removed_edge: _omit, ...payload } = result
  void _omit
  return text(JSON.stringify(payload, null, 2))
}

/**
 * Apply up to 50 atomic re-parents. All-or-nothing: validates every move
 * against the schema first; on the first failure (or any mid-application
 * error) the entire batch is rolled back.
 *
 * @returns JSON: `{ moves, warnings? }` mirroring the per-move result of
 *   `move_node`.
 * @throws Returns a textError when `moves` is missing/non-array or any move
 *   fails validation.
 * @atomicity atomic-with-rollback.
 * @see move_node
 */
export const batchMoveNodes: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const moves = args.moves as Array<Record<string, unknown>> | undefined
  if (!moves || !Array.isArray(moves)) {
    return textError('Missing required parameter: moves (array)')
  }
  const outcome = batchMoveNodesLib(
    store,
    moves.map((m) => ({
      node_id: m.node_id as string,
      new_parent_id: m.new_parent_id as string,
      new_edge_type: m.new_edge_type as string | undefined,
      old_edge_id: m.old_edge_id as string | undefined,
    })),
  )
  if (!outcome.ok) return textError(outcome.error)
  return text(JSON.stringify(outcome.result, null, 2))
}

/**
 * Create up to 50 edges in a single call. ALWAYS use this for 3+ edges
 * instead of looping `create_edge`. Edge type is auto-inferred when omitted;
 * inference is validated up front so a single bad item rejects the
 * entire batch BEFORE any mutation.
 *
 * @returns JSON: `{ created, count }`.
 * @throws Returns a textError when `edges` is missing/non-array, empty,
 *   longer than 50, or any item references a missing endpoint or unresolvable
 *   edge type.
 * @atomicity atomic. Full validation pass before any mutation lands.
 * @see create_edge
 */
export const batchCreateEdges: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const edges = args.edges as Array<Record<string, unknown>> | undefined
  if (!edges || !Array.isArray(edges)) return textError('Missing required parameter: edges (array)')
  if (edges.length === 0) return textError('edges array is empty')
  if (edges.length > 50) return textError('Maximum 50 edges per batch')

  const resolvedEdgeTypes: UPGEdgeType[] = []
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    if (!e.source_id) return textError(`Edge at index ${i}: missing required field "source_id"`)
    if (!e.target_id) return textError(`Edge at index ${i}: missing required field "target_id"`)
    const sourceNode = store.getNode(e.source_id as string)
    const targetNode = store.getNode(e.target_id as string)
    if (!sourceNode) return textError(`Edge at index ${i}: source node "${e.source_id}" not found`)
    if (!targetNode) return textError(`Edge at index ${i}: target node "${e.target_id}" not found`)

    // Refuse graph-topology self-loops. No canonical UPG edge type is
    // currently self-referential. F2 (2026-05-20).
    if (e.source_id === e.target_id) {
      return textError(
        `Edge at index ${i}: self-loop refused; source and target resolve to the same node "${e.source_id}". ` +
        `No canonical UPG edge type is self-referential.`,
      )
    }

    if (e.type) {
      // (Seam 1): STRICT explicit-type validation via the SAME SDK
      // validator single `create_edge` uses — catalog membership AND pair
      // check. Previously this only called `validateEdgeTypePair`, which
      // returns valid:true for unknown types, so a made-up `type:"banana"`
      // slipped through batch while single create_edge rejected it. One pass,
      // every caller. Non-catalog types are now rejected here, not silently
      // accepted and deferred to validate_graph edge_drift.
      const typeCheck = validateExplicitEdgeType(
        e.type as string,
        sourceNode.type as string,
        targetNode.type as string,
      )
      if (typeCheck.errors.length > 0) {
        return textError(`Edge at index ${i}: ${typeCheck.errors.join(' ')}`)
      }
      resolvedEdgeTypes.push(e.type as UPGEdgeType)
    } else {
      const inference = inferEdgeTypeWithTier(sourceNode.type, targetNode.type)
      if (!inference.ok) {
        const suggestion = inference.suggestions.length > 0
          ? ` Suggestions: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
          : ''
        // +: enrich with anchor_hint / alternate_anchors /
        // adjacent_edges so the failure boundary teaches the author what
        // the catalog actually wires from this pair.
        return edgeResolverError(
          `Edge at index ${i}: no canonical edge for ${sourceNode.type} → ${targetNode.type}.${suggestion} Pass an explicit \`type\` per edge to override.`,
          sourceNode.type as string,
          targetNode.type as string,
        )
      }
      resolvedEdgeTypes.push(inference.edgeType)
    }
  }

  const createdEdges: UPGEdge[] = []
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    const edge: UPGEdge = {
      id: edgeId(),
      source: e.source_id as string,
      target: e.target_id as string,
      type: resolvedEdgeTypes[i],
    }
    store.addEdge(edge)
    createdEdges.push(edge)
  }

  return text(JSON.stringify({ created: createdEdges, count: createdEdges.length }, null, 2))
}

/**
 * Delete up to 50 edges in a single call. Atomic: all succeed or all fail.
 *
 * @returns JSON: `{ deleted, count }`.
 * @throws Returns a textError when `edge_ids` is missing/non-array, empty,
 *   longer than 50, or any ID does not resolve.
 * @atomicity atomic. Validation pass rejects the batch before any mutation
 *   lands.
 * @see delete_edge
 */
export const batchDeleteEdges: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const edgeIds = args.edge_ids as string[] | undefined
  if (!edgeIds || !Array.isArray(edgeIds)) return textError('Missing required parameter: edge_ids (array)')
  if (edgeIds.length === 0) return textError('edge_ids array is empty')
  if (edgeIds.length > 50) return textError('Maximum 50 edge IDs per batch')

  for (let i = 0; i < edgeIds.length; i++) {
    if (!store.getEdge(edgeIds[i])) return textError(`Edge at index ${i}: "${edgeIds[i]}" not found`)
  }

  const deleted: Array<{ id: string; type: string }> = []
  for (const eid of edgeIds) {
    const edge = store.removeEdge(eid)
    deleted.push({ id: edge.id, type: edge.type })
  }

  return text(JSON.stringify({ deleted, count: deleted.length }, null, 2))
}

/**
 * Inspect or repair dangling edges (edges whose `source` or `target` does
 * not resolve in the loaded `.upg` document). Classifies each as
 * `expected` (cross-product with annotations; keep), `suspect`
 * (cross-product without annotations; operator decision), or `corrupt`
 * (non-cross-product type, genuine integrity break).
 *
 * Defaults to `dry_run: true` so the agent can read the report before
 * authorising any drop. Pass `dry_run: false` plus a `drop` array of
 * classes (e.g. `["suspect", "corrupt"]`) to remove the matching edges.
 * `expected` edges are load-bearing for cross-product traversal and stay
 * untouched.
 *
 * @returns JSON: `{ dry_run, report, dropped?, remaining? }`. `report` is
 *   the pre-action classification. With `dry_run: false`, `dropped` is the
 *   count of edges removed and `remaining` is the post-action report.
 * @throws Returns a textError when `drop` is provided alongside
 *   `dry_run: true` (ambiguous), or when `drop` includes an unknown class.
 * @warning Dropping `corrupt` edges is irreversible. The integrity stamp is
 *   re-computed on next save; a subsequent reload won't bring them back.
 * @atomicity atomic-with-rollback. Classification runs against the live
 *   document before any mutation; with `dry_run: false`, the drop set is
 *   computed up-front and applied in a single index rebuild.
 */
export const repairDanglingEdges: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const dryRun = (args.dry_run as boolean | undefined) ?? true
  const drop = args.drop as string[] | undefined

  if (drop && dryRun) {
    return textError('Pass dry_run: false to actually drop edges. With dry_run: true, omit the `drop` argument.')
  }

  const report = store.getDanglingReport() ?? {
    total: 0,
    by_class: { expected: 0, suspect: 0, corrupt: 0 },
    edges: [],
  }

  if (dryRun) {
    return text(JSON.stringify({ dry_run: true, report }, null, 2))
  }

  const dropClasses = drop ?? []
  const validClasses = new Set(['expected', 'suspect', 'corrupt'])
  for (const c of dropClasses) {
    if (!validClasses.has(c)) {
      return textError(`Unknown dangling-edge class: "${c}". Valid: expected, suspect, corrupt.`)
    }
  }

  const result = store.dropDanglingEdges(dropClasses as Array<'expected' | 'suspect' | 'corrupt'>)
  return text(
    JSON.stringify(
      {
        dry_run: false,
        dropped: result.dropped,
        dropped_classes: dropClasses,
        report,
        remaining: result.remaining,
      },
      null,
      2,
    ),
  )
}

/**
 * Flat edge enumeration. Returns a tight array of `{id, source, target, type}`
 * (plus `mapping_confidence` when present). No parent-node payload, no
 * traversal model. Use this for migration / canonicalisation passes that need
 * "every edge of types X, Y, Z" without picking a `from` and reasoning about
 * BFS depth.
 *
 * Filter with `types`: omit to enumerate every edge in the loaded document.
 * Pagination via `offset` / `limit` (default `limit` = 500, max 2000); the
 * payload guard refuses oversized responses up-front.
 *
 * Response envelope is the canonical `ExportEdgesResult` from
 * `@unified-product-graph/mcp-tooling`. Cloud + downstream HTTP consumers
 * conform to the same shape.
 *
 * @returns JSON: `{ edges, total, offset, limit, types?, _hash }`. Each edge
 *   carries `{ id, source, target, type, mapping_confidence? }`.
 * @throws Returns a textError when `types` is supplied but is not an array of
 *   strings, or when the page would exceed the hard payload limit.
 * @atomicity atomic (read-only)
 * @see query
 * @see list_nodes
 */
export const exportEdges: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const ifChangedSince = args.if_changed_since as string | undefined
  const currentHash = store.getContentHash()
  if (ifChangedSince && ifChangedSince === currentHash) {
    return text(JSON.stringify({ changed: false, _hash: currentHash }, null, 2))
  }

  const typesArg = args.types as unknown
  let types: string[] | undefined
  if (typesArg !== undefined && typesArg !== null) {
    if (!Array.isArray(typesArg) || typesArg.some((t) => typeof t !== 'string')) {
      return textError('`types` must be an array of strings (or omitted to enumerate all edges).')
    }
    types = typesArg as string[]
  }

  const offset = Math.max(0, (args.offset as number) ?? 0)
  const limit = Math.min(Math.max(1, (args.limit as number) ?? 500), 2000)

  const all = store.getAllEdges()
  const filtered = types && types.length > 0 ? all.filter((e) => types!.includes(e.type)) : all
  const total = filtered.length
  const page = filtered.slice(offset, offset + limit)

  const guardOutcome = preflightPayload({
    toolName: 'export_edges',
    nodeCount: 0,
    edgeCount: page.length,
    compactEdges: true,
    argsHint: `types=${types ? types.join(',') : 'all'}, offset=${offset}, limit=${limit}`,
  })
  if (guardOutcome.kind === 'refuse') return guardOutcome.result

  const edges: ExportEdgesEdge[] = page.map((e) => {
    const out: ExportEdgesEdge = {
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.type,
    }
    if (e.mapping_confidence) out.mapping_confidence = e.mapping_confidence
    return out
  })

  const response: ExportEdgesResult = {
    edges,
    total,
    offset,
    limit,
    _hash: currentHash,
  }
  if (types) response.types = types
  // Payload guard warn-fields (e.g. `_warning`) are not part of the canonical
  // contract; merge as a side-channel via Object.assign through unknown.
  const wireResponse: Record<string, unknown> = { ...response }
  if (guardOutcome.kind === 'warn') Object.assign(wireResponse, guardOutcome.fields)

  return text(JSON.stringify(wireResponse, null, 2))
}

/**
 * Exact-match rename of every edge of type `from` to type `to`. The
 * lower-level primitive behind catalog-aware migrations: replaces the
 * manual `batch_create_edges` + `batch_delete_edges` dance for renames.
 * Matches edge type by EQUALITY (not substring) and leaves node types alone
 * (unlike `migrate_type`).
 *
 * `flip: true` swaps `source`/`target` per affected edge (useful when the new
 * catalog entry inverts direction). Properties (currently just
 * `mapping_confidence`) are preserved across the rename. Defaults to
 * `dry_run: true`, mirroring the convention `repair_dangling_edges` set in
 *.
 *
 * Skips catalog validation: pass any string for `from` / `to`. Catalog
 * awareness is the wrappers' job.
 *
 * @returns JSON: with `dry_run: true`, `{ dry_run, from, to, flip, would_rename, sample }`.
 *   With `dry_run: false`, `{ dry_run, from, to, flip, renamed, ids }`.
 * @throws Returns a textError when `from` or `to` is missing, when they are
 *   equal and `flip` is false (no-op), or when `from === to` with `flip: true`
 *   on zero matches (still safe but the call is degenerate).
 * @atomicity atomic. Single-pass mutation; an empty match-set is a clean
 *   no-op rather than an error.
 * @see migrate_type
 * @see export_edges
 */
export const renameEdgeType: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const from = args.from as string | undefined
  const to = args.to as string | undefined
  const flip = (args.flip as boolean) ?? false
  const dryRun = (args.dry_run as boolean | undefined) ?? true
  const allowNonCanonical = (args.allow_non_canonical as boolean | undefined) ?? false

  if (!from) return textError('Missing required parameter: from')
  if (!to) return textError('Missing required parameter: to')
  if (from === to && !flip) {
    return textError('`from` equals `to` and `flip` is false; nothing to do. Pass a different `to`, or set `flip: true`.')
  }

  // Strict-by-default: refuse renames to non-canonical edge types unless the
  // caller explicitly opted in. F5 (2026-05-20).
  if (!allowNonCanonical && !UPG_EDGE_CATALOG[to as UPGEdgeType]) {
    return textError(
      `\`to\` edge type "${to}" is not in UPG_EDGE_CATALOG. ` +
      `Renames to non-canonical edge types are refused by default to prevent semantic drift. ` +
      `Pass \`allow_non_canonical: true\` to override (the rename will surface as edge_drift in validate_graph).`,
    )
  }

  const matching = store.getAllEdges().filter((e) => e.type === from)

  if (dryRun) {
    const dryResponse: RenameEdgeTypeResult = {
      dry_run: true,
      from,
      to,
      flip,
      would_rename: matching.length,
      sample: matching.slice(0, 5).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: e.type,
      })),
    }
    return text(JSON.stringify(dryResponse, null, 2))
  }

  const result = store.renameEdgeType(from, to, flip)
  const applyResponse: RenameEdgeTypeResult = {
    dry_run: false,
    from,
    to,
    flip,
    renamed: result.renamed,
    ids: result.ids,
  }
  return text(
    JSON.stringify(
      applyResponse,
      null,
      2,
    ),
  )
}

export type { ToolContext }
