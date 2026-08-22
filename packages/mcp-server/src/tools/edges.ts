/**
 * Edge tools: single create/delete/move plus matching atomic batches.
 * Edge writes validate against `UPG_EDGE_CATALOG` ahead of mutation for
 * moves and batches; the lib helper covers single-edge create.
 */

import type { ToolContext, ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { edgeId, openPortfolioStoreIfExists } from '@unified-product-graph/sdk'
import type { UPGEdge, UPGEdgeType } from '@unified-product-graph/core'
import {
  UPG_EDGE_CATALOG,
  UPG_EDGE_TYPES,
  UPG_EDGE_MIGRATIONS,
  resolveContainmentEdge,
  validateEdgeProperties,
} from '@unified-product-graph/core'
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
 * Batch-5 #27: a `p_…` (portfolio product-header) id passed where an intra-graph
 * node id (`n_…`) is expected. The two identities aren't interchangeable — the
 * `p_` id addresses a product in cross-product edges; an intra-graph edge needs
 * the in-graph `type:"product"` NODE id. Returns a targeted hint, or null.
 */
function portfolioHeaderHint(store: ToolContext['store'], label: string, id: string | undefined): string | null {
  if (!id || !id.startsWith('p_') || store.getNode(id)) return null
  return (
    `${label} "${id}" looks like a portfolio product-header id (p_…), which addresses a product only in ` +
    `cross-product edges. An intra-graph edge needs the in-graph product NODE id (the type:"product" node, an n_… id). ` +
    `Find it with list_nodes({type:"product"}) or get_product_context.`
  )
}

/**
 * Batch-6 #37: transparently resolve a `p_…` product-header id (passed where an
 * intra-graph node id is expected) to the in-graph `type:"product"` node. New
 * products mint that node with id == the p_ header, so `getNode` already finds
 * it; products created earlier carry a distinct `n_…` product node, and this
 * lets a product-anchored edge (`product_builds_feature`,
 * `product_measures_with_metric`, …) accept the `p_` header without a manual
 * `list_nodes({type:"product"})` lookup. Returns null when `id` isn't a `p_`
 * header miss, or the graph has no product node (caller then surfaces the #27
 * hint instead of silently mis-anchoring).
 */
function resolveProductHeaderId(store: ToolContext['store'], id: string | undefined): string | null {
  if (!id || !id.startsWith('p_') || store.getNode(id)) return null
  return store.getAllNodes().find((n) => n.type === 'product')?.id ?? null
}

/**
 * Same-department advisory for a `team_contains_team` nesting (0.17.2, team_org).
 * A sub-team should sit in the same department as its parent team. We warn only
 * on a GENUINE cross-department nesting: both teams have a department parent (an
 * incoming `department_contains_team` edge) and those department sets are
 * disjoint. If either team has no department parent yet (an org map still being
 * built), we stay silent rather than nag. Never blocks the write; this mirrors
 * the forward-ref-warning precedent (a non-blocking advisory in the response).
 */
function crossDepartmentTeamWarning(
  store: ToolContext['store'],
  edge: { source: string; target: string; type: string },
): string | undefined {
  if (edge.type !== 'team_contains_team') return undefined
  const departmentsOf = (teamId: string): Set<string> => {
    const out = new Set<string>()
    for (const e of store.getEdgesForNode(teamId)) {
      if (e.type === 'department_contains_team' && e.target === teamId) out.add(e.source)
    }
    return out
  }
  const parentDepts = departmentsOf(edge.source)
  const subDepts = departmentsOf(edge.target)
  if (parentDepts.size === 0 || subDepts.size === 0) return undefined
  for (const d of subDepts) if (parentDepts.has(d)) return undefined
  return (
    `Cross-department team nesting: the sub-team and its parent team are in different departments, so this ` +
    `team_contains_team nesting crosses a department boundary. A sub-team is normally part of the same ` +
    `department as its parent team; if this is a reporting line across departments, model it at the ` +
    `individual level with person_reports_to_person instead. The edge was written; this is advisory.`
  )
}

/**
 * Batch-6 #36: pairing a hypothesis with an experiment_plan moves it into testing.
 * Auto-promote an `untested` hypothesis to `testing` when it gains a
 * `hypothesis_requires_experiment_plan` edge, so the documented
 * structural-spine recipe (hypotheses paired with plans) does not self-trip the
 * `untested-hypothesis-pile-up` anti-pattern. Best-effort: a promotion failure
 * never fails the already-created edge. (hypothesis folded onto the
 * VALIDATION template, so the phases are untested -> testing, not drafted -> active.)
 */
function promoteHypothesisOnPlanEdge(store: ToolContext['store'], edge: UPGEdge): void {
  if (edge.type !== 'hypothesis_requires_experiment_plan') return
  const hyp = store.getNode(edge.source)
  if (hyp?.type === 'hypothesis' && hyp.status === 'untested') {
    try {
      store.updateNode(edge.source, { status: 'testing' })
    } catch {
      /* promotion is a courtesy; the edge stands regardless */
    }
  }
}

/**
 * Cheap Levenshtein distance for the did_you_mean fuzzy match. Inputs are edge
 * type identifiers (tens of chars), so the iterative two-row DP is plenty.
 */
function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  let curr = new Array<number>(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]!
}

