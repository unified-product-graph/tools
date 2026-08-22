/**
 * Shared property-type validation. Single source of truth for the question:
 * "given a declared property in UPG_PROPERTY_SCHEMA, does the value match its
 * declared type?"
 *
 * Called from every write surface that takes a `properties` parameter
 * (create_node, update_node, batch_update_nodes) and from validate_graph to
 * flag the new `property_type_drift` class.
 *
 * Background: the 2026-05-20 adversarial spec audit (F4) confirmed that
 * declared property type violations were silently accepted; writing
 * `metric.target_value = "not_a_number_lol"` was stored verbatim despite the
 * schema declaring `target_value: number`. This helper closes that gap.
 *
 * UNDECLARED properties are out of scope for this helper. The existing
 * unknown-properties warning (checkUnknownProperties) handles those.
 */

import { getPropertySchema, type PropertyDefinition } from '@unified-product-graph/core'

export interface PropertyTypeViolation {
  /** The property key with the wrong type. */
  property: string
  /** The schema-declared expected type. */
  expected_type: PropertyDefinition['type']
  /** The actual JavaScript typeof / shape descriptor. */
  actual_type: string
  /** Free-text explanation. */
  reason: string
}

export interface PropertyTypeCheckResult {
  /** Violations against declared property types. Empty when no declared
   *  property mismatched, independent of whether undeclared properties
   *  exist (those are reported separately by checkUnknownProperties). */
  violations: PropertyTypeViolation[]
}

/**
 * Walk a node's properties bag and report violations against the type
 * declared in `UPG_PROPERTY_SCHEMA`.
 *
 * Entity types with no registered schema are treated as fully permissive:
 * no violations reported. Properties not present in the schema are skipped
 * (unknown-properties is a separate concern).
 *
 * Null and undefined values are tolerated (not a violation). Arrays are
 * special-cased for `string[]` schema entries.
 */
export function checkPropertyTypes(
  entityType: string,
  properties: Record<string, unknown> | undefined,
): PropertyTypeCheckResult {
  if (!properties || Object.keys(properties).length === 0) {
    return { violations: [] }
  }
  const schema = getPropertySchema(entityType)
  if (!schema) return { violations: [] }

  const violations: PropertyTypeViolation[] = []
  for (const [key, value] of Object.entries(properties)) {
    const def = schema[key]
    // Undeclared property; out of scope for this helper.
    if (!def) continue
    // Tolerate null / undefined; treat as "field cleared / not set".
    if (value === null || value === undefined) continue

    const actualType = describeActualType(value)
    if (!matchesDeclaredType(value, def.type)) {
      violations.push({
        property: key,
        expected_type: def.type,
        actual_type: actualType,
        reason:
          `property "${key}" declared as ${def.type}; ` +
          `got ${actualType} (value: ${describeValue(value)})`,
      })
    }
  }

  return { violations }
}

/**
 * Type predicate: does `value` match the declared schema type?
 */
function matchesDeclaredType(value: unknown, declaredType: PropertyDefinition['type']): boolean {
  switch (declaredType) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
    case 'object[]':
      return (
        Array.isArray(value) &&
        value.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
      )
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    default:
      return true
  }
}

/**
 * Render a short label for the value's actual type (for error messages).
 */
function describeActualType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) return 'string[]'
    if (value.length > 0 && value.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v)))
      return 'object[]'
    if (value.length === 0) return 'array (empty)'
    return `array (mixed: ${[...new Set(value.map((v) => typeof v))].join(', ')})`
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 'number (non-finite)'
  return typeof value
}

/**
 * Truncate a value for error messages: JSON.stringify, max 80 chars.
 */
function describeValue(value: unknown): string {
  try {
    const str = JSON.stringify(value)
    if (str.length <= 80) return str
    return str.slice(0, 77) + '...'
  } catch {
    return '<unserialisable>'
  }
}

/**
 * Render violations as a single warning string for embedding in tool
 * responses. Empty when there are no violations.
 */
export function renderPropertyTypeWarning(
  entityType: string,
  violations: PropertyTypeViolation[],
): string | undefined {
  if (violations.length === 0) return undefined
  const parts = violations.map((v) => v.reason)
  return (
    `Property type violations for "${entityType}": ${parts.join(' | ')}. ` +
    `Check get_entity_schema("${entityType}") for the canonical property types.`
  )
}

// ─── Undeclared property keys ─────────────────────────────────────────────────

/**
 * Property-bag keys the entity type does not declare.
 *
 * SINGLE SOURCE for "is this bag key declared?", answering the question the
 * type-checker above deliberately does not. It was previously answered by a
 * module-local helper inside the MCP node tools, which is why the server's two
 * surfaces could disagree about one node: `get_node` asked THIS question and
 * `validate_graph` asked a different one (is this key covered by a migration
 * rule?), reported the answer as `property_drift: 0`, and so had no drift class
 * of any kind that could see an undeclared key. Whichever a consumer trusted,
 * the other contradicted it. One helper, both surfaces.
 *
 * NAMESPACED KEYS ARE EXEMPT, which the module-local version got wrong. The
 * spec's rule for a key a tool owns and the spec does not declare is to write it
 * `<tool>:<key>` with a colon (`UPGBaseNode.properties`, the 0.31.0 rule
 * extended to the node bag at 0.33.0), precisely so a validator can tell a
 * deliberate extension apart from a misspelled spec property. Reporting a
 * correctly-namespaced key as unknown punishes the convention that exists to
 * make this answerable, so a key containing a colon is a declared extension and
 * passes.
 *
 * A type with no registered schema is fully permissive: nothing is reported,
 * because there is nothing to be undeclared against.
 */
export function checkUndeclaredProperties(
  entityType: string,
  properties: Record<string, unknown> | undefined,
): { unknown_properties: string[]; warning: string | undefined } {
  if (!properties || Object.keys(properties).length === 0) {
    return { unknown_properties: [], warning: undefined }
  }
  const schema = getPropertySchema(entityType)
  if (!schema) return { unknown_properties: [], warning: undefined }

  const unknown = Object.keys(properties).filter(
    (k) => !(k in schema) && !isNamespacedPropertyKey(k),
  )
  if (unknown.length === 0) return { unknown_properties: [], warning: undefined }

  const warning =
    `Unknown properties for type "${entityType}": [${unknown.map((k) => `"${k}"`).join(', ')}]. ` +
    `These will be stored but are not part of the canonical UPG schema. ` +
    `Check get_entity_schema("${entityType}") for the canonical property list.`
  return { unknown_properties: unknown, warning }
}

/**
 * True for a key written under the spec's extension convention, `<tool>:<key>`.
 *
 * Deliberately shallow. It asks only whether the key claims a namespace, not
 * whether the namespace is one anybody recognises: the convention exists so an
 * extension is DISTINGUISHABLE from a typo, and a registry of permitted tool
 * names would be a different rule with a different cost.
 */
export function isNamespacedPropertyKey(key: string): boolean {
  const i = key.indexOf(':')
  return i > 0 && i < key.length - 1
}
