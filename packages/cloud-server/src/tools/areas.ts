/**
 * Product-area handlers. Read: list, subgraph BFS, summary. Write: create area.
 */

import type { UPGBaseNode, UPGEntityType } from '@unified-product-graph/core'
import { type ToolHandler, text, textError } from '../lib/server-context.js'
import { nodeId } from '../id-helpers.js'

/**
 * List the product-area entities registered for a product. Ordered by the
 * store's default (typically created-at).
 *
 * @returns JSON: `{ areas, total }`.
 * @throws textError when `product_id` is missing.
 * @atomicity atomic (read-only)
 * @see get_area_graph
 * @see get_area_context
 * @see create_area
 */
export const listProductAreas: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  const productId = args.product_id as string
  const areas = await store.listProductAreas(productId)
  return text(JSON.stringify({ areas, total: areas.length }, null, 2))
}

/**
 * BFS the subgraph rooted at a product-area. Depth default 3, clamped to 1..10.
 * Cheaper than a full `query` when you only need the area's surroundings.
 *
 * @returns JSON: `{ area, nodes, edges }`.
 * @throws textError when `product_id` or `area_id` is missing, or store rejects.
 * @atomicity atomic (read-only)
 * @see list_product_areas
 * @see get_area_context
 * @see query
 */
export const getAreaGraph: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  if (!args.area_id) return textError(`Missing required parameter: area_id`)
  const productId = args.product_id as string
  const areaId = args.area_id as string
  const maxDepth = Math.min(Math.max((args.depth as number) ?? 3, 1), 10)

  try {
    const result = await store.getAreaGraph(productId, areaId, maxDepth)
    return text(JSON.stringify(result, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Create a product area (type `area`) under a product. Top-level
 * organisational unit; the "who owns what" axis. Delegates to `store.addNode`.
 *
 * @returns JSON: `{ node }`.
 * @throws textError when `product_id` or `title` is missing.
 * @atomicity atomic
 * @see list_product_areas
 * @see get_area_context
 */
export const createArea: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  if (!args.title) return textError('Missing required parameter: title')

  const productId = args.product_id as string
  const areaNode: UPGBaseNode = {
    id: nodeId(),
    type: 'area' as UPGEntityType,
    title: args.title as string,
  }
  if (args.description) areaNode.description = args.description as string

  try {
    const created = await store.addNode(productId, areaNode)
    return text(JSON.stringify({ node: created }, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

/**
 * Summarise a product area: entity counts by type, child-area count, and
 * description. Traverses containment edges up to depth 2.
 *
 * @returns JSON: `{ area: { id, title, description }, entity_counts, total_entities, child_areas }`.
 * @throws textError when `product_id` or `area_id` is missing, or the area lookup fails.
 * @atomicity atomic (read-only)
 * @see create_area
 * @see get_area_graph
 */
export const getAreaContext: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError('Missing required parameter: product_id')
  if (!args.area_id) return textError('Missing required parameter: area_id')

  const productId = args.product_id as string
  const areaId = args.area_id as string

  const areaNode = await store.getNode(areaId)
  if (!areaNode) return textError(`Area node not found: ${areaId}`)
  if (areaNode.product_id !== productId) {
    return textError(`Area node ${areaId} does not belong to product ${productId}`)
  }

  try {
    // Count descendants directly; bypasses the product_area-only restriction of getAreaGraph
    const typeCounts = await store.getDescendantTypeCounts(productId, areaId, 2)

    const entity_counts: Record<string, number> = {}
    let child_areas = 0

    for (const { type: t, count } of typeCounts) {
      entity_counts[t] = count
      if (t === 'product_area' || t === 'area') child_areas += count
    }

    const total_entities = Object.values(entity_counts).reduce((sum, n) => sum + n, 0)

    return text(JSON.stringify({
      area: {
        id: areaNode.id,
        title: areaNode.title,
        description: areaNode.description ?? null,
      },
      entity_counts,
      total_entities,
      child_areas,
    }, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}
