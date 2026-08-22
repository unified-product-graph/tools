/**
 * Composition writes: the one composition operation the generic node tools
 * cannot serve.
 *
 * A composition IS an ordinary node, so every generic reader already reaches
 * it. `list_nodes({ type: 'composition' })` enumerates them, `get_node` returns
 * the node together with its `composition_focuses_node` edges (which is the
 * join), and because the id IS the slug, `get_node({ id: 'delivery-board' })`
 * is address-by-slug. Reads need nothing new.
 *
 * What the generic writers cannot do is `rev`. It is DERIVED, and a caller
 * driving `update_node({ properties: { rev: 5 } })` writes whatever number it
 * happens to be holding: not merely unhelpful, but silently WRONG, and wrong in
 * the one field whose whole job is to say which print you are looking at. That
 * is the entire reason this module exists.
 *
 * ── Mirrored, not designed ─────────────────────────────────────────────────
 * The write semantics here are a faithful mirror of the shipped local-file
 * implementation in the (private) `@entopo/graph-service` adapter, which the
 * MCP server cannot call: that package is private and depends on this one, so
 * the primitive lands on this side of the seam instead. Six behaviours travel
 * with it, each load-bearing:
 *
 *   1. `rev` is NEVER written from the argument. It is re-derived inside the
 *      write from the node as it exists at that moment, and incremented ONLY on
 *      a transition into `published`. `0` means never published. Two publishers
 *      racing produce N+1 then N+2; neither can regress or land on a number
 *      twice.
 *   2. `rev` may be supplied as an optimistic PRECONDITION. Supplying it turns
 *      "I am publishing" into "I am publishing what I saw at rev N", and a
 *      mismatch is a stated refusal carrying `stored_rev` rather than a silent
 *      overwrite of somebody else's print.
 *   3. Omitting `members` PRESERVES the stored arrangement. Retiring or
 *      renaming a view must not erase what it looked like. Passing `[]` is a
 *      different instruction from omitting it, and the difference survives the
 *      whole call path.
 *   4. The id IS the slug. No surrogate id is minted.
 *   5. The node and its focus edges are written TOGETHER, in one commit. The
 *      alternative (create_node then N create_edge calls) can fail halfway and
 *      leave a composition focusing nothing, which is a state the shape
 *      explicitly declares VALID, so nothing downstream would ever report it.
 *   6. Any lifecycle may be written, `published` included. There is no second
 *      minter here to duplicate against: `rev` is derived per-slug inside a
 *      single-writer commit, so the hazard that gates other fields does not
 *      apply. The publication gate that matters lives in the publishing
 *      application and is not duplicated here.
 *
 * ── One behaviour NOT mirrored, corrected at 0.34.1 ─────────────────────────
 * The adapter parked the lifecycle in `properties.lifecycle` and this module
 * copied it. Mirroring was the right instinct and this was the wrong thing to
 * mirror: `composition` declares no `lifecycle` property, the spec's rule for an
 * undeclared bag key is to namespace it `<tool>:<key>`, and a node written that
 * way carried no `status` at all — so a view that had just been published could
 * not be found by `list_nodes({ status: 'published' })`, and `get_node` reported
 * both `lifecycle` and `updated_at` as unknown properties on every composition
 * this module had ever written. The phase now goes to `status`, whose vocabulary
 * is the bespoke `composition` lifecycle already in the spec, and `updated_at`
 * goes to the declared base field of that name. Both stale bag keys are cleared
 * on the next publish, so a graph written by 0.34.0 heals itself.
 *
 * ── Wire naming ────────────────────────────────────────────────────────────
 * Fields are snake_case throughout, matching the on-disk property names and the
 * MCP argument bag. That is not cosmetic: it keeps the tool handler a straight
 * pass-through, and semantic 3 above turns on `members === undefined` surviving
 * argument plumbing intact. Fewer renames, fewer places to lose it.
 */

