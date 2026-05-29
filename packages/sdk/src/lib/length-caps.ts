/**
 * Length / size guards for entity payloads. Soft warnings, not refusals.
 *
 * Background: the 2026-05-20 adversarial spec audit (F8) noted unbounded
 * payload sizes on titles, descriptions, and property trees are a
 * denial-of-service surface. We pick warnings (not refusals) to avoid
 * breaking existing graphs that may already carry oversized payloads from
 * earlier imports.
 *
 * Limits (deliberately generous):
 *   - title.length > 256 → warning
 *   - description.length > 16000 → warning
 *   - property tree depth > 8 OR total property tree JSON size > 64KB → warning
 */

export const TITLE_SOFT_LIMIT = 256
export const DESCRIPTION_SOFT_LIMIT = 16_000
export const PROPERTY_TREE_SOFT_BYTES = 64 * 1024
export const PROPERTY_TREE_SOFT_DEPTH = 8

export interface LengthCheckResult {
  warnings: string[]
}

/**
 * Walk title / description / properties and return warning strings for each
 * soft-limit breach. Empty `warnings` means everything is within limits.
 */
export function checkLengthCaps(args: {
  title?: string
  description?: string
  properties?: Record<string, unknown>
}): LengthCheckResult {
  const warnings: string[] = []

  if (typeof args.title === 'string' && args.title.length > TITLE_SOFT_LIMIT) {
    warnings.push(
      `title is ${args.title.length} chars (soft cap ${TITLE_SOFT_LIMIT}). ` +
      `Long titles may degrade renderers and search UIs.`,
    )
  }

  if (typeof args.description === 'string' && args.description.length > DESCRIPTION_SOFT_LIMIT) {
    warnings.push(
      `description is ${args.description.length} chars (soft cap ${DESCRIPTION_SOFT_LIMIT}). ` +
      `Consider linking to an external doc instead.`,
    )
  }

  if (args.properties && typeof args.properties === 'object') {
    const depth = measureMaxDepth(args.properties)
    if (depth > PROPERTY_TREE_SOFT_DEPTH) {
      warnings.push(
        `property tree depth is ${depth} (soft cap ${PROPERTY_TREE_SOFT_DEPTH}). ` +
        `Deep nesting suggests this should be its own entity.`,
      )
    }
    try {
      const bytes = Buffer.byteLength(JSON.stringify(args.properties), 'utf-8')
      if (bytes > PROPERTY_TREE_SOFT_BYTES) {
        warnings.push(
          `property tree is ${bytes} bytes (soft cap ${PROPERTY_TREE_SOFT_BYTES}). ` +
          `Large blobs degrade transport and renderer performance.`,
        )
      }
    } catch {
      // Unserialisable properties (circular refs); surface as its own warning.
      warnings.push(
        `property tree could not be serialised (likely a circular reference). ` +
        `Properties must be plain JSON-compatible objects.`,
      )
    }
  }

  return { warnings }
}

/**
 * Recursive depth measurement. A flat object counts as depth 1; an object
 * containing another object counts as depth 2; arrays count as their
 * element depth + 1. Capped at PROPERTY_TREE_SOFT_DEPTH + 1 to avoid
 * pathological deep-nest blowups.
 */
function measureMaxDepth(value: unknown, current = 0): number {
  if (current > PROPERTY_TREE_SOFT_DEPTH + 1) return current
  if (value === null || typeof value !== 'object') return current
  if (Array.isArray(value)) {
    if (value.length === 0) return current + 1
    return Math.max(...value.map((v) => measureMaxDepth(v, current + 1)))
  }
  const entries = Object.values(value as Record<string, unknown>)
  if (entries.length === 0) return current + 1
  return Math.max(...entries.map((v) => measureMaxDepth(v, current + 1)))
}
