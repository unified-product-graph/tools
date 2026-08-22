/**
 * R4 — within-product `key` uniqueness, enforced on the create path.
 *
 * `UPGBaseNode.key` has declared uniqueness within the product across entity
 * types since 0.32.0, and until 0.34.1 nothing checked it: two `create_node`
 * calls naming one key both succeeded, with no warning. That mattered beyond
 * the collision itself, because 0.34.0 shipped `duplicate-key-across-products`
 * as a PORTFOLIO-scope anti-pattern whose stated premise is that the
 * per-product invariant holds. It rested on an invariant nothing enforced.
 *
 * The refusal is a typed error and NOT a silent no-key: the minting rules drop
 * a key in silence only when nobody asked for one (an inferred prefix in a
 * second product). Here the caller NAMED the key, so a drop would return
 * success for a node with no citation.
 *
 * A graph that ALREADY holds a collision must still load and validate
 * unchanged — the check is on create, not on open.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore, DuplicateNodeKeyError } from '@unified-product-graph/sdk'
import { createNode, batchCreateNodes, getNode, deleteNode } from '../tools/nodes.js'
import { validateGraph } from '../tools/validation.js'
import type { UPGDocument } from '@unified-product-graph/core'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

function makeDoc(nodes: UPGDocument['nodes'] = []): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Test Product', stage: 'concept' },
    nodes,
    edges: [],
  }
}

async function makeStore(nodes: UPGDocument['nodes'] = []): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-key-uniqueness-test-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(makeDoc(nodes), null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching()
  return store
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

async function parse(result: unknown) {
  const r = (await Promise.resolve(result)) as {
    isError?: boolean
    content: Array<{ text: string }>
  }
  if (r.isError) return { error: r.content[0].text }
  return JSON.parse(r.content[0].text)
}

describe('create_node: duplicate key (R4)', () => {
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    store = await makeStore()
    ctx = makeCtx(store)
  })

  it('accepts the first node to claim a key', async () => {
    const res = await parse(
      createNode({ type: 'task', title: 'AUDIT key A', key: 'DUP-1' }, ctx),
    )
    expect(res.error).toBeUndefined()
    expect(res.node.key).toBe('DUP-1')
  })

  it('REFUSES the second, naming the node that holds the key', async () => {
    const first = await parse(
      createNode({ type: 'task', title: 'AUDIT key A', key: 'DUP-1' }, ctx),
    )
    const second = await parse(
      createNode({ type: 'task', title: 'AUDIT key B', key: 'DUP-1' }, ctx),
    )
    expect(second.error).toBeDefined()
    expect(second.node).toBeUndefined()
    expect(second.error).toBe(
      new DuplicateNodeKeyError('DUP-1', first.node.id, 'AUDIT key A').message,
    )
  })

  it('refuses across entity types, because the scope is the product', async () => {
    await parse(createNode({ type: 'task', title: 'A task', key: '' }, ctx))
    const other = await parse(
      createNode({ type: 'bug', title: 'A bug', key: '' }, ctx),
    )
    expect(other.error).toBeDefined()
  })

  it('writes nothing when it refuses', async () => {
    await parse(createNode({ type: 'task', title: 'Holder', key: 'DUP-2' }, ctx))
    const before = store.getAllNodes().length
    await parse(createNode({ type: 'task', title: 'Refused', key: 'DUP-2' }, ctx))
    expect(store.getAllNodes().length).toBe(before)
  })

  it('leaves un-keyed creates alone: many nodes may carry no key', async () => {
    const a = await parse(createNode({ type: 'task', title: 'No key A' }, ctx))
    const b = await parse(createNode({ type: 'task', title: 'No key B' }, ctx))
    expect(a.error).toBeUndefined()
    expect(b.error).toBeUndefined()
  })

  it('frees the key again when the holder is deleted', async () => {
    const first = await parse(
      createNode({ type: 'task', title: 'Holder', key: 'DUP-3' }, ctx),
    )
    await parse(deleteNode({ node_id: first.node.id }, ctx))
    const reuse = await parse(
      createNode({ type: 'task', title: 'Successor', key: 'DUP-3' }, ctx),
    )
    expect(reuse.error).toBeUndefined()
    expect(reuse.node.key).toBe('DUP-3')
  })
})

describe('batch_create_nodes: duplicate key (R4)', () => {
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    store = await makeStore()
    ctx = makeCtx(store)
  })

  it('refuses a key already on disk and lands NOTHING from the batch', async () => {
    await parse(createNode({ type: 'task', title: 'Holder', key: 'DUP-1' }, ctx))
    const before = store.getAllNodes().length
    const res = await parse(
      batchCreateNodes(
        {
          nodes: [
            { type: 'jtbd', title: 'Innocent bystander' },
            { type: 'task', title: 'Collides', key: 'DUP-1' },
          ],
        },
        ctx,
      ),
    )
    expect(res.error ?? JSON.stringify(res.errors ?? [])).toMatch(/DUP-1/)
    expect(store.getAllNodes().length).toBe(before)
  })

  it('catches TWO entries of one batch claiming the same key', async () => {
    const before = store.getAllNodes().length
    const res = await parse(
      batchCreateNodes(
        {
          nodes: [
            { type: 'task', title: 'Twin A', key: 'TWIN-1' },
            { type: 'task', title: 'Twin B', key: 'TWIN-1' },
          ],
        },
        ctx,
      ),
    )
    expect(res.error ?? JSON.stringify(res.errors ?? [])).toMatch(/TWIN-1/)
    expect(store.getAllNodes().length).toBe(before)
  })

  it('applies a batch whose keys are all distinct', async () => {
    const res = await parse(
      batchCreateNodes(
        {
          nodes: [
            { type: 'task', title: 'K1', key: 'OK-1' },
            { type: 'task', title: 'K2', key: 'OK-2' },
          ],
        },
        ctx,
      ),
    )
    expect(res.error).toBeUndefined()
    expect(res.created).toHaveLength(2)
  })
})

describe('a graph that already holds a collision still opens (R4)', () => {
  it('loads, reads and validates unchanged', async () => {
    const store = await makeStore([
      { id: 'n_a', type: 'task', title: 'Legacy A', key: 'OLD-1' },
      { id: 'n_b', type: 'task', title: 'Legacy B', key: 'OLD-1' },
    ] as UPGDocument['nodes'])
    const ctx = makeCtx(store)

    expect(store.getAllNodes()).toHaveLength(2)
    const a = await parse(getNode({ node_id: 'n_a' }, ctx))
    const b = await parse(getNode({ node_id: 'n_b' }, ctx))
    expect(a.node.key).toBe('OLD-1')
    expect(b.node.key).toBe('OLD-1')

    const v = await parse(validateGraph({ skip_anti_patterns: true }, ctx))
    expect(v.error).toBeUndefined()

    // And the FIRST holder is the one the index names, so a new create still
    // gets a refusal rather than a third collision.
    const third = await parse(
      createNode({ type: 'task', title: 'Third', key: 'OLD-1' }, ctx),
    )
    expect(third.error).toBeDefined()
  })
})
