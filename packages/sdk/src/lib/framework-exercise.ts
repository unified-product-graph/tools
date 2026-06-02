/**
 * Framework exercises (UPG 0.8.4): apply a framework to a set of entities and
 * record each entity's result on the exercise's `includes` edge.
 *
 * A `framework_exercise` is one run of a framework. `applyFramework` creates the
 * exercise node plus an `includes` edge to each entity it scores; `scoreEntity`
 * fills one of those edges with the framework's per-entity result. The value
 * lives on the edge, not the entity node — so the same entity can sit in many
 * exercises with different results, and any entity type can be scored, not just
 * `feature`. See ADR 2026-06-02-framework-exercises.
 */
import { UPG_FRAMEWORKS_BY_ID, type UPGFramework } from '@unified-product-graph/core'
import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'
import type { UPGFileStore } from '../store.js'
import { createNode, createEdge } from './tools.js'

/** The canonical edge an exercise uses to reach each entity it scores. */
export const FRAMEWORK_EXERCISE_INCLUDES_EDGE = 'framework_exercise_includes_node'

/**
 * The input property names a framework declares (across all its target types).
 * Used to warn on unrecognised keys when recording a result; storage stays
 * permissive (mirrors the node-property write posture).
 */
export function frameworkInputKeys(framework: UPGFramework): string[] {
  const out = new Set<string>()
  const req = (
    framework.data as
      | { required_properties?: Record<string, Array<{ property?: string }>> }
      | undefined
  )?.required_properties
  if (req) {
    for (const props of Object.values(req)) {
      for (const p of props) if (p?.property) out.add(p.property)
    }
  }
  return [...out]
}

export interface ApplyFrameworkArgs {
  /** Framework id from the catalog (e.g. 'moscow', 'rice-scoring'). */
  framework_id: string
  /** Human label for the exercise. Defaults to "<Framework name> exercise". */
  title?: string
  /** Entities to pull into the exercise's scope (any type). */
  entity_ids?: string[]
  /** Initial lifecycle phase. Defaults to 'draft'. */
  status?: 'draft' | 'active' | 'archived'
}

export interface ApplyFrameworkResult {
  exercise: UPGBaseNode
  edges: UPGEdge[]
  warnings: string[]
}

/**
 * Create a `framework_exercise` node and an `includes` edge to each entity it
 * scores. Edges start blank; fill results with `scoreEntity`.
 */
export function applyFramework(
  store: UPGFileStore,
  args: ApplyFrameworkArgs,
): ApplyFrameworkResult {
  const framework = UPG_FRAMEWORKS_BY_ID[args.framework_id]
  if (!framework) {
    throw new Error(
      `Unknown framework: "${args.framework_id}". Pass a framework id from the ` +
        `catalog (e.g. 'moscow', 'rice-scoring', 'kano-model').`,
    )
  }
  const created = createNode(store, {
    type: 'framework_exercise',
    title: args.title ?? `${framework.name} exercise`,
    status: args.status ?? 'draft',
    properties: { framework_id: args.framework_id },
  })
  const exercise = created.node
  const edges: UPGEdge[] = []
  const warnings: string[] = []
  if (created.warning) warnings.push(created.warning)
  for (const entityId of args.entity_ids ?? []) {
    const r = createEdge(store, {
      source_id: exercise.id,
      target_id: entityId,
      type: FRAMEWORK_EXERCISE_INCLUDES_EDGE,
    })
    if ('error' in r) {
      warnings.push(`Could not include ${entityId}: ${r.error}`)
      continue
    }
    edges.push(r.edge)
  }
  return { exercise, edges, warnings }
}

export interface ScoreEntityArgs {
  exercise_id: string
  entity_id: string
  /** The framework's result for this entity (bucket / score / slot / stage). */
  values: Record<string, unknown>
  /** Replace the edge's properties instead of merging (default: merge). */
  replace?: boolean
}

export type ScoreEntityResult = { edge: UPGEdge; warnings: string[] } | { error: string }

/**
 * Record a framework's result for one entity on the exercise's `includes` edge.
 * Auto-includes the entity (creates the edge) when it is not yet in scope.
 */
export function scoreEntity(store: UPGFileStore, args: ScoreEntityArgs): ScoreEntityResult {
  const exercise = store.getNode(args.exercise_id)
  if (!exercise) return { error: `Exercise not found: ${args.exercise_id}` }
  if (exercise.type !== 'framework_exercise') {
    return { error: `Node ${args.exercise_id} is a ${exercise.type}, not a framework_exercise.` }
  }

  const warnings: string[] = []
  const frameworkId = (exercise.properties as { framework_id?: string } | undefined)?.framework_id
  const framework = frameworkId ? UPG_FRAMEWORKS_BY_ID[frameworkId] : undefined
  if (framework) {
    const known = new Set(frameworkInputKeys(framework))
    if (known.size > 0) {
      const unknown = Object.keys(args.values).filter((k) => !known.has(k))
      if (unknown.length > 0) {
        warnings.push(
          `Value key(s) not declared by ${frameworkId}: ${unknown.join(', ')}. Stored anyway (permissive).`,
        )
      }
    }
  }

  // Find the existing includes edge exercise -> entity.
  const existing = store
    .getEdgesForNode(args.exercise_id)
    .find(
      (e) =>
        e.type === FRAMEWORK_EXERCISE_INCLUDES_EDGE &&
        e.source === args.exercise_id &&
        e.target === args.entity_id,
    )
  if (existing) {
    const edge = store.setEdgeProperties(existing.id, args.values, { merge: !args.replace })
    return { edge, warnings }
  }

  // Not yet included: create the edge carrying the values in one gated step.
  const r = createEdge(store, {
    source_id: args.exercise_id,
    target_id: args.entity_id,
    type: FRAMEWORK_EXERCISE_INCLUDES_EDGE,
    properties: args.values,
  })
  if ('error' in r) return { error: r.error }
  return { edge: r.edge, warnings }
}
