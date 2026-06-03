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
import { UPG_FRAMEWORKS_BY_ID, UPG_SCALES, type UPGFramework } from '@unified-product-graph/core'
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

/** The declared input spec for one property (type, scale, enum). */
interface FrameworkInputSpec {
  property: string
  type?: 'number' | 'string' | 'enum' | 'boolean' | 'assessment'
  scale_id?: string
  enum_values?: string[]
}

/** The scoring inputs a framework declares for a given entity type. */
function frameworkInputSpecs(framework: UPGFramework, entityType: string): FrameworkInputSpec[] {
  const req = (
    framework.data as { required_properties?: Record<string, FrameworkInputSpec[]> } | undefined
  )?.required_properties
  return req?.[entityType] ?? []
}

/** The entity types a framework declares as targets (from data.entity_types). */
function frameworkTargetTypes(framework: UPGFramework): Set<string> {
  const ets = (framework.data as { entity_types?: Array<{ type?: string }> } | undefined)
    ?.entity_types
  return new Set((ets ?? []).map((e) => e.type).filter((t): t is string => !!t))
}

/**
 * Validate one value against its declared input spec. Returns a human-readable
 * warning when the value is the wrong type or outside the declared scale/enum,
 * or null when it is fine. Storage stays permissive; this only warns.
 */
function validateInputValue(spec: FrameworkInputSpec, value: unknown): string | null {
  if (value === null || value === undefined) return null
  switch (spec.type) {
    case 'number':
    case 'assessment': {
      if (typeof value !== 'number') {
        return `"${spec.property}" expects a number but got ${JSON.stringify(value)}`
      }
      if (spec.scale_id) {
        const scale = UPG_SCALES[spec.scale_id]
        if (scale && (value < scale.min || value > scale.max)) {
          return `"${spec.property}" = ${value} is outside the ${spec.scale_id} scale (${scale.min} to ${scale.max})`
        }
      }
      return null
    }
    case 'boolean':
      return typeof value === 'boolean'
        ? null
        : `"${spec.property}" expects a boolean but got ${JSON.stringify(value)}`
    case 'enum': {
      const allowed = spec.enum_values ?? []
      if (typeof value !== 'string' || (allowed.length > 0 && !allowed.includes(value))) {
        return `"${spec.property}" = ${JSON.stringify(value)} is not one of: ${allowed.join(', ')}`
      }
      return null
    }
    case 'string':
      return typeof value === 'string'
        ? null
        : `"${spec.property}" expects a string but got ${JSON.stringify(value)}`
    default:
      return null
  }
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
  const requestedIds = args.entity_ids ?? []
  const targetTypes = frameworkTargetTypes(framework)
  for (const entityId of requestedIds) {
    // Advise (permissively) when an entity is not a declared target type for
    // this framework — so the 0.8.6 slot broadening is observable at apply time
    // instead of any type being silently accepted.
    const node = store.getNode(entityId)
    if (node && targetTypes.size > 0 && !targetTypes.has(node.type)) {
      warnings.push(
        `${entityId} is a ${node.type}, not a declared target type for ${framework.id} ` +
          `(declared: ${[...targetTypes].join(', ')}). Included anyway.`,
      )
    }
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
  // If entities were requested but none could be included (e.g. all ids were
  // typos), do not leave a dangling empty exercise. Roll it back and surface the
  // failure so the caller sees a real error instead of a silent empty success.
  if (requestedIds.length > 0 && edges.length === 0) {
    store.removeNode(exercise.id)
    throw new Error(
      `No entities could be included in the ${framework.name} exercise; nothing was created.\n` +
        warnings.map((w) => `  - ${w}`).join('\n'),
    )
  }
  return { exercise, edges, warnings }
}

/**
 * The canonical serialized result of an apply, shared by every surface (MCP
 * `apply_framework`, CLI `apply --json`) so the contract is identical across
 * them. Built from `ApplyFrameworkResult` via `applyFrameworkEnvelope`.
 */
export interface ApplyFrameworkEnvelope {
  exercise_id: string
  exercise: UPGBaseNode
  included: Array<{ edge_id: string; entity_id: string; edge_type: string }>
  warnings: string[]
}

/** Serialize an apply result into the cross-surface envelope. */
export function applyFrameworkEnvelope(result: ApplyFrameworkResult): ApplyFrameworkEnvelope {
  return {
    exercise_id: result.exercise.id,
    exercise: result.exercise,
    included: result.edges.map((e) => ({ edge_id: e.id, entity_id: e.target, edge_type: e.type })),
    warnings: result.warnings,
  }
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
    // Value validation: warn (permissively) when a DECLARED input's value is the
    // wrong type or outside its declared scale/enum (e.g. reach=999 on a 1..5
    // scale, or impact="high" where a number is declared). Storage stays
    // permissive; this only warns.
    const entityNode = store.getNode(args.entity_id)
    if (entityNode) {
      const specByProp = new Map(
        frameworkInputSpecs(framework, entityNode.type).map((s) => [s.property, s]),
      )
      for (const [key, value] of Object.entries(args.values)) {
        const spec = specByProp.get(key)
        if (!spec) continue
        const issue = validateInputValue(spec, value)
        if (issue) warnings.push(`${frameworkId}: ${issue}. Stored anyway (permissive).`)
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
