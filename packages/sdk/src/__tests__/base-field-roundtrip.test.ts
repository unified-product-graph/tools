/**
 * 0.32.2 regression: every `UPGBaseNode` top-level field must round-trip
 * through `UPGFileStore.updateNode`, and an undeclared field must be REFUSED
 * rather than dropped under a success.
 *
 * The defect: `updateNode` merged a hand-maintained list
 * (type/title/description/tags/status/slug/aliases) and returned the unchanged
 * node for anything else. 0.32.0 added `key`, `archived` and `archived_at` to
 * the shape, so a patch carrying any of them landed nothing and reported
 * success. The key-minting contention loop in the local graph-service adapter
 * hit exactly this and exhausted its retry budget re-minting a key that could
 * never move, which is how the bug surfaced.
 *
 * Companion: the same missing three made `computeSchemaDriftSummary` report a
 * node holding a minted key as carrying a non-spec top-level field. Covered
 * below so the counter and the merger stay locked to one source.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { UPGFileStore, UnknownNodeFieldError, ImmutableNodeFieldError } from '../index.js'
import { computeSchemaDriftSummary } from '../lib/schema-drift.js'
import { UPG_BASE_NODE_FIELDS } from '@unified-product-graph/core'

function fixtureDoc() {
  return {
    $upg: {
      format_version: '1.0.0',
      spec_version: '0.8.0',
      product: { id: 'p_test', title: 'TestProduct' },
      counts: { nodes: 0, edges: 0 },
      provenance: { tool: 'vitest', tool_version: '0.0.0', exported_at: '2026-06-01T00:00:00.000Z' },
      integrity: { algorithm: 'sha256-128', body: '00000000000000000000000000000000' },
    },
    product: { id: 'p_test', title: 'TestProduct' },
    nodes: [{ id: 'n_task', type: 'task', title: 'Ship the patch', slug: 'ship-the-patch' }],
    edges: [],
  }
}

const cleanups: string[] = []
function writeTmpFixture(doc: unknown = fixtureDoc()): string {
  const f = path.join(os.tmpdir(), `upg-basefield-${Date.now()}-${Math.random().toString(36).slice(2)}.upg`)
  fs.writeFileSync(f, JSON.stringify(doc))
  cleanups.push(f)
  return f
}

afterEach(() => {
  while (cleanups.length) {
    const f = cleanups.pop()!
    for (const suffix of ['', '.lock', '.tmp']) {
      try { fs.rmSync(f + suffix, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
})

async function loadedStore(doc: unknown = fixtureDoc()): Promise<UPGFileStore> {
  const store = new UPGFileStore()
  await store.load(writeTmpFixture(doc))
  return store
}

describe('updateNode round-trips the 0.32.0 base fields', () => {
  it('writes key, archived and archived_at, and reads them back', async () => {
    const store = await loadedStore()
    const at = '2026-08-21T09:00:00.000Z'

    const returned = store.updateNode('n_task', { key: 'LTN-311', archived: true, archived_at: at })

    // The returned node and the stored node are the same object; assert on the
    // independent read too, because the old bug returned a plausible node.
    expect(returned.key).toBe('LTN-311')
    const stored = store.getNode('n_task')!
    expect(stored.key).toBe('LTN-311')
    expect(stored.archived).toBe(true)
    expect(stored.archived_at).toBe(at)
  })

  it('survives a save/reload cycle (the field reaches the file, not just memory)', async () => {
    const file = writeTmpFixture()
    const store = new UPGFileStore()
    await store.load(file)
    store.updateNode('n_task', { key: 'LTN-312', archived: true })
    await store.flush()

    const reloaded = new UPGFileStore()
    await reloaded.load(file)
    const node = reloaded.getNode('n_task')!
    expect(node.key).toBe('LTN-312')
    expect(node.archived).toBe(true)
  })

  it('un-archives (a false value is a write, not an absent patch)', async () => {
    const store = await loadedStore()
    store.updateNode('n_task', { archived: true })
    store.updateNode('n_task', { archived: false })
    expect(store.getNode('n_task')!.archived).toBe(false)
  })

  it('round-trips EVERY declared base field, so a new spec field cannot be dropped', async () => {
    // Derived from the shape rather than listed, which is the point of the fix:
    // adding a field to UPGBaseNode extends this test automatically.
    const sample: Record<string, unknown> = {
      slug: 'renamed-task',
      aliases: ['ship-the-patch'],
      key: 'LTN-400',
      description: 'A description.',
      tags: ['alpha'],
      status: 'todo',
      archived: true,
      archived_at: '2026-08-21T09:00:00.000Z',
      source_id: 'ext-1',
      source_type: 'issue',
      mapping_confidence: 'high',
      external_tool: 'linear',
      external_ref: 'https://example.invalid/LTN-400',
      external_id: 'lin_1',
      title: 'Retitled',
    }
    // id, type and properties are excluded: identity, migration-routed, and
    // deep-merged respectively. Each has its own coverage.
    const skip = new Set(['id', 'type', 'properties'])
    const covered = UPG_BASE_NODE_FIELDS.filter((f) => !skip.has(f))
    expect(covered.every((f) => f in sample)).toBe(true)

    const store = await loadedStore()
    store.updateNode('n_task', sample)
    const node = store.getNode('n_task') as unknown as Record<string, unknown>
    for (const field of covered) {
      expect(node[field], `field "${field}" did not round-trip`).toEqual(sample[field])
    }
  })

  it('still deep-merges properties and still rotates slug into aliases', async () => {
    const store = await loadedStore()
    store.updateNode('n_task', { properties: { a: 1 } })
    store.updateNode('n_task', { properties: { b: 2 }, slug: 'new-slug' })
    const node = store.getNode('n_task')!
    expect(node.properties).toEqual({ a: 1, b: 2 })
    expect(node.slug).toBe('new-slug')
    expect(node.aliases).toContain('ship-the-patch')
  })
})

describe('updateNode refuses what it cannot store', () => {
  it('throws UnknownNodeFieldError on an undeclared top-level field', async () => {
    const store = await loadedStore()
    expect(() => store.updateNode('n_task', { assignee: 'nobody' } as never)).toThrow(UnknownNodeFieldError)
  })

  it('names the offending field and does not mutate the node', async () => {
    const store = await loadedStore()
    let caught: unknown
    try {
      store.updateNode('n_task', { title: 'Changed', assignee: 'nobody' } as never)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UnknownNodeFieldError)
    expect((caught as UnknownNodeFieldError).fields).toEqual(['assignee'])
    // The refusal is all-or-nothing: the valid half of the patch must not land.
    expect(store.getNode('n_task')!.title).toBe('Ship the patch')
  })

  it('refuses an id change but allows id to be restated', async () => {
    const store = await loadedStore()
    expect(() => store.updateNode('n_task', { id: 'n_other' })).toThrow(ImmutableNodeFieldError)
    expect(() => store.updateNode('n_task', { id: 'n_task', title: 'Fine' })).not.toThrow()
    expect(store.getNode('n_task')!.title).toBe('Fine')
  })
})

describe('schema drift does not flag the 0.32.0 base fields', () => {
  it('reports no top_level_drift for a node holding key, archived and archived_at', async () => {
    const doc = fixtureDoc()
    doc.nodes = [
      {
        id: 'n_task',
        type: 'task',
        title: 'Ship the patch',
        slug: 'ship-the-patch',
        key: 'LTN-311',
        archived: true,
        archived_at: '2026-08-21T09:00:00.000Z',
      } as never,
    ]
    const store = await loadedStore(doc)
    const summary = computeSchemaDriftSummary(store.getDocument())
    expect(summary.top_level_drift).toBe(0)
  })

  it('still flags a genuinely non-spec top-level field', async () => {
    // The counter must not have been widened into uselessness.
    const doc = fixtureDoc()
    doc.nodes = [
      { id: 'n_task', type: 'task', title: 'Ship the patch', assignee: 'nobody' } as never,
    ]
    const store = await loadedStore(doc)
    expect(computeSchemaDriftSummary(store.getDocument()).top_level_drift).toBe(1)
  })
})