import type { UPGBaseNode, UPGEdge, UPGEntityType } from '@unified-product-graph/core'
import type { CompositionMember, UPGViewQuery, UPGViewPresentation } from '@unified-product-graph/core'
import type { UPGFileStore } from '../store.js'
import { edgeId } from './id.js'

/** Entity type of a published view. */
export const COMPOSITION_TYPE = 'composition'

/** The edge that answers "which published views show this entity?". */
export const COMPOSITION_FOCUS_EDGE = 'composition_focuses_node'

/**
 * The lifecycle of a published view: being prepared, live, or withdrawn.
 *
 * STORED ON `status`, THE BASE FIELD (corrected 0.34.1). This used to be written
 * to `properties.lifecycle`, and the module header used to describe that as
 * deliberate. It was wrong in three ways at once and each of them was visible
 * from outside: `composition` declares no `lifecycle` property, so `get_node`
 * reported it as unknown; the spec's rule for an undeclared bag key is to
 * namespace it `<tool>:<key>`, which this was not; and a node written this way
 * carried NO `status` at all, so a view that had just been published could not
 * be found by `list_nodes({ status: 'published' })`. A lifecycle the
 * lifecycle-aware reads cannot see is not a lifecycle.
 *
 * There was never a need for a private vocabulary: `composition` has a bespoke
 * lifecycle in the spec (`grammar/lifecycles.ts`) whose three phases are exactly
 * these three things.
 *
 * `retired` IS `archived`, and `archived` is the spec's word (0.34.1). The
 * lifecycle's terminal phase is `archived`, described there as "withdrawn from
 * the published set but retained, so an existing link resolves to a view marked
 * out of date rather than to nothing" — which is precisely what this tool meant
 * by `retired`. Two names for one state is the kind of thing that reads as two
 * states six months later, so the spec's name wins and `retired` is kept as a
 * DEPRECATED input alias that maps to `archived`. Nothing that passed `retired`
 * breaks; reads report `archived`.
 */
export type CompositionLifecycle = 'draft' | 'published' | 'archived' | 'retired'

/** The lifecycle values actually STORED. `retired` is an input alias and never
 *  appears on a node. */
export type CompositionPhase = 'draft' | 'published' | 'archived'

/** Runtime membership set for `CompositionLifecycle`, for argument validation.
 *  Accepts the deprecated `retired` alias; see `normalizeCompositionLifecycle`. */
export const COMPOSITION_LIFECYCLES: readonly CompositionLifecycle[] = Object.freeze([
  'draft',
  'published',
  'archived',
  'retired',
])

/**
 * Resolve a caller's lifecycle argument to the phase that is stored.
 *
 * The only mapping is the deprecated `retired` alias onto the spec's
 * `archived`. Exported so a surface can report what it will actually write
 * before writing it.
 */
export function normalizeCompositionLifecycle(
  lifecycle: CompositionLifecycle,
): CompositionPhase {
  return lifecycle === 'retired' ? 'archived' : lifecycle
}

/**
 * A composition as read back from the store.
 *
 * `focus_node_ids` is derived from the edge set rather than held in a scalar,
 * and an EMPTY set is valid: a view scoped by query rather than by enumeration
 * focuses nothing in particular, and that is a real view, not a broken one.
 */
export interface UPGComposition {
  /** Identical to `slug`. The id IS the slug. */
  id: string
  slug: string
  title: string
  description?: string
  lifecycle: CompositionLifecycle
  /** Targets of `composition_focuses_node`, sorted. May legitimately be empty. */
  focus_node_ids: string[]
  /** The frozen arrangement. Empty until the view has been published once. */
  members: CompositionMember[]
  member_query?: UPGViewQuery
  presentation?: UPGViewPresentation
  /** Monotonic published revision. `0` means never published. */
  rev: number
  published_by?: string
  published_at?: string
}

