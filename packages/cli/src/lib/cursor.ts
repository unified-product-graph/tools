/**
 * Cursor helpers shared by the Tier-1 navigation verbs (`here`, `at`, `ls`,
 * `new`, `find`). Resolves a node reference (id OR title) against a loaded
 * store, and reads/clears a dangling cursor.
 */

import type { UPGBaseNode } from '@unified-product-graph/core'
import { searchNodes } from './graph.js'
import type { UPGFileStore } from './graph.js'
import { readSession, clearCursor } from './session.js'

/**
 * Resolve a node reference to a node. Tries an exact id first (the cheap, exact
 * path), then falls back to a title/description fuzzy search and takes the top
 * hit. Returns `undefined` when nothing resolves.
 */
export function resolveNodeRef(store: UPGFileStore, ref: string): UPGBaseNode | undefined {
  const byId = store.getNode(ref)
  if (byId) return byId
  const hits = searchNodes(store, ref, { fields: ['title', 'description', 'tags'], limit: 1 })
  return hits[0]?.node
}

/**
 * Resolve the current cursor node for a graph, honouring a stateless `--at`
 * override. If the sticky cursor points at a node that no longer exists, clear
 * it (self-healing) and return undefined.
 *
 * @returns the cursor node, or `undefined` when there is no cursor / it's dangling.
 */
export function resolveCursor(
  store: UPGFileStore,
  filePath: string,
  override?: string,
): UPGBaseNode | undefined {
  if (override) return resolveNodeRef(store, override)
  const { cursor } = readSession(filePath)
  if (!cursor) return undefined
  const node = store.getNode(cursor)
  if (!node) {
    clearCursor(filePath)
    return undefined
  }
  return node
}
