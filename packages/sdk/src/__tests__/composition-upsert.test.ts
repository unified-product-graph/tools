/**
 * Composition write semantics (0.34.0).
 *
 * The primitive behind `upsert_composition`. Five behaviours are easy to get
 * wrong and are the reason the tool exists at all, so each gets a test that
 * fails loudly if it regresses:
 *
 *   1. `rev` is DERIVED inside the write and never taken from the argument.
 *      This is the whole justification for the tool: an agent republishing via
 *      the generic `update_node({ properties: { rev: N } })` writes whatever
 *      number it happens to hold, which is not merely unhelpful but WRONG, and
 *      silently so.
 *   2. A supplied `rev` is an optimistic PRECONDITION. A mismatch returns
 *      `stale_revision` carrying `stored_rev`, never a silent overwrite.
 *   3. A refused publish leaves the file BYTE-UNCHANGED. Not rewritten with
 *      identical bytes, not restamped: untouched.
 *   4. Omitting `members` PRESERVES the stored arrangement; `[]` clears it. The
 *      two are different instructions and the difference has to survive.
 *   5. A focus id that does not resolve is DROPPED rather than written as a
 *      dangling edge.
 *
 * Fixture is a fictional product ("Larkfield Tools"); no real companies,
 * people, or brands.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { UPGFileStore } from '../index.js'
import {
  upsertComposition,
  readComposition,
  listCompositions,
  COMPOSITION_FOCUS_EDGE,
} from '../lib/composition.js'
import type { UPGBaseNode, UPGEdge, CompositionMember } from '@unified-product-graph/core'

// ── Fixture ─────────────────────────────────────────────────────────────────

function fixtureDoc() {
  return {
    $upg: {
      format_version: '1.0.0',
      spec_version: '0.8.0',
      product: { id: 'p_larkfield', title: 'Larkfield Tools' },
      counts: { nodes: 0, edges: 0 },
      provenance: {
        tool: 'vitest',
        tool_version: '0.0.0',
        exported_at: '2026-08-01T00:00:00.000Z',
      },
      integrity: { algorithm: 'sha256-128', body: '00000000000000000000000000000000' },
    },
    product: { id: 'p_larkfield', title: 'Larkfield Tools' },
    nodes: [
      { id: 'n_surveyor', type: 'persona', title: 'Field Surveyor' },
      { id: 'n_dispatcher', type: 'persona', title: 'Depot Dispatcher' },
      { id: 'n_route', type: 'feature', title: 'Route planner' },
    ] as UPGBaseNode[],
    edges: [] as UPGEdge[],
  }
}

const cleanupDirs: string[] = []
function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `upg-${tag}-`))
  cleanupDirs.push(d)
  return d
}

afterEach(() => {
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop()!
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/** A loaded, save-capable store with the watcher stopped, so writes are deterministic. */
async function openStore(tag: string): Promise<{ store: UPGFileStore; file: string }> {
  const dir = tmpDir(tag)
  const file = path.join(dir, 'larkfield.upg')
  fs.writeFileSync(file, JSON.stringify(fixtureDoc()))
  const store = new UPGFileStore()
  await store.load(file)
  store.stopWatching()
  return { store, file }
}

function member(id: string, title: string, x: number): CompositionMember {
  return { id, href: `/view/${id}`, title, x, y: 0, width: 6, height: 4 }
}

function focusEdges(store: UPGFileStore, slug: string): UPGEdge[] {
  return store
    .getEdgesForNode(slug)
    .filter((e) => e.type === COMPOSITION_FOCUS_EDGE && e.source === slug)
}

// ── 1. rev is derived, never taken from the argument ─────────────────────────