export interface UpsertCompositionInput {
  /** The slug, which is also the node id. */
  slug: string
  title: string
  description?: string
  lifecycle: CompositionLifecycle
  /**
   * Nodes this view focuses. BEST-EFFORT: an id that does not resolve in this
   * graph is DROPPED rather than written as a dangling edge.
   */
  focus_node_ids?: string[]
  /**
   * The frozen arrangement to store. **Omit to leave the stored members
   * untouched.** Retiring or renaming a view must not silently erase what it
   * looked like, and a caller that only knows about lifecycle should not have to
   * round-trip members to avoid destroying them. `[]` explicitly clears.
   */
  members?: CompositionMember[]
  /** Declarative selection driving membership. Omit to leave the stored one alone. */
  member_query?: UPGViewQuery
  /** Advisory rendering intent. Omit to leave the stored one alone. */
  presentation?: UPGViewPresentation
  published_by?: string
  /**
   * The revision the caller last read, as an optimistic precondition. Omit to
   * publish unconditionally.
   *
   * **This is never the value written.** The stored revision is re-derived
   * inside the write from the node as it exists at that moment, so two
   * publishers racing produce 4 then 5, never 4 twice and never a regression to
   * a number one of them was holding.
   */
  rev?: number
}

export type CompositionWriteOutcome =
  | { status: 'ok'; composition: UPGComposition }
  /** No document is loaded, so there is nothing to write into. */
  | { status: 'not_found' }
  /**
   * The FILE moved under us and could not be merged, or the slug is already
   * taken by a node of another type. Either way the write did not land and the
   * refusal names itself.
   */
  | { status: 'conflict'; reason: string }
  /**
   * Only reachable when the caller supplied `rev`: someone else published this
   * slug in between. Distinct from `conflict`, which is the file moving under
   * us. Here the file is fine and the caller's picture of the view is stale.
   * `stored_rev` is what is actually on disk, so a caller can say which.
   */
  | { status: 'stale_revision'; reason: string; stored_rev: number }
  | { status: 'error'; message: string }

/**
 * A supplied `rev` did not match what is stored.
 *
 * An exception rather than a return value for one reason: it escapes the commit
 * BEFORE the flush, so a refused publish leaves the file untouched. Not
 * rewritten with identical bytes, not restamped, not touched at all.
 * Deliberately NOT a CONFLICT, so the commit propagates it instead of reloading
 * and reapplying: reapplying a stale write is exactly what the precondition
 * exists to prevent.
 */
export class CompositionStaleRevisionError extends Error {
  constructor(readonly storedRev: number) {
    super(`Composition is at revision ${storedRev}`)
    this.name = 'CompositionStaleRevisionError'
  }
}

function isConflict(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('CONFLICT')
}

/**
 * Run a scoped mutation and persist it, BOUNDED.
 *
 * ONE reload-and-reapply on CONFLICT, then the refusal goes back to the caller.
 * The bound is the point: retrying to victory converts compare-and-swap into
 * last-writer-wins with extra steps. `mutate` is re-runnable by construction
 * (it reads what it needs from the store it is handed), so reapplying it
 * against freshly reloaded state is well defined rather than a replay of stale
 * values.
 */
async function commit(
  store: UPGFileStore,
  mutate: (s: UPGFileStore) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    mutate(store)
    await store.flush()
    return { ok: true }
  } catch (err) {
    if (!isConflict(err)) throw err
    try {
      await store.reloadFromDisk()
      mutate(store)
      await store.flush()
      return { ok: true }
    } catch (retryErr) {
      if (!isConflict(retryErr)) throw retryErr
      return { ok: false, reason: (retryErr as Error).message }
    }
  }
}

/** True when the store has a document loaded. */
function isLoaded(store: UPGFileStore): boolean {
  return Boolean(store.getDocument() as unknown)
}

/**
 * Read one composition back, or `null` when the id names nothing or names a
 * node of another type.
 *
 * `members` is read WHOLE and never rebuilt key by key: a block written by a
 * newer build keeps whatever it carries, on the same reasoning that makes
 * publish data frozen by value. Absent means never published, not broken.
 */
