/**
 * Schema introspection: surfaces the same constraints the LSP enforces in
 * the editor. Delegates to `buildEntitySchema` in
 * `@unified-product-graph/mcp-tooling` so cloud, local, and HTTP MCP consumers
 * share one code path.
 */

import type { ToolContext, ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { buildEntitySchema, UnknownEntityTypeError } from '@unified-product-graph/mcp-tooling'

/**
 * Return the expected properties, valid statuses, valid edge types, and
 * domain for any entity type. Enables agents to construct valid entities
 * without reading skill prompts. Walks `UPG_EDGE_CATALOG` (the same source
 * the LSP uses for completion + diagnostics) and surfaces the relevant slice
 * of the domain's usage guide (anchor entity, creation sequence, anti-
 * patterns).
 *
 * @returns JSON: `{ type, alias_of?, domain, expected_properties, edges_out,
 *   edges_in, phases?, initial_phase?, terminal_phases?, domain_guide? }`.
 * @throws Returns a textError when `type` is missing or unknown.
 * @atomicity atomic (read-only)
 * @see get_entity_meta
 * @see list_entity_types
 * @see get_valid_children
 * @see get_lifecycle
 * @see get_domain_guide
 * @see list_edge_types
 * @see create_node
 */
export const getEntitySchema: ToolHandler = (args, _ctx): ToolResult => {
  const rawType = args.type as string | undefined
  if (!rawType) return textError('Missing required parameter: type')

  try {
    const schema = buildEntitySchema(rawType)
    return text(JSON.stringify(schema, null, 2))
  } catch (err) {
    if (err instanceof UnknownEntityTypeError) return textError(err.message)
    throw err
  }
}

export type { ToolContext }