/**
 * The catalogue edge key closest to `type` by edit distance, or null when
 * nothing is within a sane threshold (never suggest something wildly
 * unrelated). This closes batch-6 #28 for a mistyped edge type whose endpoints
 * don't resolve to a canonical pair: a name typo still gets a concrete suggestion.
 */
function closestEdgeType(type: string): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const cand of UPG_EDGE_TYPES) {
    const d = editDistance(type, cand)
    if (d < bestDist) {
      bestDist = d
      best = cand
    }
  }
  const threshold = Math.max(3, Math.floor(type.length * 0.4))
  return best && bestDist <= threshold ? best : null
}

/**
 * The registered rename for an edge type, if this type was renamed.
 *
 * `UPG_EDGE_MIGRATIONS` is keyed by the release that made the change; a type
 * appears at most once, so the first match across releases is the answer.
 * Authoritative in a way the fuzzy name match below is not: a rename is a fact
 * the spec recorded, not a guess from an edit distance.
 */
function renamedEdgeType(type: string): string | null {
  for (const entries of Object.values(UPG_EDGE_MIGRATIONS)) {
    for (const m of entries) {
      if (m.kind === 'rename' && m.from === type) return m.to
    }
  }
  return null
}

/**
 * Enrich an unknown explicit edge type with a `did_you_mean` (Batch-5/6 #28,
 * migration tier added 0.34.1).
 *
 * Three tiers, in order of how much they know:
 *
 *   1. A REGISTERED RENAME. The spec recorded that this exact type became that
 *      exact type, so nothing else can be more right.
 *   2. The canonical edge for the resolved endpoint types (what
 *      `resolve_edge_for_pair` returns).
 *   3. The closest catalogue key by name, so a typo always gets a concrete
 *      suggestion rather than a pointer to another tool.
 *
 * Tier 1 is new. Before it, a renamed type reached tier 3 and was answered by
 * edit distance — which happened to land on the right name for both renames in
 * the catalogue and would not have, for a rename that widened a verb rather
 * than a noun. More to the point, `get_catalog_entry` did not consult the
 * migrations either and so answered "Unknown edge type" flat: the server's own
 * instructions tell an agent to introspect before writing, and the agent that
 * obeyed hit a dead end while the one that wrote blind got the hint. Both
 * surfaces now call THIS function, so they cannot answer differently.
 */
