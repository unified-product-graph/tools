/**
 * Schema introspection. Returns expected properties and valid edges
 * (in and out) for any UPG entity type. Delegates to
 * `@unified-product-graph/mcp-tooling`'s `buildEntitySchema`. Includes
 * alias resolution (e.g. `jtbd → job`).
 */

import { buildEntitySchema, UnknownEntityTypeError } from '@unified-product-graph/mcp-tooling'
import { type ToolHandler, text, textError } from '../lib/server-context.js'
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
 * Resolve the spec contract for an entity type: domain it belongs to,
 * expected properties + types/descriptions, valid edge types both
 * outbound and inbound, and lifecycle phases when registered. Aliases
 * deprecated synonyms (e.g. `jtbd → job`) and surfaces an `alias_of`
 * trail so the caller can warn.
 *
 * 0.19.0 consolidation folds three retired tools in as opt-in blocks (default
 * output unchanged): `include: ['valid_children']` → `get_valid_children`;
 * `include: ['region']` → `get_region_for_entity_type`; `resolve_edge_to: <t>`
 * → `resolve_edge_for_pair(type → t)`.
 *
 * @returns JSON: `{ type, alias_of?, domain, expected_properties,
 * edges_out, edges_in, phases?, initial_phase?, terminal_phases?,
 * domain_guide?, valid_children?, region?, resolve_edge? }`.
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
  const rawType = args.type as string | undefined
  if (!rawType) return textError('Missing required parameter: type')

  try {
    // 0.30.x two-tier docs: `expected_properties` carries the CONTRACT by
    // default. `include_notes` folds in the longform half (rationale, edge
    // cases, recipes) for a caller that wants the whole story. Opt-in because
    // an agent orienting in a type pays for every character it did not ask for.
    // Threaded here as well as locally: before the two-tier split the longform
    // WAS the description, so a cloud client that could not ask for notes had
    // silently lost content it used to receive.
    // Convention: packages/upg-spec/src/properties/PROPERTIES.md (canonical).
    const schema = buildEntitySchema(rawType, { include_notes: args.include_notes === true })

    const includeRaw = args.include
    const include = new Set(Array.isArray(includeRaw) ? (includeRaw as unknown[]).map(String) : [])
    const resolveEdgeTo = args.resolve_edge_to as string | undefined

    if (include.size === 0 && !resolveEdgeTo) {
      return text(JSON.stringify(schema, null, 2))
    }

    const enriched: Record<string, unknown> = { ...schema }
    if (include.has('valid_children')) {
      enriched.valid_children = getValidChildren(rawType)
    }
    if (include.has('region')) {
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