describe('rev is derived inside the write, never taken from the argument', () => {
  it('starts at 0 for a draft and only a publish increments it', async () => {
    const { store } = await openStore('rev-derive')

    const draft = await upsertComposition(store, {
      slug: 'delivery-board',
      title: 'Delivery board',
      lifecycle: 'draft',
    })
    expect(draft.status).toBe('ok')
    // Never published: a revision of 0 is the statement that no print exists.
    expect(readComposition(store, 'delivery-board')?.rev).toBe(0)

    // A second draft write does not bump it. `rev` counts prints, not saves.
    await upsertComposition(store, {
      slug: 'delivery-board',
      title: 'Delivery board v2',
      lifecycle: 'draft',
    })
    expect(readComposition(store, 'delivery-board')?.rev).toBe(0)

    await upsertComposition(store, {
      slug: 'delivery-board',
      title: 'Delivery board',
      lifecycle: 'published',
    })
    expect(readComposition(store, 'delivery-board')?.rev).toBe(1)
    expect(readComposition(store, 'delivery-board')?.published_at).toBeTruthy()

    // Republishing the same slug bumps rather than moving phase.
    await upsertComposition(store, {
      slug: 'delivery-board',
      title: 'Delivery board',
      lifecycle: 'published',
    })
    const twice = readComposition(store, 'delivery-board')
    expect(twice?.rev).toBe(2)
    expect(twice?.lifecycle).toBe('published')
  })

  it('IGNORES the supplied rev as a value: a matching precondition still derives N+1', async () => {
    const { store } = await openStore('rev-not-value')

    // This is the failure the tool exists to prevent. A caller holding rev 0 and
    // passing it must land on 1, not on 0. If the argument were ever written
    // through, this composition would sit at 0 while being live at its slug.
    await upsertComposition(store, {
      slug: 'weekly-rollup',
      title: 'Weekly rollup',
      lifecycle: 'published',
      rev: 0,
    })
    expect(readComposition(store, 'weekly-rollup')?.rev).toBe(1)

    await upsertComposition(store, {
      slug: 'weekly-rollup',
      title: 'Weekly rollup',
      lifecycle: 'published',
      rev: 1,
    })
    expect(readComposition(store, 'weekly-rollup')?.rev).toBe(2)
  })

  it('cannot be regressed: a stale caller is refused rather than allowed to write a lower number', async () => {
    const { store } = await openStore('rev-no-regress')

    for (let i = 0; i < 3; i++) {
      await upsertComposition(store, {
        slug: 'launch-wall',
        title: 'Launch wall',
        lifecycle: 'published',
      })
    }
    expect(readComposition(store, 'launch-wall')?.rev).toBe(3)

    // A caller still holding rev 1 attempts to publish. Under a written-through
    // `rev` this would set the count BACKWARDS to 2 and lose two prints.
    const stale = await upsertComposition(store, {
      slug: 'launch-wall',
      title: 'Launch wall',
      lifecycle: 'published',
      rev: 1,
    })
    expect(stale.status).toBe('stale_revision')
    expect(readComposition(store, 'launch-wall')?.rev).toBe(3)
  })
})

// ── 2. rev as an optimistic precondition ─────────────────────────────────────

describe('a supplied rev is a precondition, and a mismatch names itself', () => {
  it('returns stale_revision carrying stored_rev, not a silent overwrite', async () => {
    const { store } = await openStore('rev-precondition')

    await upsertComposition(store, {
      slug: 'ops-review',
      title: 'Ops review',
      lifecycle: 'published',
      members: [member('blk_1', 'Open incidents', 0)],
    })
    // A second publisher lands while our caller is still working.
    await upsertComposition(store, {
      slug: 'ops-review',
      title: 'Ops review',
      lifecycle: 'published',
      members: [member('blk_2', 'Closed incidents', 6)],
    })
    expect(readComposition(store, 'ops-review')?.rev).toBe(2)

    const outcome = await upsertComposition(store, {
      slug: 'ops-review',
      title: 'Ops review (my edit)',
      lifecycle: 'published',
      members: [member('blk_3', 'My arrangement', 0)],
      rev: 1,
    })

    expect(outcome).toMatchObject({ status: 'stale_revision', stored_rev: 2 })

    // Nothing of the refused write landed: not the title, not the arrangement.
    const stored = readComposition(store, 'ops-review')
    expect(stored?.title).toBe('Ops review')
    expect(stored?.members.map((m) => m.id)).toEqual(['blk_2'])
    expect(stored?.rev).toBe(2)
  })

  it('publishes unconditionally when rev is omitted', async () => {
    const { store } = await openStore('rev-omitted')

    await upsertComposition(store, {
      slug: 'ops-review',
      title: 'Ops review',
      lifecycle: 'published',
    })
    const outcome = await upsertComposition(store, {
      slug: 'ops-review',
      title: 'Ops review',
      lifecycle: 'published',
    })
    expect(outcome.status).toBe('ok')
    expect(readComposition(store, 'ops-review')?.rev).toBe(2)
  })
})

// ── 3. a refused publish leaves the file byte-unchanged ──────────────────────

