/**
 * Multi-tenant primitives: products and audit log. Cloud-only; three handlers
 * (`list_products`, `create_product`, `get_audit_log`) manage the `product_id`
 * scope every other tool takes.
 */

import { type ToolHandler, text, textError } from '../lib/server-context.js'

/**
 * List every product visible to the caller. Discovery surface for valid
 * `product_id` values before scoped queries.
 *
 * @returns JSON: `{ products: Array<{ id, title, description?, stage? }> }`.
 * @atomicity atomic (read-only)
 * @warning RLS-bounded; an empty list can mean "no products" or "no access".
 *   Pair with `list_collaborators` to confirm scope on a specific product.
 * @see create_product
 * @see get_product_context
 * @see get_graph_digest
 * @see list_collaborators
 */
export const listProducts: ToolHandler = async (_args, { store }) => {
  const products = await store.listProducts()
  return text(JSON.stringify({ products }, null, 2))
}

/**
 * Create a new product graph. Caller is auto-granted `owner` on the new product.
 *
 * @returns JSON: `{ product: { id, title, description?, stage? } }`.
 * @throws textError when `title` is missing.
 * @atomicity atomic
 * @warning Billing-relevant: product count typically drives plan tier;
 *   creation may trigger a tier upgrade or hit the plan's product cap.
 * @see list_products
 * @see grant_access
 * @see list_product_stages
 */
export const createProduct: ToolHandler = async (args, { store }) => {
  if (!args.title) return textError(`Missing required parameter: title`)
  const product = await store.createProduct(
    args.title as string,
    args.description as string | undefined,
    args.stage as string | undefined,
  )
  return text(JSON.stringify({ product }, null, 2))
}

/**
 * Read the product's audit log: canonical history of mutations,
 * most-recent first. Default `limit: 50`.
 *
 * @returns JSON: `{ entries: Array<{ ...mutation }> }`.
 * @throws textError when `product_id` is missing.
 * @atomicity atomic (read-only)
 * @warning Retention-windowed: entries beyond the plan-tier retention period
 *   are pruned. An empty window may mean "out of retention", not "no activity".
 * @see get_graph_analytics
 * @see get_graph_digest
 * @see list_products
 */
export const getAuditLog: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  const productId = args.product_id as string
  const limit = (args.limit as number) ?? 50
  const entries = await store.getAuditLog(productId, limit)
  return text(JSON.stringify({ entries }, null, 2))
}
