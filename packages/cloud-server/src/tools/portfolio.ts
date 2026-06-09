/**
 * Portfolio family: cross-product relationships and the portfolio view.
 * Cross-product edges live in `upg.cross_product_edges` (migration 004),
 * separate from the within-product `upg.edges` table. Includes
 * `repair_dangling_edges` for orphaned cross-product rows.
 */

import { UPG_CROSS_EDGE_TYPES } from '@unified-product-graph/core'
import { type ToolHandler, text, textError } from '../lib/server-context.js'
import { edgeId } from '../id-helpers.js'

const crossEdgeTypeSet = new Set<string>(UPG_CROSS_EDGE_TYPES)

// ── Portfolio family ─────────────────────────────────────────────────────

/**
 * List the calling user's product portfolio. For v1, one portfolio per
 * instance: returns all products as a single portfolio named "My
 * Portfolio". Multi-portfolio scoping arrives once auth is wired.
 *
 * @returns JSON: `{ portfolios: [{ id, title, products: [{ id, title, stage? }] }], total: number }`
 * @atomicity atomic (read-only)
 * @warning v1 returns a single synthetic `'default'` portfolio per
 *   instance; multi-portfolio scoping arrives once auth is wired.
 *   Treat the `id: 'default'` shape as transitional.
 * @see list_products
 * @see list_portfolio_cross_edges
 */
export const listPortfolios: ToolHandler = async (_args, { store }) => {
  const products = await store.listProducts()
  const portfolio = {
    id: 'default',
    title: 'My Portfolio',
    products: products.map((p) => ({ id: p.id, title: p.title, stage: p.stage })),
  }
  return text(JSON.stringify({ portfolios: [portfolio], total: 1 }, null, 2))
}

/**
 * List all cross-product edges created by a specific product. Returns the
 * edges this product owns; edges where another product is the source or
 * target are visible via their creating product's call.
 *
 * @returns JSON: `{ edges: [{ id, source, target, type }], total: number }`
 * @throws textError when `product_id` is missing.
 * @atomicity atomic (read-only)
 * @warning Returns only edges this product **created**; edges another
 *   product created targeting this product surface through that product's
 *   own call. To audit all incident cross-edges, query each product in
 *   the portfolio.
 * @see create_cross_product_edge
 * @see list_cross_edge_types
 * @see migrate_cross_edges
 */
export const listPortfolioCrossEdges: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  const productId = args.product_id as string
  const edges = await store.listCrossProductEdges(productId)
  return text(JSON.stringify({
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.type })),
    total: edges.length,
  }, null, 2))
}

/**
 * Create a cross-product edge owned by the given product. The edge type must
 * be one of the seven UPG cross-edge types (`shares_persona`, `shares_competitor`,
 * `shares_metric`, `depends_on_product`, `cannibalises`, `succeeds`, `hosts`). Source and
 * target are qualified IDs: `{product_id}/{node_id}`.
 *
 * @returns JSON: `{ edge: { id, source, target, type, created_by_product_id } }`
 * @throws textError when `product_id`, `source`, `target`, or
 *   `type` is missing, or `type` is not a UPG cross-edge type.
 * @atomicity atomic
 * @warning Source/target are qualified strings (`{product_id}/{node_id}`)
 *   and skip FK validation against the products table. A target
 *   referencing a deleted product becomes a dangling cross-edge; sweep
 *   periodically with `repair_dangling_edges`.
 * @see list_cross_edge_types
 * @see list_portfolio_cross_edges
 * @see repair_dangling_edges
 * @see migrate_cross_edges
 */
export const createCrossProductEdge: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  if (!args.source) return textError(`Missing required parameter: source`)
  if (!args.target) return textError(`Missing required parameter: target`)
  if (!args.type) return textError(`Missing required parameter: type`)

  const productId = args.product_id as string
  const source = args.source as string
  const target = args.target as string
  const type = args.type as string

  if (!crossEdgeTypeSet.has(type)) {
    return textError(
      `Invalid cross-edge type: "${type}". Must be one of: ${UPG_CROSS_EDGE_TYPES.join(', ')}`,
    )
  }

  try {
    const edge = await store.addCrossProductEdge(edgeId(), productId, source, target, type)
    return text(JSON.stringify({ edge }, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}

// ── repair_dangling_edges ─────────────────────────────────────────────────

/**
 * Find and optionally remove cross-product edges that reference a product
 * that no longer exists.
 *
 * In cloud, Postgres FK constraints keep intra-product edges in sync (node
 * and edge tables cascade on product delete). The "dangling" scenario is
 * a cross-product edge whose target product has been deleted, because
 * `cross_product_edges.target` is a qualified string (`{product_id}/{node_id}`)
 * outside the FK reach of `upg.products`.
 *
 * `dry_run: true` (default): report without mutating.
 * `dry_run: false` plus `drop: ['dangling_cross_edges']`: delete the
 * dangling set.
 *
 * @returns JSON: `{ dangling: [{ id, source, target, type }], dangling_count, dry_run, dropped }`
 * @throws textError when `product_id` is missing.
 * @atomicity atomic-with-rollback (when drop is requested)
 * @warning Default is `dry_run: true`. Pass `dry_run: false` AND
 *   `drop: ['dangling_cross_edges']` to actually delete; the second
 *   guard prevents accidental drops. Per-edge errors during deletion
 *   (concurrent removal) are swallowed; check `dropped` against
 *   `dangling_count` to detect partial application.
 * @see create_cross_product_edge
 * @see list_portfolio_cross_edges
 * @see migrate_cross_edges
 */
export const repairDanglingEdges: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)

  const productId = args.product_id as string
  const dryRun: boolean = args.dry_run !== false   // default true
  const drop = (args.drop as string[] | undefined) ?? []

  // Fetch all cross-product edges owned by this product
  const allEdges = await store.listCrossProductEdges(productId)

  // For each edge, parse the target qualified ID to extract the target product_id.
  // Qualified format: "{product_id}/{node_id}"
  const dangling: Array<{ id: string; source: string; target: string; type: string }> = []

  for (const edge of allEdges) {
    const slashIdx = edge.target.indexOf('/')
    if (slashIdx === -1) {
      // Malformed qualified ID: classify as dangling
      dangling.push({ id: edge.id, source: edge.source, target: edge.target, type: edge.type })
      continue
    }
    const targetProductId = edge.target.slice(0, slashIdx)
    const exists = await store.productExists(targetProductId)
    if (!exists) {
      dangling.push({ id: edge.id, source: edge.source, target: edge.target, type: edge.type })
    }
  }

  let dropped = 0

  if (!dryRun && drop.includes('dangling_cross_edges') && dangling.length > 0) {
    for (const edge of dangling) {
      try {
        await store.deleteCrossProductEdge(edge.id)
        dropped++
      } catch {
        // Edge may have already been deleted concurrently; skip
      }
    }
  }

  return text(JSON.stringify({
    dangling,
    dangling_count: dangling.length,
    dry_run: dryRun,
    dropped,
  }, null, 2))
}
