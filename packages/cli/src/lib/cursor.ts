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
 * Raised when a title reference resolves to 2+ equally-good matches and there is
 * no safe way to choose. Carries the candidate nodes so callers can list ids.
 * Classified as a usage error (exit 3), matched by name in lib/errors `die` to
 * avoid a circular import (same pattern as `AmbiguousFileError`).
 *
 * Why guard at all: `at`/`link`/`new` resolve a node by title and used to
 * silently take the FIRST hit, so two personas both titled "Busy Parent" meant
 * you operated on whichever happened to sort first, with no signal that a second
 * existed ( E3). Never silently guess; make the user pick by id.
 */
export class AmbiguousTitleError extends Error {
  readonly candidates: UPGBaseNode[]
  constructor(ref: string, candidates: UPGBaseNode[]) {
    super(
      `"${ref}" matches ${candidates.length} nodes; refusing to guess which one.\n` +
        candidates.map((n) => `  ${n.id}  ${n.type} "${n.title}"`).join('\n') +
        `\nRe-run with the exact node id.`,
    )
    this.name = 'AmbiguousTitleError'
    this.candidates = candidates
  }
}

/**
 * Resolve a node reference to a node. Tries an exact id first (the cheap, exact
 * path), then resolves by title.
 *
 * Resolution rules ( E3 — never silently guess):
 *   1. exact id            → that node
 *   2. exactly one node whose TITLE equals `ref` (case-insensitive) → that node
 *      (an exact title wins even when other titles merely contain the substring)
 *   3. 2+ nodes tie for the best fuzzy score → throw `AmbiguousTitleError`
 *   4. one best fuzzy match → that node
 *   5. no match            → `undefined`
 */
export function resolveNodeRef(store: UPGFileStore, ref: string): UPGBaseNode | undefined {
  const byId = store.getNode(ref)
  if (byId) return byId

  // An exact title match (case-insensitive) is unambiguous on its own — but only
  // when exactly one node carries that title. Two nodes titled the same are the
  // canonical E3 collision.
  const refLower = ref.trim().toLowerCase()
  const exactTitle = store.getAllNodes().filter((n) => n.title.trim().toLowerCase() === refLower)
  if (exactTitle.length === 1) return exactTitle[0]
  if (exactTitle.length > 1) throw new AmbiguousTitleError(ref, exactTitle)

  // No exact title: fall back to fuzzy search. A tie at the top score is
  // ambiguous (e.g. two titles both containing the query).
  const hits = searchNodes(store, ref, { fields: ['title', 'description', 'tags'], limit: 10 })
  if (hits.length === 0) return undefined
  const topScore = hits[0].score
  const tied = hits.filter((h) => h.score === topScore)
  if (tied.length > 1) throw new AmbiguousTitleError(ref, tied.map((h) => h.node))
  return hits[0].node
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