describe('a refused publish does not touch the file', () => {
  it('leaves the bytes on disk BYTE-IDENTICAL, not rewritten identically', async () => {
    const { store, file } = await openStore('rev-bytes')

    await upsertComposition(store, {
      slug: 'field-digest',
      title: 'Field digest',
      lifecycle: 'published',
      members: [member('blk_1', 'Recent visits', 0)],
      focus_node_ids: ['n_surveyor'],
    })
    await store.flush()

    const before = fs.readFileSync(file)
    const beforeMtime = fs.statSync(file).mtimeMs

    const refused = await upsertComposition(store, {
      slug: 'field-digest',
      title: 'Field digest (stale edit)',
      lifecycle: 'published',
      members: [],
      focus_node_ids: [],
      rev: 0,
    })
    expect(refused).toMatchObject({ status: 'stale_revision', stored_rev: 1 })

    // The precondition is checked INSIDE the commit and thrown rather than
    // returned, precisely so the flush is never reached. A restamped
    // `updated_at` or a re-serialised body would both show up here.
    const after = fs.readFileSync(file)
    expect(after.equals(before)).toBe(true)
    expect(fs.statSync(file).mtimeMs).toBe(beforeMtime)
  })
})

// ── 4. omitted members preserve, [] clears ───────────────────────────────────

describe('omitting members preserves the arrangement; [] clears it', () => {
  it('retiring a view keeps what it looked like', async () => {
    const { store } = await openStore('members-preserve')

    await upsertComposition(store, {
      slug: 'depot-board',
      title: 'Depot board',
      lifecycle: 'published',
      members: [member('blk_1', 'Awaiting pickup', 0), member('blk_2', 'On route', 6)],
    })

    // The retire path knows about lifecycle and nothing else. It must not have
    // to round-trip members to avoid destroying them.
    const retired = await upsertComposition(store, {
      slug: 'depot-board',
      title: 'Depot board',
      lifecycle: 'retired',
    })
    expect(retired.status).toBe('ok')

    const stored = readComposition(store, 'depot-board')
    // 0.34.1: `retired` is a deprecated alias for the composition lifecycle's
    // terminal phase, stored and read back as `archived`.
    expect(stored?.lifecycle).toBe('archived')
    expect(stored?.members.map((m) => m.id)).toEqual(['blk_1', 'blk_2'])
    // Retiring is not a publish, so the revision does not move.
    expect(stored?.rev).toBe(1)
  })

  it('an explicit empty array is a different instruction and clears them', async () => {
    const { store } = await openStore('members-clear')

    await upsertComposition(store, {
      slug: 'depot-board',
      title: 'Depot board',
      lifecycle: 'published',
      members: [member('blk_1', 'Awaiting pickup', 0)],
    })
    await upsertComposition(store, {
      slug: 'depot-board',
      title: 'Depot board',
      lifecycle: 'published',
      members: [],
    })

    expect(readComposition(store, 'depot-board')?.members).toEqual([])
  })

  it('round-trips a member block whole, including keys this build does not name', async () => {
    const { store } = await openStore('members-roundtrip')

    const forward = {
      ...member('blk_1', 'Awaiting pickup', 0),
      derived: true,
      // A block written by a newer build. Publish data is frozen BY VALUE, so
      // silently dropping half of it on republish is the worst failure available.
      lane_hint: 'left',
    } as CompositionMember

    await upsertComposition(store, {
      slug: 'depot-board',
      title: 'Depot board',
      lifecycle: 'published',
      members: [forward],
    })

    expect(readComposition(store, 'depot-board')?.members[0]).toEqual(forward)
  })

  it('leaves member_query and presentation alone when they are omitted', async () => {
    const { store } = await openStore('query-preserve')

    await upsertComposition(store, {
      slug: 'open-work',
      title: 'Open work',
      lifecycle: 'published',
      member_query: { types: ['task'], status_category: ['started'] },
      presentation: { layout: 'tree', nest_by: ['epic_contains_task'], orphan_disposition: 'hide' },
    })

    await upsertComposition(store, {
      slug: 'open-work',
      title: 'Open work',
      lifecycle: 'retired',
    })

    const stored = readComposition(store, 'open-work')
    expect(stored?.member_query).toEqual({ types: ['task'], status_category: ['started'] })
    expect(stored?.presentation).toEqual({
      layout: 'tree',
      nest_by: ['epic_contains_task'],
      orphan_disposition: 'hide',
    })
  })
})

// ── 5. focus is best-effort; an unresolvable id is dropped ───────────────────

