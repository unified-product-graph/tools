/**
 * Auto-degrade large read responses.
 *
 * Sits between the payload-guard "ok" and "refuse" outcomes. When a response
 * would fall in the soft-warn zone (above `UPG_MCP_PAYLOAD_SOFT_LIMIT` but
 * below `UPG_MCP_PAYLOAD_HARD_LIMIT`), the handler runs an applicable subset
 * of three degradation stages, in order, until the estimated size drops below
 * the soft limit:
 *
 *   1. `compact_edges_auto`: drop `source_title` / `target_title` (and any
 *      other display fields) from edges. Cheapest win on edge-heavy reads.
 *   2. `drop_optional_fields_auto`: drop `description` / `properties` from
 *      nodes. Keeps `id`, `type`, `title`, `status`, `tags`.
 *   3. `truncate_at_count_auto`: slice the nodes array, drop edges that
 *      reference dropped nodes.
 *
 * The orchestrator is generic over response shape. Handlers pass closures
 * that mutate their own response object in place. Handlers also pass a
 * `count()` callback that returns `(nodeCount, edgeCount, compactEdges)`
 * after each stage so the estimator can be re-run without re-walking the
 * data structure.
 */

import {
  estimatePayloadBytes,
  getSoftLimit,
  type EstimateInput,
} from './payload-guard.js'

export type DegradationStage =
  | 'compact_edges_auto'
  | 'drop_optional_fields_auto'
  | 'truncate_at_count_auto'

export interface DegradedBlock {
  applied: DegradationStage[]
  estimated_full_size_bytes: number
  actual_size_bytes: number
  hint: string
}

export interface DegradeStageDefinition {
  name: DegradationStage
  /** Mutate the response object in place. Returns true if the stage actually changed something. */
  apply: () => boolean
}

export interface DegradeProgressivelyInput {
  toolName: string
  /** Initial size estimate in bytes (from estimator on the un-degraded response). */
  initialBytes: number
  /** Recompute estimator inputs after a stage runs. */
  countAfterStage: () => EstimateInput
  /** Stages to attempt, in order. Skip stages that don't apply to a given tool. */
  stages: DegradeStageDefinition[]
  /** Override soft limit (defaults to env). */
  softLimit?: number
}

export interface DegradeOutcome {
  /** The `degraded` block to merge into the response, or null if no stages were applied. */
  block: DegradedBlock | null
  /** Estimated bytes after all applied stages. */
  finalBytes: number
}

/**
 * Run stages in order, stopping as soon as the running estimate drops below
 * the soft limit. Stages that apply but don't change anything (because the
 * response was already in that shape) are silently skipped.
 */
export function degradeProgressively(input: DegradeProgressivelyInput): DegradeOutcome {
  const soft = input.softLimit ?? getSoftLimit()
  let runningBytes = input.initialBytes
  const applied: DegradationStage[] = []

  for (const stage of input.stages) {
    if (runningBytes < soft) break
    const changed = stage.apply()
    if (!changed) continue
    applied.push(stage.name)
    runningBytes = estimatePayloadBytes(input.countAfterStage())
  }

  if (applied.length === 0) {
    return { block: null, finalBytes: runningBytes }
  }

  return {
    block: {
      applied,
      estimated_full_size_bytes: input.initialBytes,
      actual_size_bytes: runningBytes,
      hint: buildHint(input.toolName, applied),
    },
    finalBytes: runningBytes,
  }
}

function buildHint(toolName: string, applied: DegradationStage[]): string {
  const parts: string[] = []
  if (applied.includes('compact_edges_auto')) {
    parts.push('Edge titles dropped to fit transport.')
  }
  if (applied.includes('drop_optional_fields_auto')) {
    parts.push('Node `description` and `properties` dropped.')
  }
  if (applied.includes('truncate_at_count_auto')) {
    parts.push('Result list truncated to fit transport.')
  }
  parts.push(
    `Re-run ${toolName} with explicit projection (e.g. \`compact_edges:true\`, smaller \`limit\`) to silence this notice, or use query() for projection-aware traversal.`,
  )
  return parts.join(' ')
}
