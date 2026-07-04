/**
 * Schema introspection: surfaces the same constraints the LSP enforces in
 * the editor. Delegates to `buildEntitySchema` in
 * `@unified-product-graph/mcp-tooling` so cloud, local, and HTTP MCP consumers
 * share one code path.
 */

import type { ToolContext, ToolHandler, ToolResult } from '../lib/server-context.js'
import { text, textError } from '../lib/server-context.js'
import { buildEntitySchema, UnknownEntityTypeError } from '@unified-product-graph/mcp-tooling'
import {
  getValidChildren,
  getRegionForEntityType,
  resolveContainmentEdge,
  crossProductScope,
} from '@unified-product-graph/core'
import { buildResolverHints } from '@unified-product-graph/sdk'

/**
 * Build the `resolve_edge` fold block for `get_entity_schema`, byte-identical
 * to the `resolve_edge_for_pair` tool's response so the fold is a drop-in.
 * (0.19.0 consolidation: `resolve_edge_for_pair` folds into `get_entity_schema`.)
 */
function buildResolveEdge(sourceType: string, targetType: string): Record<string, unknown> {
  const edgeType = resolveContainmentEdge(sourceType, targetType)
  const response: Record<string, unknown> = {
    source_type: sourceType,
    target_type: targetType,
    edge_type: edgeType,
  }
  if (edgeType !== null) {
    const scope = crossProductScope(edgeType)
    if (scope !== 'resident') response.cross_product_scope = scope
  }
  if (edgeType === null) {
    Object.assign(response, buildResolverHints(sourceType, targetType))
  }
  return response
}

/**
 * Return the expected properties, valid statuses, valid edge types, and
 * domain for any entity type. Enables agents to construct valid entities
 * without reading skill prompts. Walks `UPG_EDGE_CATALOG` (the same source
 * the LSP uses for completion + diagnostics) and surfaces the relevant slice
 * of the domain's usage guide (anchor entity, creation sequence, anti-
 * patterns).
 *
 * 0.19.0 consolidation folds three retired tools in as opt-in blocks (default
 * output is unchanged): `include: ['valid_children']` → `get_valid_children`;
 * `include: ['region']` → `get_region_for_entity_type`; `resolve_edge_to: <t>`
 * → `resolve_edge_for_pair(type → t)`.
 *
 * @returns JSON: `{ type, alias_of?, domain, expected_properties, edges_out,
 *   edges_in, phases?, initial_phase?, terminal_phases?, domain_guide?,
 *   valid_children?, region?, resolve_edge? }`.
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

    // Opt-in folds (0.19.0). Default output (no include / resolve_edge_to) is
    // byte-identical to the pre-consolidation shape — nothing added unless asked.
    const includeRaw = args.include
    const include = new Set(Array.isArray(includeRaw) ? (includeRaw as unknown[]).map(String) : [])
    const resolveEdgeTo = args.resolve_edge_to as string | undefined

    if (include.size === 0 && !resolveEdgeTo) {
      return text(JSON.stringify(schema, null, 2))
    }

    const enriched: Record<string, unknown> = { ...schema }
    if (include.has('valid_children')) {
      // Match `get_valid_children({ parent_type: rawType })` exactly.
      enriched.valid_children = getValidChildren(rawType)
    }
    if (include.has('region')) {
      // Match `get_region_for_entity_type({ entity_type: rawType })` (null when none).
      enriched.region = getRegionForEntityType(rawType) ?? null
    }
    if (resolveEdgeTo) {
      enriched.resolve_edge = buildResolveEdge(rawType, resolveEdgeTo)
    }

    return text(JSON.stringify(enriched, null, 2))
  } catch (err) {
    if (err instanceof UnknownEntityTypeError) return textError(err.message)
    throw err
  }
}

export type { ToolContext }
