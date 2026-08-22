/**
 * R1 / R5 — the refusals `update_node` documents, exercised on the MCP surface.
 *
 * 0.32.2 shipped `UnknownNodeFieldError` and `ImmutableNodeFieldError` on
 * `UPGFileStore.updateNode` and described them as firing "on runtime-shaped
 * input such as a parsed argument bag". Through MCP they never fired: the tool
 * layer hand-built its patch from the fields it named, so an undeclared key was
 * dropped one frame above the guard and the caller was handed a success
 * envelope holding an unchanged node. A regression audit reproduced it on every
 * release 0.32.2 → 0.34.0.
 *
 * These tests hold the MCP surface to the note. They assert BYTE-IDENTICAL
 * messages against the SDK's own error classes rather than a regex, because
 * "the messages agree across SDK and MCP" is the actual contract — a paraphrase
 * on one side is the defect coming back.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UPGFileStore,
  UnknownNodeFieldError,
  ImmutableNodeFieldError,
} from '@unified-product-graph/sdk'
import { createNode, updateNode, batchUpdateNodes, getNode } from '../tools/nodes.js'
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
  const dir = mkdtempSync(join(tmpdir(), 'upg-field-contract-test-'))
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

describe('update_node: undeclared top-level fields (R1)', () => {
  let store: UPGFileStore
  let ctx: ToolContext
  let nodeId: string

  beforeEach(async () => {
    store = await makeStore()
    ctx = makeCtx(store)
    const created = await parse(
      createNode({ type: 'task', title: 'Contract Subject' }, ctx),
    )
    nodeId = created.node.id
  })

  it('refuses an undeclared top-level field instead of dropping it', async () => {
    const res = await parse(
      updateNode({ node_id: nodeId, totally_bogus_field: 'x' }, ctx),
    )
    expect(res.error).toBeDefined()
    expect(res.node).toBeUndefined()
    // Byte-identical to what the SDK throws for the same offence.
    expect(res.error).toBe(new UnknownNodeFieldError(nodeId, ['totally_bogus_field']).message)
  })

  it('names every offending key at once, not just the first', async () => {
    const res = await parse(
      updateNode({ node_id: nodeId, bogus_a: 1, bogus_b: 2 }, ctx),
    )
    expect(res.error).toBe(new UnknownNodeFieldError(nodeId, ['bogus_a', 'bogus_b']).message)
  })

  it('refuses ATOMICALLY: a legitimate field in the same bag does not land', async () => {
    await parse(updateNode({ node_id: nodeId, title: 'SHOULD NOT LAND', nope: 1 }, ctx))
    const after = await parse(getNode({ node_id: nodeId }, ctx))
    expect(after.node.title).toBe('Contract Subject')
  })

  it('still accepts a bag of only declared fields', async () => {
    const res = await parse(
      updateNode({ node_id: nodeId, title: 'Renamed', description: 'ok' }, ctx),
    )
    expect(res.error).toBeUndefined()
    expect(res.node.title).toBe('Renamed')
    expect(res.node.description).toBe('ok')
  })

  it('leaves the control arguments of the tool itself alone', async () => {
    const res = await parse(
      updateNode(
        { node_id: nodeId, title: 'Controlled', strict: false, unset_properties: [] },
        ctx,
      ),
    )
    expect(res.error).toBeUndefined()
    expect(res.node.title).toBe('Controlled')
  })
})

describe('update_node: id is immutable (R1)', () => {
  let store: UPGFileStore
  let ctx: ToolContext
  let nodeId: string

  beforeEach(async () => {
    store = await makeStore()
    ctx = makeCtx(store)
    const created = await parse(createNode({ type: 'task', title: 'Identity' }, ctx))
    nodeId = created.node.id
  })

  it('refuses a changed id with ImmutableNodeFieldError', async () => {
    const res = await parse(updateNode({ node_id: nodeId, id: 'n_HIJACKED' }, ctx))
    expect(res.error).toBe(
      new ImmutableNodeFieldError(nodeId, 'id', nodeId, 'n_HIJACKED').message,
    )
    const after = await parse(getNode({ node_id: nodeId }, ctx))
    expect(after.node.id).toBe(nodeId)
  })

  it('allows a RE-STATED id, so spreading a whole node into a patch still works', async () => {
    const res = await parse(
      updateNode({ node_id: nodeId, id: nodeId, title: 'Spread' }, ctx),
    )
    expect(res.error).toBeUndefined()
    expect(res.node.title).toBe('Spread')
  })
})

describe('update_node: base fields round-trip through the wire path (R5)', () => {
  let store: UPGFileStore
  let ctx: ToolContext
  let nodeId: string

  beforeEach(async () => {
    store = await makeStore()
    ctx = makeCtx(store)
    const created = await parse(
      createNode({ type: 'task', title: 'Keyed', key: 'AUD-1' }, ctx),
    )
    nodeId = created.node.id
  })

  it('create_node lands `key`', async () => {
    const after = await parse(getNode({ node_id: nodeId }, ctx))
    expect(after.node.key).toBe('AUD-1')
  })

  it('update_node lands `archived` and `archived_at`', async () => {
    const res = await parse(
      updateNode(
        { node_id: nodeId, archived: true, archived_at: '2026-08-22T01:00:00.000Z' },
        ctx,
      ),
    )
    expect(res.error).toBeUndefined()
    const after = await parse(getNode({ node_id: nodeId }, ctx))
    expect(after.node.archived).toBe(true)
    expect(after.node.archived_at).toBe('2026-08-22T01:00:00.000Z')
  })

  it('update_node still refuses `key`, through the field door', async () => {
    const res = await parse(updateNode({ node_id: nodeId, key: 'AUD-2' }, ctx))
    expect(res.error).toBeDefined()
    const after = await parse(getNode({ node_id: nodeId }, ctx))
    expect(after.node.key).toBe('AUD-1')
  })

  it('a base field added to the shape needs no edit here: external_links round-trips', async () => {
    const res = await parse(
      updateNode(
        {
          node_id: nodeId,
          external_links: [{ url: 'https://example.invalid/pr/1', kind: 'pull_request' }],
        },
        ctx,
      ),
    )
    expect(res.error).toBeUndefined()
    const after = await parse(getNode({ node_id: nodeId }, ctx))
    expect(after.node.external_links).toEqual([
      { url: 'https://example.invalid/pr/1', kind: 'pull_request' },
    ])
  })
})

describe('batch_update_nodes: the same refusals, in the pre-pass (R1)', () => {
  let store: UPGFileStore
  let ctx: ToolContext
  let a: string
  let b: string

  beforeEach(async () => {
    store = await makeStore()
    ctx = makeCtx(store)
    a = (await parse(createNode({ type: 'task', title: 'Batch A' }, ctx))).node.id
    b = (await parse(createNode({ type: 'task', title: 'Batch B' }, ctx))).node.id
  })

  it('refuses an undeclared field and lands NOTHING from the batch', async () => {
    const res = await parse(
      batchUpdateNodes(
        {
          updates: [
            { node_id: b, title: 'SHOULD NOT LAND' },
            { node_id: a, nonsense_field: 'x' },
          ],
        },
        ctx,
      ),
    )
    expect(res.error).toBeDefined()
    expect(res.error).toContain(new UnknownNodeFieldError(a, ['nonsense_field']).message)
    // The entry BEFORE the offending one must not have landed.
    const afterB = await parse(getNode({ node_id: b }, ctx))
    expect(afterB.node.title).toBe('Batch B')
  })

  it('refuses a changed id in an entry and lands nothing', async () => {
    const res = await parse(
      batchUpdateNodes(
        {
          updates: [
            { node_id: b, title: 'ALSO SHOULD NOT LAND' },
            { node_id: a, id: 'n_HIJACKED' },
          ],
        },
        ctx,
      ),
    )
    expect(res.error).toBeDefined()
    const afterB = await parse(getNode({ node_id: b }, ctx))
    expect(afterB.node.title).toBe('Batch B')
  })

  it('refuses `type` by name rather than dropping it in silence', async () => {
    const res = await parse(
      batchUpdateNodes({ updates: [{ node_id: a, type: 'opportunity' }] }, ctx),
    )
    expect(res.error).toBeDefined()
    expect(res.error).toContain('not updatable through batch_update_nodes')
    const after = await parse(getNode({ node_id: a }, ctx))
    expect(after.node.type).toBe('task')
  })

  it('applies a clean batch, archive axis included', async () => {
    const res = await parse(
      batchUpdateNodes(
        {
          updates: [
            { node_id: a, title: 'A2', archived: true, archived_at: '2026-08-22T03:00:00.000Z' },
            { node_id: b, description: 'updated' },
          ],
        },
        ctx,
      ),
    )
    expect(res.error).toBeUndefined()
    expect(res.count).toBe(2)
    const afterA = await parse(getNode({ node_id: a }, ctx))
    expect(afterA.node.title).toBe('A2')
    expect(afterA.node.archived).toBe(true)
    expect(afterA.node.archived_at).toBe('2026-08-22T03:00:00.000Z')
  })
})