export function unknownEdgeTypeHint(
  type: string,
  sourceType?: string,
  targetType?: string,
): string {
  const renamed = renamedEdgeType(type)
  if (renamed) {
    return (
      `Edge type "${type}" is not in UPG_EDGE_CATALOG. ` +
      `did_you_mean: "${renamed}" (renamed in UPG_EDGE_MIGRATIONS; see list_catalog({kind:"edge_migrations"})).`
    )
  }
  const byPair = sourceType && targetType ? resolveContainmentEdge(sourceType, targetType) : null
  const suggestion = byPair ?? closestEdgeType(type)
  if (suggestion) {
    const why = byPair
      ? `the canonical ${sourceType} → ${targetType} edge`
      : 'the closest catalogue edge by name'
    return `Edge type "${type}" is not in UPG_EDGE_CATALOG. did_you_mean: "${suggestion}" (${why}).`
  }
  if (sourceType && targetType) {
    return `Edge type "${type}" is not in UPG_EDGE_CATALOG. Omit \`type\` to auto-infer, or call resolve_edge_for_pair({source_type:"${sourceType}", target_type:"${targetType}"}).`
  }
  return `Edge type "${type}" is not in UPG_EDGE_CATALOG. Omit \`type\` to auto-infer, or see resolve_edge_for_pair.`
}

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

  let sourceId = args.source_id as string
  let targetId = args.target_id as string | undefined

  // #37: transparently accept the p_ product-header where the in-graph product
  // NODE id is expected (older graphs carry a distinct n_ product node).
  sourceId = resolveProductHeaderId(store, sourceId) ?? sourceId
  if (targetId) targetId = resolveProductHeaderId(store, targetId) ?? targetId

  // #27: surface the p_/n_ identity mismatch before the generic "not found"
  // (only reached when there is no in-graph product node to resolve the p_ to).
  const srcHint = portfolioHeaderHint(store, 'source_id', sourceId)
  if (srcHint) return textError(srcHint)
  const tgtHint = portfolioHeaderHint(store, 'target_id', targetId)
  if (tgtHint) return textError(tgtHint)

  // #28: an explicit edge type that isn't canonical gets a did_you_mean from the
  // resolved endpoint types, rather than a bare "not in UPG_EDGE_CATALOG".
  const explicitType = args.type as string | undefined
  if (explicitType && !UPG_EDGE_CATALOG[explicitType as UPGEdgeType]) {
    const srcType = store.getNode(sourceId)?.type as string | undefined
    const tgtType = targetId ? (store.getNode(targetId)?.type as string | undefined) : undefined
    // Always return the hint on a bad type — even when an endpoint doesn't
    // resolve, the fuzzy name match still offers a did_you_mean (#28).
    return textError(unknownEdgeTypeHint(explicitType, srcType, tgtType))
  }

  // Validate edge properties against the type's property_schema when it has one
  // (the classification edges, 0.10.4). No-op for schema-less edge types, so
  // parity / framework-exercise edges keep their unvalidated bag.
  const propsArg = args.properties as Record<string, unknown> | undefined
  if (explicitType && propsArg && Object.keys(propsArg).length > 0) {
    const propErrors = validateEdgeProperties(explicitType, propsArg)
    if (propErrors.length > 0) {
      return textError(`Invalid properties for "${explicitType}": ${propErrors.join('; ')}`)
    }
  }

  const result = createEdgeLib(store, {
    source_id: sourceId,
    target_id: targetId,
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

  promoteHypothesisOnPlanEdge(store, result.edge)
  const warning = crossDepartmentTeamWarning(store, result.edge)
  const payload = warning ? { ...result, warning } : result
  return text(JSON.stringify(payload, null, 2))
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
 * Pass `validate_only: true` (Batch-4 #15) for a dry-run: every edge is checked
 * (endpoint existence, self-loops, explicit-type catalog/pair, inference) and
 * the COMPLETE `errors` list is returned WITHOUT writing, so an agent can fix
 * every bad edge in one pass instead of losing the batch to the first.
 *
 * @returns JSON: on commit, `{ created, count }`. On `validate_only`,
 *   `{ validate_only, valid, errors, would_create_edges }`.
 * @throws Returns a textError (or resolver-enriched envelope) when `edges` is
 *   missing/non-array, empty, longer than 50, or any item references a missing
 *   endpoint or unresolvable edge type. The commit path rejects on the first
 *   error; `validate_only` reports them all.
 * @atomicity atomic. Full validation pass before any mutation lands.
 *   `validate_only` never mutates.
 * @see create_edge
 */
export const batchCreateEdges: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const edges = args.edges as Array<Record<string, unknown>> | undefined
  if (!edges || !Array.isArray(edges)) return textError('Missing required parameter: edges (array)')
  if (edges.length === 0) return textError('edges array is empty')
  if (edges.length > 50) return textError('Maximum 50 edges per batch')

  const validateOnly = (args.validate_only as boolean) ?? false

  // Batch-4 #15: accumulate every edge error so a dry-run reports the full fix
  // list. The commit path still rejects on the first error (byte-identical to
  // prior behaviour, including resolver enrichment); only `validate_only`
  // surfaces them all.
  interface EdgeError { message: string; resolver?: { source: string; target: string } }
  const errors: EdgeError[] = []
  const resolvedEdgeTypes: Array<UPGEdgeType | null> = []

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    if (!e.source_id) { errors.push({ message: `Edge at index ${i}: missing required field "source_id"` }); resolvedEdgeTypes.push(null); continue }
    if (!e.target_id) { errors.push({ message: `Edge at index ${i}: missing required field "target_id"` }); resolvedEdgeTypes.push(null); continue }
    // #37: accept the p_ product-header in place, so a product-anchored edge in
    // a batch resolves to the in-graph product node like the single create_edge.
    e.source_id = resolveProductHeaderId(store, e.source_id as string) ?? e.source_id
    e.target_id = resolveProductHeaderId(store, e.target_id as string) ?? e.target_id
    const sourceNode = store.getNode(e.source_id as string)
    const targetNode = store.getNode(e.target_id as string)
    if (!sourceNode) {
      const hint = portfolioHeaderHint(store, 'source_id', e.source_id as string)
      errors.push({ message: hint ? `Edge at index ${i}: ${hint}` : `Edge at index ${i}: source node "${e.source_id}" not found` })
      resolvedEdgeTypes.push(null); continue
    }
    if (!targetNode) {
      const hint = portfolioHeaderHint(store, 'target_id', e.target_id as string)
      errors.push({ message: hint ? `Edge at index ${i}: ${hint}` : `Edge at index ${i}: target node "${e.target_id}" not found` })
      resolvedEdgeTypes.push(null); continue
    }

    // Refuse graph-topology self-loops. No canonical UPG edge type is
    // currently self-referential. F2 (2026-05-20).
    if (e.source_id === e.target_id) {
      errors.push({
        message:
          `Edge at index ${i}: self-loop refused; source and target resolve to the same node "${e.source_id}". ` +
          `No canonical UPG edge type is self-referential.`,
      })
      resolvedEdgeTypes.push(null)
      continue
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
        // #28: a non-catalog explicit type gets a did_you_mean from the endpoints.
        const msg = !UPG_EDGE_CATALOG[e.type as UPGEdgeType]
          ? unknownEdgeTypeHint(e.type as string, sourceNode.type as string, targetNode.type as string)
          : typeCheck.errors.join(' ')
        errors.push({ message: `Edge at index ${i}: ${msg}` })
        resolvedEdgeTypes.push(null)
        continue
      }
      resolvedEdgeTypes.push(e.type as UPGEdgeType)
    } else {
      const inference = inferEdgeTypeWithTier(sourceNode.type, targetNode.type)
      if (!inference.ok) {
        const suggestion = inference.suggestions.length > 0
          ? ` Suggestions: ${inference.suggestions.map((s) => `${s.source_type} → ${s.target_type} (${s.edge_type})`).join('; ')}.`
          : ''
        // +: track source/target so the commit path can enrich
        // the first such failure with anchor_hint / alternate_anchors /
        // adjacent_edges, teaching the author what the catalog wires.
        errors.push({
          message: `Edge at index ${i}: no canonical edge for ${sourceNode.type} → ${targetNode.type}.${suggestion} Pass an explicit \`type\` per edge to override.`,
          resolver: { source: sourceNode.type as string, target: targetNode.type as string },
        })
        resolvedEdgeTypes.push(null)
        continue
      }
      resolvedEdgeTypes.push(inference.edgeType)
    }
  }

  if (validateOnly) {
    return text(
      JSON.stringify(
        {
          validate_only: true,
          valid: errors.length === 0,
          errors: errors.map((er) => er.message),
          would_create_edges: edges.length - errors.length,
        },
        null,
        2,
      ),
    )
  }

  // Commit path: reject on the first error, preserving the prior wire shape
  // (resolver-enriched envelope for a no-canonical-edge miss, plain otherwise).
  if (errors.length > 0) {
    const first = errors[0]
    if (first.resolver) {
      return edgeResolverError(first.message, first.resolver.source, first.resolver.target)
    }
    return textError(first.message)
  }

  const createdEdges: UPGEdge[] = []
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
    const edge: UPGEdge = {
      id: edgeId(),
      source: e.source_id as string,
      target: e.target_id as string,
      type: resolvedEdgeTypes[i] as UPGEdgeType,
    }
    store.addEdge(edge)
    createdEdges.push(edge)
  }

  // #36: move an untested hypothesis into testing when paired with an experiment_plan.
  for (const edge of createdEdges) promoteHypothesisOnPlanEdge(store, edge)

  // 0.17.2: non-blocking same-department advisory for any team_contains_team nesting.
  const warnings: string[] = []
  for (const edge of createdEdges) {
    const w = crossDepartmentTeamWarning(store, edge)
    if (w) warnings.push(w)
  }
  const payload: Record<string, unknown> = { created: createdEdges, count: createdEdges.length }
  if (warnings.length > 0) payload.warnings = warnings
  return text(JSON.stringify(payload, null, 2))
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
export const exportEdges: ToolHandler = async (args, ctx): Promise<ToolResult> => {
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

  // Registry-scope note (feedback: registry-edge read path). This tool is
  // PRODUCT-scoped by contract and stays that way — migration passes depend on
  // knowing exactly which store they enumerated, so quietly folding in registry
  // edges would break the callers this tool exists to serve. What it must not do
  // is stay silent: an empty (or short) result that means *wrong scope* is
  // otherwise indistinguishable from one that means *no such edges*. When the
  // portfolio registry holds internal edges matching this call's type filter, say
  // so and name the tool that reads them.
  try {
    const portfolioStore = await openPortfolioStoreIfExists(process.cwd())
    if (portfolioStore) {
      const registryMatches = portfolioStore
        .listRegistryEdges()
        .filter((e) => !types || types.length === 0 || types.includes(e.type))
      if (registryMatches.length > 0) {
        const byType: Record<string, number> = {}
        for (const e of registryMatches) byType[e.type] = (byType[e.type] ?? 0) + 1
        wireResponse._registry_scope_note = {
          message:
            `${registryMatches.length} registry-internal edge(s) also match this filter and are NOT included: ` +
            `export_edges enumerates the ACTIVE PRODUCT only. Read them with \`list_registry_edges\`.`,
          registry_edge_count: registryMatches.length,
          by_type: byType,
        }
      }
    }
  } catch {
    // A missing or unreadable portfolio is not an error for a product-scoped
    // read; the note is advisory and its absence must never fail the export.
  }

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
