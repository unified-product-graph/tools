/**
 * Builds a deduplicated index of entities and edges from a parse result.
 * Used for staleness checks, coverage, and document graph views.
 */

import type { ParseResult, ReferenceIndex, IndexEntry } from './types.js'

/**
 * Build a reference index from a parse result.
 *
 * Deduplicates entity references by `type:id`, counts occurrences,
 * and collects all line numbers for each unique entity.
 */
export function buildIndex(result: ParseResult): ReferenceIndex {
  const entities = new Map<string, IndexEntry>()
  const edgeMap = new Map<string, { source: string; target: string; verb: string; lines: number[] }>()

  // Index entity references
  for (const ref of result.entityRefs) {
    const key = ref.product ? `${ref.type}:${ref.id}@${ref.product}` : `${ref.type}:${ref.id}`

    const existing = entities.get(key)
    if (existing) {
      existing.lines.push(ref.line)
      existing.count++
      if (ref.isCreation) existing.isCreation = true
    } else {
      entities.set(key, {
        type: ref.type,
        id: ref.id,
        ...(ref.product ? { product: ref.product } : {}),
        key,
        isCreation: ref.isCreation,
        lines: [ref.line],
        count: 1,
      })
    }
  }

  // Index edge references
  for (const ref of result.edgeRefs) {
    const sourceKey = ref.source.product
      ? `${ref.source.type}:${ref.source.id}@${ref.source.product}`
      : `${ref.source.type}:${ref.source.id}`
    const targetKey = ref.target.product
      ? `${ref.target.type}:${ref.target.id}@${ref.target.product}`
      : `${ref.target.type}:${ref.target.id}`
    const edgeKey = `${sourceKey}->${targetKey}|${ref.verb}`

    const existing = edgeMap.get(edgeKey)
    if (existing) {
      existing.lines.push(ref.line)
    } else {
      edgeMap.set(edgeKey, {
        source: sourceKey,
        target: targetKey,
        verb: ref.verb,
        lines: [ref.line],
      })
    }

    // Also register source and target entities in the entity index
    for (const entity of [ref.source, ref.target]) {
      const key = entity.product
        ? `${entity.type}:${entity.id}@${entity.product}`
        : `${entity.type}:${entity.id}`
      const existing = entities.get(key)
      if (existing) {
        if (!existing.lines.includes(ref.line)) existing.lines.push(ref.line)
      } else {
        entities.set(key, {
          type: entity.type,
          id: entity.id,
          ...(entity.product ? { product: entity.product } : {}),
          key,
          isCreation: false,
          lines: [ref.line],
          count: 0, // referenced via edge, not directly
        })
      }
    }
  }

  const creationRefs = [...entities.values()]
    .filter(e => e.isCreation)
    .map(e => e.key)

  return {
    entities,
    edges: [...edgeMap.values()],
    totalEntityRefs: result.entityRefs.length,
    totalEdgeRefs: result.edgeRefs.length,
    creationRefs,
  }
}