export function readComposition(store: UPGFileStore, id: string): UPGComposition | null {
  if (!isLoaded(store)) return null
  const node = store.getNode(id)
  if (!node || node.type !== COMPOSITION_TYPE) return null

  const props = node.properties ?? {}
  const focus: string[] = []
  for (const edge of store.getEdgesForNode(node.id)) {
    if (edge.type === COMPOSITION_FOCUS_EDGE && edge.source === node.id) focus.push(edge.target)
  }
  focus.sort()

  return {
    id: node.id,
    slug: node.id,
    title: node.title ?? 'Untitled',
    ...(node.description ? { description: node.description } : {}),
    // `status` first, `properties.lifecycle` second. The fallback reads a
    // composition written by 0.34.0, the one release that parked the phase in
    // the bag; it costs one `??` and saves those graphs a migration. A stale
    // bag key is cleared the next time the view is published.
    lifecycle: normalizeCompositionLifecycle(
      (node.status as CompositionLifecycle | undefined) ??
        (props.lifecycle as CompositionLifecycle | undefined) ??
        'draft',
    ),
    focus_node_ids: focus,
    members: Array.isArray(props.members) ? (props.members as CompositionMember[]) : [],
    ...(props.member_query ? { member_query: props.member_query as UPGViewQuery } : {}),
    ...(props.presentation ? { presentation: props.presentation as UPGViewPresentation } : {}),
    rev: Number(props.rev ?? 0),
    ...(props.published_by ? { published_by: String(props.published_by) } : {}),
    ...(props.published_at ? { published_at: String(props.published_at) } : {}),
  }
}

