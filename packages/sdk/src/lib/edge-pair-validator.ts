/**
 * Shared edge-type-pair validation. Single source of truth for the question:
 * "given an edge type X, are these source/target node types what the catalog
 * declares?"
 *
 * Called from every write surface that takes an explicit `type` parameter
 * (create_edge, batch_create_edges, move_node) and from validate_graph to
 * flag the new `edge_type_pair_drift` class.
 *
 * Background: the 2026-05-20 adversarial spec audit (F1) confirmed that
 * explicit-type writes bypassed catalog cross-checking entirely. An LLM could
 * write `persona_pursues_job` between `vision → vulnerability` and
 * `validate_graph` would report the graph as clean. This helper closes that
 * gap.
 */

import { UPG_EDGE_CATALOG, type UPGEdgeType } from '@unified-product-graph/core'

export interface EdgePairValidationOk {
  valid: true
}

export interface EdgePairValidationFail {
  valid: false
  reason: string
  expected: { source: string; target: string }
  actual: { source: string; target: string }
}

export type EdgePairValidationResult = EdgePairValidationOk | EdgePairValidationFail

/**
 * Verify that an explicit edge type's source/target node types match the
 * catalog's declared `source_type` / `target_type`. Returns `{ valid: true }`
 * on match. On mismatch, returns a structured failure with both the catalog
 * expectation and the actual node types so the caller can render a single
 * clear error message.
 *
 * Unknown edge types (not in `UPG_EDGE_CATALOG`) return `{ valid: true }` —
 * the legacy / non-canonical edge surface is not this helper's concern.
 * Callers that care about catalog membership should check that upstream.
 */
export function validateEdgeTypePair(
  edgeType: string,
  sourceNodeType: string,
  targetNodeType: string,
): EdgePairValidationResult {
  const def = UPG_EDGE_CATALOG[edgeType as UPGEdgeType]
  // Non-canonical edge types are out of scope for this helper. They get
  // surfaced via edge_drift (existing class) when validate_graph runs.
  if (!def) return { valid: true }

  if (sourceNodeType === def.source_type && targetNodeType === def.target_type) {
    return { valid: true }
  }

  return {
    valid: false,
    reason:
      `edge type ${edgeType} expects source_type=${def.source_type} and target_type=${def.target_type}; ` +
      `got source_type=${sourceNodeType} and target_type=${targetNodeType}`,
    expected: { source: def.source_type, target: def.target_type },
    actual: { source: sourceNodeType, target: targetNodeType },
  }
}
