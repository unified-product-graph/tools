/**
 * Postgres-side analytics aggregator over a product graph. Cloud-only;
 * heavier than `get_graph_digest`.
 */

import { type ToolHandler, text, textError } from '../lib/server-context.js'

/**
 * Run the analytics aggregator on a product. Heavier than
 * `get_graph_digest`; results may lag recent writes when the aggregation
 * is cached at the storage layer.
 *
 * @returns JSON: `{ product: { id, title }, analytics }`.
 * @throws textError when `product_id` is missing or the product is invisible
 *   to the caller (RLS-bounded; "not found" and "no access" share wording).
 * @atomicity atomic (read-only)
 * @see get_graph_digest
 * @see get_product_context
 * @see get_audit_log
 */
export const getGraphAnalytics: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  const productId = args.product_id as string
  const product = await store.getProduct(productId)
  if (!product) return textError(`Product not found: ${productId}`)
  const analytics = await store.getGraphAnalytics(productId)
  return text(JSON.stringify({
    product: { id: product.id, title: product.title },
    analytics,
  }, null, 2))
}