/** List every composition in the loaded graph, slug-ordered. */
export function listCompositions(store: UPGFileStore): UPGComposition[] {
  if (!isLoaded(store)) return []
  return store
    .getAllNodes()
    .filter((n) => n.type === COMPOSITION_TYPE)
    .map((n) => readComposition(store, n.id))
    .filter((c): c is UPGComposition => c !== null)
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * Create or republish a composition, node and focus edges in ONE commit.
 *
 * See the module header for the six semantics this carries. The short version:
 * `rev` is derived and never taken from the argument, an omitted `members`
 * preserves the stored arrangement, and a refused publish does not touch the
 * file.
 */
export async function upsertComposition(
  store: UPGFileStore,
  input: UpsertCompositionInput,
): Promise<CompositionWriteOutcome> {
  if (!isLoaded(store)) return { status: 'not_found' }

  // The id IS the slug, and this graph may already hold that id as something
  // else entirely. The publishing application mints composition slugs itself
  // and so never meets this; a caller naming an arbitrary id can, and the
  // damage is silent (a persona retitled, stamped with a revision, and wired
  // with focus edges it should not have). Refuse by name instead.
  const existingAny = store.getNode(input.slug)
  if (existingAny && existingAny.type !== COMPOSITION_TYPE) {
    return {
      status: 'conflict',
      reason:
        `"${input.slug}" is already the id of a ${existingAny.type} node ("${existingAny.title ?? 'untitled'}"). ` +
        `A composition's id IS its slug, so writing here would overwrite that node rather than create a view. ` +
        `Choose a different slug, or use update_node if you meant to edit that entity.`,
    }
  }

  let result: Awaited<ReturnType<typeof commit>>
  try {
    result = await commit(store, (s) => writeComposition(s, input))
  } catch (err) {
    if (!(err instanceof CompositionStaleRevisionError)) throw err
    return {
      status: 'stale_revision',
      stored_rev: err.storedRev,
      reason:
        `This view was published again while you were working on it. It is now at revision ${err.storedRev}. ` +
        `Re-read it with get_node, reapply your change on top of what is there, then publish.`,
    }
  }

  if (!result.ok) return { status: 'conflict', reason: result.reason }
  const saved = readComposition(store, input.slug)
  return saved
    ? { status: 'ok', composition: saved }
    : { status: 'error', message: 'Composition vanished after write' }
}

/**
 * The mutation itself. Re-runnable against a freshly reloaded store, which is
 * what makes the bounded reload-and-reapply in `commit` well defined.
 */
function writeComposition(s: UPGFileStore, input: UpsertCompositionInput): void {
  const existing = s.getNode(input.slug)
  const storedRev = Number(existing?.properties?.rev ?? 0)

  // The optimistic precondition, checked HERE rather than before the commit on
  // purpose: on a reload-and-reapply this re-reads the RELOADED node, so a
  // caller's stale picture is caught against what is actually on disk at the
  // moment of the write, not against what we read a moment earlier. Thrown
  // rather than returned so the commit never reaches its flush: a refused
  // publish must not touch the file at all, not even to rewrite it identically.
  if (input.rev !== undefined && input.rev !== storedRev) {
    throw new CompositionStaleRevisionError(storedRev)
  }

  // Re-derived, never taken from the caller. Two publishers racing produce N+1
  // then N+2; neither can regress the count or land on it twice.
  const publishing = input.lifecycle === 'published'
  const phase = normalizeCompositionLifecycle(input.lifecycle)
  const now = new Date().toISOString()
  const props: Record<string, unknown> = {
    ...(existing?.properties ?? {}),
    // An omitted field leaves the stored one alone. Withdrawing a view must not
    // erase what it looked like, nor what selects into it.
    ...(input.members !== undefined ? { members: input.members } : {}),
    ...(input.member_query !== undefined ? { member_query: input.member_query } : {}),
    ...(input.presentation !== undefined ? { presentation: input.presentation } : {}),
    rev: publishing ? storedRev + 1 : storedRev,
    ...(input.published_by ? { published_by: input.published_by } : {}),
  }
  // Both keys this writer used to park in the bag, cleared off any node that
  // carries them. `lifecycle` now lives on `status` and `updated_at` is a
  // declared base field, so leaving either behind would keep a node reporting
  // unknown properties forever. A composition written by 0.34.0 self-heals on
  // its next publish rather than needing a migration.
  delete props.lifecycle
  delete props.updated_at
  // Every (re)publish restamps this. It is the timestamp of the most recent
  // print, not of the first one.
  if (publishing) props.published_at = now

  if (existing) {
    s.updateNode(input.slug, {
      title: input.title,
      status: phase,
      updated_at: now,
      ...(input.description !== undefined ? { description: input.description } : {}),
      properties: props,
    } as Partial<UPGBaseNode>)
    // `updateNode` deep-MERGES properties, so the two deletes above would be
    // undone by the stored copy. Applied explicitly afterwards.
    s.unsetNodeProperties(input.slug, ['lifecycle', 'updated_at'])
  } else {
    s.addNode({
      id: input.slug,
      type: COMPOSITION_TYPE as UPGEntityType,
      title: input.title,
      status: phase,
      updated_at: now,
      ...(input.description ? { description: input.description } : {}),
      properties: props,
    } as UPGBaseNode)
  }

  // Focus is BEST-EFFORT and an empty set is valid: a view scoped by query
  // rather than by enumeration focuses nothing in particular, and that is a
  // real view. A focus naming a node that is not here is DROPPED rather than
  // written as a dangling edge.
  for (const edge of [...s.getEdgesForNode(input.slug)]) {
    if (edge.type === COMPOSITION_FOCUS_EDGE && edge.source === input.slug) s.removeEdge(edge.id)
  }
  for (const target of input.focus_node_ids ?? []) {
    if (!s.getNode(target)) continue
    s.addEdge({
      id: edgeId(),
      source: input.slug,
      target,
      type: COMPOSITION_FOCUS_EDGE,
    } as UPGEdge)
  }
}
