/**
 * 0.33.0 Item H (Decision 10) - `key`, `archived` and `archived_at` through the
 * SDK write surface.
 *
 * The store below has merged every `UPG_BASE_NODE_FIELDS` entry generically
 * since 0.32.2, so it was never the blocker. The SDK was: it hand-builds each
 * patch from its own arg interfaces, so an argument arriving without a matching
 * interface field is never copied and the caller gets a success envelope for a
 * write that landed nothing.
 *
 * The contract these tests pin, mirroring `graph-service` exactly:
 *
 *   field         create        update
 *   archived      accept        accept
 *   archived_at   accept        accept
 *   key           accept        REFUSE, with the reason readable
 *
 * The asymmetry is the point and is asserted as such: `key` is minted once and
 * never reused, so an update that appears to rename one is worse than an update
 * that says no.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  UPGFileStore,
  createNode,
  updateNode,
  batchCreateNodes,
  batchUpdateNodes,
  NodeKeyImmutableError,
  nodeKeyMutationRefusal,
} from '../index.js'

function fixtureDoc() {
  return {
    $upg: {
      format_version: '1.0.0',
      spec_version: '0.8.0',
      product: { id: 'p_test', title: 'Lantern' },
      counts: { nodes: 0, edges: 0 },
      provenance: { tool: 'vitest', tool_version: '0.0.0', exported_at: '2026-06-01T00:00:00.000Z' },
      integrity: { algorithm: 'sha256-128', body: '00000000000000000000000000000000' },
    },
    product: { id: 'p_test', title: 'Lantern' },
    nodes: [
      { id: 'n_feat', type: 'feature', title: 'Pantry suggestions', slug: 'pantry-suggestions', status: 'proposed' },
      { id: 'n_keyed', type: 'feature', title: 'Shelf reminders', slug: 'shelf-reminders', status: 'proposed', key: 'LTN-311' },
    ],
    edges: [],
  }
}

const tmpFiles: string[] = []

async function freshStore(): Promise<UPGFileStore> {
  const f = path.join(os.tmpdir(), `upg-keyarchive-${Date.now()}-${Math.random().toString(36).slice(2)}.upg`)
  fs.writeFileSync(f, JSON.stringify(fixtureDoc()))
  tmpFiles.push(f)
  const store = new UPGFileStore()
  await store.load(f)
  store.stopWatching()
  return store
}

afterEach(() => {
  while (tmpFiles.length) {
    const f = tmpFiles.pop()!
    for (const suffix of ['', '.lock', '.tmp']) {
      try { fs.rmSync(f + suffix, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
})

const ARCHIVED_AT = '2026-08-22T09:15:00.000Z'

// ── create: all three accepted ──────────────────────────────────────────────

describe('Item H - create accepts key, archived and archived_at', () => {
  it('createNode round-trips all three onto the stored node', async () => {
    const store = await freshStore()
    const { node } = createNode(store, {
      type: 'feature',
      title: 'Batch reorder',
      key: 'LTN-412',
      archived: true,
      archived_at: ARCHIVED_AT,
    })
    expect(node.key).toBe('LTN-412')
    expect(node.archived).toBe(true)
    expect(node.archived_at).toBe(ARCHIVED_AT)

    // Read back through the store, not the returned object, so a patch that
    // only decorated the return value would fail here.
    const stored = store.getNode(node.id)!
    expect(stored.key).toBe('LTN-412')
    expect(stored.archived).toBe(true)
    expect(stored.archived_at).toBe(ARCHIVED_AT)
  })

  it('batchCreateNodes round-trips all three', async () => {
    const store = await freshStore()
    const result = batchCreateNodes(store, {
      nodes: [
        { type: 'feature', title: 'Weekly digest', key: 'LTN-501', archived: false },
        { type: 'feature', title: 'Retired import', key: 'LTN-502', archived: true, archived_at: ARCHIVED_AT },
      ],
    })
    expect(result.ok).toBe(true)
    const created = (result as { created: Array<{ id: string }> }).created
    const first = store.getNode(created[0].id)!
    const second = store.getNode(created[1].id)!
    expect(first.key).toBe('LTN-501')
    expect(first.archived).toBe(false)
    expect(second.key).toBe('LTN-502')
    expect(second.archived).toBe(true)
    expect(second.archived_at).toBe(ARCHIVED_AT)
  })

  it('mints nothing on its own: a create without a key leaves the node keyless', async () => {
    // The minter stays in `graph-service`, which pages its reads. A second
    // unpaged minter would compute max() over a truncated set and hand a live
    // node a duplicate key, so this surface must never invent one.
    const store = await freshStore()
    const { node } = createNode(store, { type: 'feature', title: 'No key wanted' })
    expect(node.key).toBeUndefined()

    const batch = batchCreateNodes(store, { nodes: [{ type: 'feature', title: 'Also no key' }] })
    expect(batch.ok).toBe(true)
    const id = (batch as { created: Array<{ id: string }> }).created[0].id
    expect(store.getNode(id)!.key).toBeUndefined()
  })
})

// ── update: archived axis accepted ──────────────────────────────────────────

describe('Item H - update accepts archived and archived_at', () => {
  it('updateNode round-trips both onto the stored node', async () => {
    const store = await freshStore()
    const { node } = updateNode(store, {
      node_id: 'n_feat',
      archived: true,
      archived_at: ARCHIVED_AT,
    })
    expect(node.archived).toBe(true)
    expect(node.archived_at).toBe(ARCHIVED_AT)
    expect(store.getNode('n_feat')!.archived).toBe(true)
    expect(store.getNode('n_feat')!.archived_at).toBe(ARCHIVED_AT)
  })

  it('updateNode un-archives, and a null archived_at clears the timestamp', async () => {
    const store = await freshStore()
    updateNode(store, { node_id: 'n_feat', archived: true, archived_at: ARCHIVED_AT })
    updateNode(store, { node_id: 'n_feat', archived: false, archived_at: null })
    expect(store.getNode('n_feat')!.archived).toBe(false)
    expect(store.getNode('n_feat')!.archived_at).toBeNull()
  })

  it('a null archived_at is a CLEAR: the field is omitted on disk, never written as null', async () => {
    // The spec shape is absent-never-null on disk, and this is the seam
    // `graph-service` already relies on. Asserted against the serialized file
    // rather than the in-memory node, because that is where the difference
    // between "cleared" and "stored a literal null" actually shows.
    const store = await freshStore()
    updateNode(store, { node_id: 'n_feat', archived: true, archived_at: ARCHIVED_AT })
    await store.flush()
    updateNode(store, { node_id: 'n_feat', archived: false, archived_at: null })
    await store.flush()
    const onDisk = JSON.parse(fs.readFileSync(tmpFiles[tmpFiles.length - 1], 'utf-8')) as {
      nodes: Array<Record<string, unknown>>
    }
    const stored = onDisk.nodes.find((n) => n.id === 'n_feat')!
    expect(stored.archived).toBe(false)
    expect('archived_at' in stored).toBe(false)
  })

  it('batchUpdateNodes round-trips both', async () => {
    const store = await freshStore()
    const result = batchUpdateNodes(store, [
      { node_id: 'n_feat', archived: true, archived_at: ARCHIVED_AT },
      { node_id: 'n_keyed', archived: true },
    ])
    expect(result.ok).toBe(true)
    expect(store.getNode('n_feat')!.archived).toBe(true)
    expect(store.getNode('n_feat')!.archived_at).toBe(ARCHIVED_AT)
    expect(store.getNode('n_keyed')!.archived).toBe(true)
  })
})

// ── update: key refused, with the reason readable ───────────────────────────

describe('Item H - update REFUSES key and says why', () => {
  it('updateNode throws NodeKeyImmutableError naming the invariant', async () => {
    const store = await freshStore()
    let thrown: unknown
    try {
      updateNode(store, { node_id: 'n_keyed', key: 'LTN-999' } as never)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(NodeKeyImmutableError)
    const message = (thrown as Error).message
    // Assert on the TEXT, not merely that it threw. A refusal the caller cannot
    // read is the same dead end as a silent drop.
    expect(message).toMatch(/immutable/i)
    expect(message).toMatch(/never reused/i)
    expect(message).toMatch(/minted once/i)
    expect(message).toContain('n_keyed')
    expect(message).toMatch(/create_node|batch_create_nodes/)
  })

  it('the refused update changes nothing, key included', async () => {
    const store = await freshStore()
    expect(() => updateNode(store, { node_id: 'n_keyed', key: 'LTN-999', title: 'Renamed' } as never)).toThrow()
    const node = store.getNode('n_keyed')!
    expect(node.key).toBe('LTN-311')
    expect(node.title).toBe('Shelf reminders')
  })

  it('refuses the SHADOW door too: properties.key is not a way in', async () => {
    // Two doors, mirroring graph-service's `assertKeyNotMutated`. Property
    // writes are permissive about unknown keys, so without this the caller
    // refused at the front door simply learns the side door works, and a key
    // parked in `properties` reads as a key to a human and to nothing else.
    const store = await freshStore()
    let thrown: unknown
    try {
      updateNode(store, { node_id: 'n_keyed', properties: { key: 'LTN-999' } })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(NodeKeyImmutableError)
    expect((thrown as Error).message).toMatch(/immutable/i)
    // Nothing landed in either location.
    expect(store.getNode('n_keyed')!.key).toBe('LTN-311')
    expect(store.getNode('n_keyed')!.properties?.key).toBeUndefined()
  })

  it('the shadow door and the typed door give the SAME message', () => {
    const viaField = nodeKeyMutationRefusal('n_keyed', { key: 'LTN-999' })
    const viaProperties = nodeKeyMutationRefusal('n_keyed', { properties: { key: 'LTN-999' } })
    expect(viaField).not.toBeNull()
    expect(viaProperties).toBe(viaField)
    // A clean patch is not refused, so the guard cannot be a blanket veto on
    // writing properties at all.
    expect(nodeKeyMutationRefusal('n_keyed', { properties: { effort: 3 } })).toBeNull()
    expect(nodeKeyMutationRefusal('n_keyed', {})).toBeNull()
  })

  it('refuses properties.key even when the value is null or undefined-ish', async () => {
    // hasOwnProperty, not a truthiness check: `{ key: null }` in a permissive
    // property merge stores a literal null under `key`, which is the shadow
    // key in its most confusing form.
    const store = await freshStore()
    expect(() => updateNode(store, { node_id: 'n_keyed', properties: { key: null } })).toThrow(
      NodeKeyImmutableError,
    )
    expect(store.getNode('n_keyed')!.properties?.key).toBeUndefined()
  })

  it('batchUpdateNodes refuses the shadow door and lands nothing', async () => {
    const store = await freshStore()
    const result = batchUpdateNodes(store, [
      { node_id: 'n_feat', title: 'Would have landed' },
      { node_id: 'n_keyed', properties: { key: 'LTN-999' } },
    ])
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/Update at index 1/)
    expect((result as { error: string }).error).toMatch(/immutable/i)
    expect(store.getNode('n_feat')!.title).toBe('Pantry suggestions')
    expect(store.getNode('n_keyed')!.properties?.key).toBeUndefined()
  })

  it('batchUpdateNodes refuses the whole batch and lands nothing', async () => {
    const store = await freshStore()
    const result = batchUpdateNodes(store, [
      { node_id: 'n_feat', title: 'Would have landed' },
      { node_id: 'n_keyed', key: 'LTN-999' } as never,
    ])
    expect(result.ok).toBe(false)
    const error = (result as { error: string }).error
    expect(error).toMatch(/Update at index 1/)
    expect(error).toMatch(/immutable/i)
    expect(error).toMatch(/never reused/i)
    // Atomic: the earlier, otherwise-valid entry must not have been applied.
    expect(store.getNode('n_feat')!.title).toBe('Pantry suggestions')
    expect(store.getNode('n_keyed')!.key).toBe('LTN-311')
  })
})

// ── the asymmetry, asserted as the contract it is ───────────────────────────

describe('Item H - the create/update asymmetry IS the contract', () => {
  it('the same key value is accepted on create and refused on update', async () => {
    const store = await freshStore()
    const KEY = 'LTN-777'

    const { node } = createNode(store, { type: 'feature', title: 'Shared basket', key: KEY })
    expect(node.key).toBe(KEY)

    expect(() => updateNode(store, { node_id: node.id, key: KEY } as never)).toThrow(NodeKeyImmutableError)

    // Restating the key it already holds is refused too. There is no update
    // that carries a key, not even a no-op one, because a caller cannot tell a
    // tolerated no-op apart from a rename that worked.
    expect(store.getNode(node.id)!.key).toBe(KEY)
  })

  it('archived and archived_at are symmetric where key is not', async () => {
    const store = await freshStore()
    const { node } = createNode(store, {
      type: 'feature',
      title: 'Shelf audit',
      key: 'LTN-888',
      archived: true,
      archived_at: ARCHIVED_AT,
    })
    // Same three fields, same call shape, one door open and two doors open.
    expect(() => updateNode(store, { node_id: node.id, archived: false })).not.toThrow()
    expect(() => updateNode(store, { node_id: node.id, archived_at: null })).not.toThrow()
    expect(() => updateNode(store, { node_id: node.id, key: 'LTN-889' } as never)).toThrow(NodeKeyImmutableError)
  })

  it('batch doors agree with single doors on all three fields', async () => {
    const store = await freshStore()
    const created = batchCreateNodes(store, {
      nodes: [{ type: 'feature', title: 'Parity check', key: 'LTN-901', archived: true, archived_at: ARCHIVED_AT }],
    })
    expect(created.ok).toBe(true)
    const id = (created as { created: Array<{ id: string }> }).created[0].id

    const okUpdate = batchUpdateNodes(store, [{ node_id: id, archived: false }])
    expect(okUpdate.ok).toBe(true)

    const refused = batchUpdateNodes(store, [{ node_id: id, key: 'LTN-902' } as never])
    expect(refused.ok).toBe(false)
    expect(store.getNode(id)!.key).toBe('LTN-901')
  })
})
