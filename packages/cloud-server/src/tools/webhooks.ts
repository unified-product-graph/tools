/**
 * Webhook registration. Cloud-only event sink for external systems
 * subscribing to graph mutations.
 */

import { type ToolHandler, text, textError } from '../lib/server-context.js'

/**
 * Register a webhook endpoint for a product. `event` selects which
 * mutations dispatch (e.g. `node.created`, `edge.deleted`); `secret` is
 * stored alongside the registration for outgoing-request signing.
 *
 * Delivery: at-least-once with exponential backoff. Receivers MUST be
 * idempotent on `webhook.id` plus payload. Permanent 4xx eventually
 * disables the registration. Plan-tier may cap webhook count per product;
 * pre-check via `list_webhooks`.
 *
 * @returns JSON: `{ webhook: { id, product_id, event, url, secret?, created_at } }`.
 * @throws textError when `product_id`, `event`, or `url` is missing.
 * @atomicity atomic
 * @see list_webhooks
 * @see remove_webhook
 */
export const registerWebhook: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  if (!args.event) return textError(`Missing required parameter: event`)
  if (!args.url) return textError(`Missing required parameter: url`)
  const webhook = await store.registerWebhook(
    args.product_id as string,
    args.event as string,
    args.url as string,
    args.secret as string | undefined,
  )
  return text(JSON.stringify({ webhook }, null, 2))
}

/**
 * List every webhook registered for a product.
 *
 * @returns JSON: `{ webhooks: Webhook[] }`.
 * @throws textError when `product_id` is missing.
 * @atomicity atomic (read-only)
 * @see register_webhook
 * @see remove_webhook
 */
export const listWebhooks: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  const webhooks = await store.listWebhooks(args.product_id as string)
  return text(JSON.stringify({ webhooks }, null, 2))
}

/**
 * Drop a webhook registration by id. In-flight queued deliveries may
 * still fire after this returns; receivers should treat late events as
 * no-ops while tracking lifecycle.
 *
 * @returns JSON: `{ removed: <webhook_id> }`.
 * @throws textError when `webhook_id` is missing or the store rejects the deletion.
 * @atomicity atomic
 * @see register_webhook
 * @see list_webhooks
 */
export const removeWebhook: ToolHandler = async (args, { store }) => {
  if (!args.webhook_id) return textError(`Missing required parameter: webhook_id`)
  try {
    await store.removeWebhook(args.webhook_id as string)
    return text(JSON.stringify({ removed: args.webhook_id }, null, 2))
  } catch (err) {
    return textError((err as Error).message)
  }
}
