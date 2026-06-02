/**
 * Framework-exercise tools (cloud parity, UPG 0.8.6): apply a framework to a set
 * of entities and record each entity's result on the exercise's `includes` edge
 * — the value lives on the edge, not the entity node. Postgres-backed mirror of
 * the local server's `apply_framework` / `score_entity`. See ADR
 * 2026-06-02-framework-exercises and migration 005_edge_properties.sql.
 */
import type { UPGEntityType } from '@unified-product-graph/core'
import { UPG_FRAMEWORKS_BY_ID } from '@unified-product-graph/core'
import {
  frameworkInputKeys,
  FRAMEWORK_EXERCISE_INCLUDES_EDGE,
} from '@unified-product-graph/sdk'
import { type ToolHandler, text, textError } from '../lib/server-context.js'
import { nodeId, edgeId } from '../id-helpers.js'

/**
 * Create a framework_exercise and an `includes` edge to each entity it scores,
 * scoped to one product. Edges start blank; fill results with `score_entity`.
 *
 * @returns JSON: `{ exercise_id, exercise, included: [{ edge_id, entity_id }], warnings }`.
 * @throws textError on a missing product_id/framework_id or an unknown framework_id.
 * @atomicity per-write atomic; the exercise node and each includes edge commit
 *   independently (a target that cannot be included is reported in `warnings`).
 * @see score_entity
 */
export const applyFramework: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  const frameworkId = args.framework_id as string | undefined
  if (!frameworkId) {
    return textError('Missing required parameter: framework_id (e.g. "moscow", "rice-scoring")')
  }
  const framework = UPG_FRAMEWORKS_BY_ID[frameworkId]
  if (!framework) {
    return textError(
      `Unknown framework: "${frameworkId}". Pass a framework id from the catalog ` +
        `(e.g. 'moscow', 'rice-scoring', 'kano-model').`,
    )
  }

  const productId = args.product_id as string
  const warnings: string[] = []
  try {
    const exercise = await store.addNode(productId, {
      id: nodeId(),
      type: 'framework_exercise' as UPGEntityType,
      title: (args.title as string | undefined) ?? `${framework.name} exercise`,
      status: (args.status as string | undefined) ?? 'draft',
      properties: { framework_id: frameworkId },
    })

    const included: Array<{ edge_id: string; entity_id: string }> = []
    for (const entityId of (args.entity_ids as string[] | undefined) ?? []) {
      const target = await store.getNode(entityId)
      if (!target) {
        warnings.push(`Could not include ${entityId}: target not found`)
        continue
      }
      const edge = {
        id: edgeId(),
        source: exercise.id,
        target: entityId,
        type: FRAMEWORK_EXERCISE_INCLUDES_EDGE,
      }
      try {
        await store.addEdge(productId, edge as Parameters<typeof store.addEdge>[1])
        included.push({ edge_id: edge.id, entity_id: entityId })
      } catch (err) {
        warnings.push(`Could not include ${entityId}: ${(err as Error).message}`)
      }
    }

    return text(
      JSON.stringify(
        { exercise_id: exercise.id, exercise, included, warnings },
        null,
        2,
      ),
    )
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Record a framework's result for one entity on the exercise's `includes` edge.
 * Auto-includes the entity when it is not yet in scope. Merges into existing
 * edge properties unless `replace` is set. Product is resolved from the
 * exercise node, so no product_id is needed.
 *
 * @returns JSON: `{ edge, warnings }`.
 * @throws textError when the exercise/entity is missing or the node is not a
 *   framework_exercise.
 * @atomicity atomic-with-rollback (single edge upsert).
 * @see apply_framework
 */
export const scoreEntity: ToolHandler = async (args, { store }) => {
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

  const exercise = await store.getNode(exerciseId)
  if (!exercise) return textError(`Exercise not found: ${exerciseId}`)
  if (exercise.type !== 'framework_exercise') {
    return textError(`Node ${exerciseId} is a ${exercise.type}, not a framework_exercise.`)
  }

  const warnings: string[] = []
  const frameworkId = (exercise.properties as { framework_id?: string } | undefined)?.framework_id
  const framework = frameworkId ? UPG_FRAMEWORKS_BY_ID[frameworkId] : undefined
  if (framework) {
    const known = new Set(frameworkInputKeys(framework))
    if (known.size > 0) {
      const unknown = Object.keys(values).filter((k) => !known.has(k))
      if (unknown.length > 0) {
        warnings.push(
          `Value key(s) not declared by ${frameworkId}: ${unknown.join(', ')}. Stored anyway (permissive).`,
        )
      }
    }
  }

  try {
    const edges = await store.getEdgesForNode(exerciseId)
    const existing = edges.find(
      (e) =>
        e.type === FRAMEWORK_EXERCISE_INCLUDES_EDGE &&
        e.source === exerciseId &&
        e.target === entityId,
    )
    if (existing) {
      const edge = await store.setEdgeProperties(existing.id, values, { merge: !args.replace })
      return text(JSON.stringify({ edge, warnings }, null, 2))
    }

    // Not yet included: create the edge carrying the values in one step.
    const target = await store.getNode(entityId)
    if (!target) return textError(`Entity not found: ${entityId}`)
    const edge = {
      id: edgeId(),
      source: exerciseId,
      target: entityId,
      type: FRAMEWORK_EXERCISE_INCLUDES_EDGE,
      properties: values,
    }
    await store.addEdge(exercise.product_id, edge as Parameters<typeof store.addEdge>[1])
    return text(JSON.stringify({ edge, warnings }, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}
