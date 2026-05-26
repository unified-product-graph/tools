/**
 * Schema introspection. Returns expected properties and valid edges
 * (in and out) for any UPG entity type. Delegates to
 * `@unified-product-graph/mcp-tooling`'s `buildEntitySchema`. Includes
 * alias resolution (e.g. `jtbd → job`).
 */

import { buildEntitySchema, UnknownEntityTypeError } from '@unified-product-graph/mcp-tooling'
import { type ToolHandler, text, textError } from '../lib/server-context.js'

/**
 * Resolve the spec contract for an entity type: domain it belongs to,
 * expected properties + types/descriptions, valid edge types both
 * outbound and inbound, and lifecycle phases when registered. Aliases
 * deprecated synonyms (e.g. `jtbd → job`) and surfaces an `alias_of`
 * trail so the caller can warn.
 *
 * @returns JSON: `{ type, alias_of?, domain, expected_properties,
 * edges_out, edges_in, phases?, initial_phase?, terminal_phases?,
 * domain_guide? }`.
 * @throws textError when `type` is missing or unknown
 *   (`UnknownEntityTypeError`).
 * @atomicity atomic (read-only)
 * @see get_entity_meta
 * @see list_entity_types
 * @see get_valid_children
 * @see get_lifecycle
 * @see get_domain_guide
 * @see list_edge_types
 * @see create_node
 */
export const getEntitySchema: ToolHandler = async (args) => {
  const entityType = args.type as string | undefined
  if (!entityType) return textError('Missing required parameter: type')

  try {
    const schema = buildEntitySchema(entityType)
    return text(JSON.stringify(schema, null, 2))
  } catch (err) {
    if (err instanceof UnknownEntityTypeError) return textError(err.message)
    throw err
  }
}