describe('focus is best-effort and never written dangling', () => {
  it('drops a focus id that does not resolve rather than writing a dangling edge', async () => {
    const { store } = await openStore('focus-drop')

    const outcome = await upsertComposition(store, {
      slug: 'persona-wall',
      title: 'Persona wall',
      lifecycle: 'published',
      focus_node_ids: ['n_surveyor', 'n_ghost', 'n_dispatcher'],
    })
    expect(outcome.status).toBe('ok')

    const stored = readComposition(store, 'persona-wall')
    expect(stored?.focus_node_ids).toEqual(['n_dispatcher', 'n_surveyor'])

    // The proof that matters is at the edge layer: nothing points at n_ghost.
    const edges = focusEdges(store, 'persona-wall')
    expect(edges).toHaveLength(2)
    expect(edges.every((e) => store.getNode(e.target) !== undefined)).toBe(true)
    expect(store.getAllEdges().some((e) => e.target === 'n_ghost')).toBe(false)
  })

  it('treats an empty focus set as valid, not as a broken view', async () => {
    const { store } = await openStore('focus-empty')

    const outcome = await upsertComposition(store, {
      slug: 'query-only',
      title: 'Query-only view',
      lifecycle: 'published',
      member_query: { types: ['task'] },
    })
    expect(outcome.status).toBe('ok')
    expect(readComposition(store, 'query-only')?.focus_node_ids).toEqual([])
  })

  it('replaces the focus set on republish rather than accumulating it', async () => {
    const { store } = await openStore('focus-replace')

    await upsertComposition(store, {
      slug: 'persona-wall',
      title: 'Persona wall',
      lifecycle: 'published',
      focus_node_ids: ['n_surveyor', 'n_dispatcher'],
    })
    await upsertComposition(store, {
      slug: 'persona-wall',
      title: 'Persona wall',
      lifecycle: 'published',
      focus_node_ids: ['n_route'],
    })

    expect(readComposition(store, 'persona-wall')?.focus_node_ids).toEqual(['n_route'])
    expect(focusEdges(store, 'persona-wall')).toHaveLength(1)
  })
})

// ── The node and its edges are written together ──────────────────────────────

describe('the node and its focus edges land in one commit', () => {
  it('a fresh publish persists both to disk in a single flush', async () => {
    const { store, file } = await openStore('atomic-write')

    await upsertComposition(store, {
      slug: 'route-review',
      title: 'Route review',
      description: 'What the dispatchers look at on Monday.',
      lifecycle: 'published',
      focus_node_ids: ['n_route'],
      published_by: 'sam.patel@larkfield.example',
    })
    await store.flush()

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as ReturnType<typeof fixtureDoc>
    const node = onDisk.nodes.find((n) => n.id === 'route-review')
    expect(node?.type).toBe('composition')
    expect(node?.title).toBe('Route review')
    expect(onDisk.edges.filter((e) => e.type === COMPOSITION_FOCUS_EDGE)).toHaveLength(1)

    // The id IS the slug: no surrogate was minted.
    const stored = readComposition(store, 'route-review')
    expect(stored?.id).toBe('route-review')
    expect(stored?.slug).toBe('route-review')
    expect(stored?.published_by).toBe('sam.patel@larkfield.example')
  })
})

// ── Refusals that are not the file moving under us ───────────────────────────

describe('stated refusals', () => {
  it('refuses a slug already held by a node of another type, leaving it untouched', async () => {
    const { store } = await openStore('slug-taken')

    const outcome = await upsertComposition(store, {
      slug: 'n_route',
      title: 'Route review',
      lifecycle: 'published',
    })

    expect(outcome.status).toBe('conflict')
    // The damage this prevents is silent: a feature retitled, stamped with a
    // revision, and wired with focus edges it should never have.
    const untouched = store.getNode('n_route')
    expect(untouched?.type).toBe('feature')
    expect(untouched?.title).toBe('Route planner')
    expect(untouched?.properties?.rev).toBeUndefined()
  })

  it('returns not_found when no graph is loaded', async () => {
    const empty = new UPGFileStore()
    const outcome = await upsertComposition(empty, {
      slug: 'nowhere',
      title: 'Nowhere',
      lifecycle: 'draft',
    })
    expect(outcome).toEqual({ status: 'not_found' })
    expect(readComposition(empty, 'nowhere')).toBeNull()
    expect(listCompositions(empty)).toEqual([])
  })
})

// ── Reads stay generic, which is why only the write got a tool ───────────────

describe('the generic read surface already reaches compositions', () => {
  it('lists them slug-ordered and reads one back by slug', async () => {
    const { store } = await openStore('generic-reads')

    await upsertComposition(store, { slug: 'zulu-board', title: 'Zulu board', lifecycle: 'draft' })
    await upsertComposition(store, { slug: 'alpha-board', title: 'Alpha board', lifecycle: 'published' })

    expect(listCompositions(store).map((c) => c.slug)).toEqual(['alpha-board', 'zulu-board'])
    // The same nodes are reachable through the plain node surface, which is the
    // argument for not minting list_compositions / get_composition tools.
    expect(store.getAllNodes().filter((n) => n.type === 'composition')).toHaveLength(2)
    expect(store.getNode('alpha-board')?.properties?.rev).toBe(1)
  })
})
