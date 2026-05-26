/**
 * Resolves refs against a graph via an injected lookup function.
 * Decoupled from parsing — the same parse result can run against many graphs.
 */

import type { ReferenceIndex, ValidationOptions, ValidationResult } from './types.js'

/**
 * Validate a reference index against a graph.
 *
 * @param index - The reference index from buildIndex()
 * @param options - Lookup functions and valid type/verb sets
 * @returns Validation result with stale refs and counts
 */
export async function validate(
  index: ReferenceIndex,
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  const staleRefs: ValidationResult['staleRefs'] = []
  let resolvedCount = 0
  let skippedCount = 0

  // Validate entity types
  if (options.validTypes) {
    for (const [key, entry] of index.entities) {
      if (!options.validTypes.has(entry.type)) {
        staleRefs.push({
          key,
          line: entry.lines[0],
          reason: 'unknown_type',
        })
      }
    }
  }

  // Validate edge verbs
  if (options.validVerbs) {
    for (const edge of index.edges) {
      if (!options.validVerbs.has(edge.verb)) {
        staleRefs.push({
          key: `${edge.source}->${edge.target}|${edge.verb}`,
          line: edge.lines[0],
          reason: 'unknown_verb',
        })
      }
    }
  }

  // Validate entity existence
  if (options.entityExists) {
    for (const [key, entry] of index.entities) {
      // Skip creation refs; they are allowed to point at entities that do not yet exist.
      if (entry.isCreation) {
        skippedCount++
        continue
      }

      const exists = await options.entityExists(key)
      if (exists) {
        resolvedCount++
      } else {
        staleRefs.push({
          key,
          line: entry.lines[0],
          reason: 'not_found',
        })
      }
    }
  } else {
    skippedCount += index.entities.size
  }

  // Validate edge existence
  if (options.edgeExists) {
    for (const edge of index.edges) {
      const exists = await options.edgeExists(edge.source, edge.target, edge.verb)
      if (exists) {
        resolvedCount++
      } else {
        staleRefs.push({
          key: `${edge.source}->${edge.target}|${edge.verb}`,
          line: edge.lines[0],
          reason: 'not_found',
        })
      }
    }
  } else {
    skippedCount += index.edges.length
  }

  return {
    valid: staleRefs.length === 0,
    staleRefs,
    resolvedCount,
    skippedCount,
  }
}
