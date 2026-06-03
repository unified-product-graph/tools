/**
 * Framework-exercise tools (0.8.4): apply a framework to a set of entities and
 * record each entity's result on the exercise's `includes` edge — the value
 * lives on the edge, not the entity node. See ADR 2026-06-02-framework-exercises.
 */
import type { ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import {
  applyFramework as applyFrameworkLib,
  applyFrameworkEnvelope,
  scoreEntity as scoreEntityLib,
} from '@unified-product-graph/sdk'

/**
 * Create a framework_exercise and an `includes` edge to each entity it scores.
 * Edges start blank; fill results with `score_entity`.
 *
 * @returns JSON: `{ exercise_id, exercise, included: [{ edge_id, entity_id, edge_type }], warnings }`
 *   (the shared cross-surface envelope; identical to CLI `apply --json`).
 * @throws textError on a missing/unknown framework_id, or when no requested
 *   entity resolves (no dangling exercise is left behind).
 * @atomicity atomic.
 * @see score_entity
 */
export const applyFramework: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const frameworkId = args.framework_id as string | undefined
  if (!frameworkId) {
    return textError('Missing required parameter: framework_id (e.g. "moscow", "rice-scoring")')
  }
  try {
    const result = applyFrameworkLib(store, {
      framework_id: frameworkId,
      title: args.title as string | undefined,
      entity_ids: (args.entity_ids as string[] | undefined) ?? [],
      status: args.status as 'draft' | 'active' | 'archived' | undefined,
    })
    return text(JSON.stringify(applyFrameworkEnvelope(result), null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Record a framework's result for one entity on the exercise's `includes` edge.
 * Auto-includes the entity when it is not yet in scope. Merges into existing
 * edge properties unless `replace` is set.
 *
 * @returns JSON: `{ edge, warnings }`.
 * @throws textError when the exercise/entity is missing or the node is not a
 *   framework_exercise.
 * @atomicity atomic.
 * @see apply_framework
 */
export const scoreEntity: ToolHandler = (args, ctx): ToolResult => {
  const { store } = ctx
  const exerciseId = args.exercise_id as string | undefined
  const entityId = args.entity_id as string | undefined
  const values = args.values as Record<string, unknown> | undefined
  if (!exerciseId) return textError('Missing required parameter: exercise_id')
  if (!entityId) return textError('Missing required parameter: entity_id')
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return textError(
      'Missing required parameter: values (object of input → value, e.g. { "moscow": "must" })',
    )
  }
  const result = scoreEntityLib(store, {
    exercise_id: exerciseId,
    entity_id: entityId,
    values,
    replace: args.replace as boolean | undefined,
  })
  if ('error' in result) return textError(result.error)
  return text(JSON.stringify({ edge: result.edge, warnings: result.warnings }, null, 2))
}
