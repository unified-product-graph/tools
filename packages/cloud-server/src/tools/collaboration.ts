/**
 * Multi-user collaboration: comments and role-based access. Cloud-only.
 */

import { type ToolHandler, text, textError } from '../lib/server-context.js'

/**
 * Attach a comment to a node. Scoped to product and user; the cloud
 * schema enforces both joins.
 *
 * @returns JSON: `{ comment: { id, product_id, node_id, user_id, body, created_at } }`.
 * @throws textError when `product_id`, `node_id`, `user_id`, or `body` is missing.
 * @atomicity atomic
 * @warning `user_id` MUST resolve to a member of the product's collaborator set,
 *   or downstream RLS rejects the insert.
 * @see list_comments
 * @see list_collaborators
 * @see grant_access
 */
export const addComment: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  if (!args.node_id) return textError(`Missing required parameter: node_id`)
  if (!args.user_id) return textError(`Missing required parameter: user_id`)
  if (!args.body) return textError(`Missing required parameter: body`)
  const comment = await store.addComment(
    args.product_id as string,
    args.node_id as string,
    args.user_id as string,
    args.body as string,
  )
  return text(JSON.stringify({ comment }, null, 2))
}

/**
 * List the comment thread for a single node, ordered most-recent-last.
 *
 * @returns JSON: `{ comments: Comment[] }`.
 * @throws textError when `node_id` is missing.
 * @atomicity atomic (read-only)
 * @warning RLS-bounded; an empty array can mean "no comments" or "no access".
 * @see add_comment
 * @see list_collaborators
 */
export const listComments: ToolHandler = async (args, { store }) => {
  if (!args.node_id) return textError(`Missing required parameter: node_id`)
  const comments = await store.listComments(args.node_id as string)
  return text(JSON.stringify({ comments }, null, 2))
}

/**
 * Grant a user a role on a product. RBAC tier mapping is enforced
 * downstream of the store. Idempotent: same-role re-grants are a no-op;
 * different-role re-grants overwrite the previous role.
 *
 * @returns JSON: `{ granted: { product_id, user_id, role } }`.
 * @throws textError when `product_id`, `user_id`, or `role` is missing.
 * @atomicity atomic
 * @warning Billing-relevant: collaborator count typically drives plan tier;
 *   a grant may trigger a tier upgrade or hit a seat-limit cap.
 * @see list_collaborators
 * @see add_comment
 */
export const grantAccess: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  if (!args.user_id) return textError(`Missing required parameter: user_id`)
  if (!args.role) return textError(`Missing required parameter: role`)
  await store.grantAccess(
    args.product_id as string,
    args.user_id as string,
    args.role as string,
  )
  return text(JSON.stringify({
    granted: {
      product_id: args.product_id,
      user_id: args.user_id,
      role: args.role,
    },
  }, null, 2))
}

/**
 * List every user with explicit access to a product. Returns explicit
 * grants only; the product owner is implicit and may be omitted depending
 * on schema. Useful as a pre-check for seat-count before `grant_access`.
 *
 * @returns JSON: `{ collaborators: Array<{ user_id, role, granted_at }> }`.
 * @throws textError when `product_id` is missing.
 * @atomicity atomic (read-only)
 * @see grant_access
 * @see list_comments
 */
export const listCollaborators: ToolHandler = async (args, { store }) => {
  if (!args.product_id) return textError(`Missing required parameter: product_id`)
  const collaborators = await store.listCollaborators(args.product_id as string)
  return text(JSON.stringify({ collaborators }, null, 2))
}
