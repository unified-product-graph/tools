import { nanoid } from 'nanoid'

/** Generate a prefixed node ID */
export function nodeId(): string {
  return `n_${nanoid(16)}`
}

/** Generate a prefixed edge ID */
export function edgeId(): string {
  return `e_${nanoid(16)}`
}

/** Generate a prefixed product ID (for `doc.product.id` in new .upg files) */
export function productId(): string {
  return `p_${nanoid(16)}`
}
