/**
 * 0.33.0 Item H (Decision 10) - `key`, `archived` and `archived_at` at the WIRE.
 *
 * The trap this file exists to catch has three layers, and widening any one of
 * them alone does nothing:
 *
 *   1. the JSON tool schemas in `lib/tool-registry.ts`,
 *   2. the SDK arg interfaces and patch construction in `upg-sdk/lib/tools.ts`,
 *   3. the hand-copied field lists in `tools/nodes.ts`.
 *
 * A schema that advertises a field the handler never copies is a success
 * envelope over a write that landed nothing, which is exactly the 0.32.0 defect
 * this item closes. So these tests call the ACTUAL handlers the server
 * dispatches to and read the result back out of the store, and a separate block
 * asserts the schemas agree with the handlers.
 *
 * The ratified contract, mirroring `graph-service`:
 *
 *   field         create        update
 *   archived      accept        accept
 *   archived_at   accept        accept
 *   key           accept        REFUSE, with the reason readable
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument, UPGBaseNode, UPGEntityType } from '@unified-product-graph/core'
import { createNode, updateNode, batchCreateNodes, batchUpdateNodes } from '../tools/nodes.js'
import { TOOL_DEFINITIONS } from '../lib/tool-registry.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
  type ToolHandler,
  type ToolResult,
} from '../lib/server-context.js'

function dispatch(
  handler: ToolHandler,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  return Promise.resolve(handler(args, ctx))
}

const node = (id: string, title: string, extra: Partial<UPGBaseNode> = {}): UPGBaseNode => ({
  id,
  type: 'feature' as UPGEntityType,
  title,
  ...extra,
})

function makeDoc(): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Lantern', stage: 'concept' },
    nodes: [
      node('n_plain', 'Pantry suggestions'),
      node('n_keyed', 'Shelf reminders', { key: 'LTN-311' }),
    ],
    edges: [],
  } as UPGDocument
}

async function loadStore(): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-key-archive-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(makeDoc(), null, 2))
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

const ARCHIVED_AT = '2026-08-22T09:15:00.000Z'

function schemaProps(toolName: string): Record<string, unknown> {
  const def = TOOL_DEFINITIONS.find((t) => t.name === toolName)!
  return def.inputSchema.properties as Record<string, unknown>
}

function batchItemProps(toolName: string, arrayField: string): Record<string, unknown> {
  const props = schemaProps(toolName)
  const arr = props[arrayField] as { items: { properties: Record<string, unknown> } }
  return arr.items.properties
}

let store: UPGFileStore
let ctx: ToolContext
beforeEach(async () => {
  store = await loadStore()
  ctx = makeCtx(store)
})

// ── create ─────────────────────────────────────────────────────────────────

describe('Item H - create_node and batch_create_nodes accept all three fields', () => {
  it('create_node round-trips key, archived and archived_at into the store', async () => {
    const result = await dispatch(
      createNode,
      {
        type: 'feature',
        title: 'Batch reorder',
        key: 'LTN-412',
        archived: true,
        archived_at: ARCHIVED_AT,
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0].text) as { node: UPGBaseNode }
    const stored = store.getNode(payload.node.id)!
    expect(stored.key).toBe('LTN-412')
    expect(stored.archived).toBe(true)
    expect(stored.archived_at).toBe(ARCHIVED_AT)
  })

  it('batch_create_nodes round-trips all three', async () => {
    const result = await dispatch(
      batchCreateNodes,
      {
        nodes: [
          { type: 'feature', title: 'Weekly digest', key: 'LTN-501', archived: false },
          { type: 'feature', title: 'Retired import', key: 'LTN-502', archived: true, archived_at: ARCHIVED_AT },
        ],
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0].text) as { created: Array<{ id: string }> }
    const first = store.getNode(payload.created[0].id)!
    const second = store.getNode(payload.created[1].id)!
    expect(first.key).toBe('LTN-501')
    expect(first.archived).toBe(false)
    expect(second.key).toBe('LTN-502')
    expect(second.archived).toBe(true)
    expect(second.archived_at).toBe(ARCHIVED_AT)
  })

  it('never mints a key of its own', async () => {
    // The minter stays in `graph-service`, because deriving max(existing) + 1
    // needs paged reads and a second unpaged minter is a duplicate-key
    // generator for a field with no uniqueness check.
    const result = await dispatch(createNode, { type: 'feature', title: 'No key wanted' }, ctx)
    const payload = JSON.parse(result.content[0].text) as { node: UPGBaseNode }
    expect(store.getNode(payload.node.id)!.key).toBeUndefined()
  })
})

// ── update: archived axis ──────────────────────────────────────────────────

describe('Item H - update_node and batch_update_nodes accept the archive axis', () => {
  it('update_node round-trips archived and archived_at', async () => {
    const result = await dispatch(
      updateNode,
      { node_id: 'n_plain', archived: true, archived_at: ARCHIVED_AT },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(store.getNode('n_plain')!.archived).toBe(true)
    expect(store.getNode('n_plain')!.archived_at).toBe(ARCHIVED_AT)
  })

  it('update_node un-archives, and a null archived_at clears the timestamp', async () => {
    await dispatch(updateNode, { node_id: 'n_plain', archived: true, archived_at: ARCHIVED_AT }, ctx)
    const result = await dispatch(updateNode, { node_id: 'n_plain', archived: false, archived_at: null }, ctx)
    expect(result.isError).toBeUndefined()
    expect(store.getNode('n_plain')!.archived).toBe(false)
    expect(store.getNode('n_plain')!.archived_at).toBeNull()
  })

  it('batch_update_nodes round-trips both', async () => {
    const result = await dispatch(
      batchUpdateNodes,
      {
        updates: [
          { node_id: 'n_plain', archived: true, archived_at: ARCHIVED_AT },
          { node_id: 'n_keyed', archived: true },
        ],
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(store.getNode('n_plain')!.archived).toBe(true)
    expect(store.getNode('n_plain')!.archived_at).toBe(ARCHIVED_AT)
    expect(store.getNode('n_keyed')!.archived).toBe(true)
  })
})

// ── update: key refused ────────────────────────────────────────────────────

describe('Item H - update REFUSES key and returns the reason to the caller', () => {
  it('update_node returns an error naming the immutability invariant', async () => {
    const result = await dispatch(updateNode, { node_id: 'n_keyed', key: 'LTN-999' }, ctx)
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    // Assert on the TEXT. A refusal the caller cannot read is the same dead end
    // as the silent drop it replaces.
    expect(text).toMatch(/immutable/i)
    expect(text).toMatch(/minted once/i)
    expect(text).toMatch(/never reused/i)
    expect(text).toContain('n_keyed')
    expect(text).toMatch(/create_node|batch_create_nodes/)
    expect(store.getNode('n_keyed')!.key).toBe('LTN-311')
  })

  it('a refused update_node mutates nothing, not even the type', async () => {
    const result = await dispatch(
      updateNode,
      { node_id: 'n_keyed', key: 'LTN-999', title: 'Renamed', type: 'task' },
      ctx,
    )
    expect(result.isError).toBe(true)
    const stored = store.getNode('n_keyed')!
    expect(stored.key).toBe('LTN-311')
    expect(stored.title).toBe('Shelf reminders')
    expect(stored.type).toBe('feature')
  })

  it('refuses the SHADOW door: update_node({ properties: { key } }) is not a way in', async () => {
    // Property writes are permissive about unknown keys, so a guard on the
    // typed field alone would teach a refused caller that the side door works.
    // A key parked in `properties` is worse than no key: it reads as a key to a
    // human and to nothing else.
    const result = await dispatch(updateNode, { node_id: 'n_keyed', properties: { key: 'LTN-999' } }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/immutable/i)
    expect(result.content[0].text).toMatch(/never reused/i)
    expect(store.getNode('n_keyed')!.key).toBe('LTN-311')
    expect(store.getNode('n_keyed')!.properties?.key).toBeUndefined()
  })

  it('both doors return the same refusal text', async () => {
    const viaField = await dispatch(updateNode, { node_id: 'n_keyed', key: 'LTN-999' }, ctx)
    const viaProperties = await dispatch(
      updateNode,
      { node_id: 'n_keyed', properties: { key: 'LTN-999' } },
      ctx,
    )
    expect(viaField.isError).toBe(true)
    expect(viaProperties.isError).toBe(true)
    expect(viaProperties.content[0].text).toBe(viaField.content[0].text)
  })

  it('an ordinary property write is still permitted, so the guard is not a blanket veto', async () => {
    const result = await dispatch(updateNode, { node_id: 'n_keyed', properties: { effort: 3 } }, ctx)
    expect(result.isError).toBeUndefined()
    expect(store.getNode('n_keyed')!.properties?.effort).toBe(3)
  })

  it('batch_update_nodes refuses the shadow door and lands none of the batch', async () => {
    const result = await dispatch(
      batchUpdateNodes,
      {
        updates: [
          { node_id: 'n_plain', title: 'Would have landed' },
          { node_id: 'n_keyed', properties: { key: 'LTN-999' } },
        ],
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Update at index 1/)
    expect(result.content[0].text).toMatch(/immutable/i)
    expect(store.getNode('n_plain')!.title).toBe('Pantry suggestions')
    expect(store.getNode('n_keyed')!.properties?.key).toBeUndefined()
  })

  it('batch_update_nodes refuses the batch and lands none of it', async () => {
    const result = await dispatch(
      batchUpdateNodes,
      {
        updates: [
          { node_id: 'n_plain', title: 'Would have landed' },
          { node_id: 'n_keyed', key: 'LTN-999' },
        ],
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    const text = result.content[0].text
    expect(text).toMatch(/Update at index 1/)
    expect(text).toMatch(/immutable/i)
    expect(text).toMatch(/never reused/i)
    expect(store.getNode('n_plain')!.title).toBe('Pantry suggestions')
    expect(store.getNode('n_keyed')!.key).toBe('LTN-311')
  })
})

// ── the asymmetry, and the schema that has to agree with it ────────────────

describe('Item H - the create/update asymmetry IS the contract', () => {
  it('one key value: accepted by create_node, refused by update_node', async () => {
    const KEY = 'LTN-777'
    const created = await dispatch(createNode, { type: 'feature', title: 'Shared basket', key: KEY }, ctx)
    expect(created.isError).toBeUndefined()
    const id = (JSON.parse(created.content[0].text) as { node: UPGBaseNode }).node.id
    expect(store.getNode(id)!.key).toBe(KEY)

    // Even restating the key the node already holds is refused. A tolerated
    // no-op would be indistinguishable, to the caller, from a rename that
    // worked.
    const refused = await dispatch(updateNode, { node_id: id, key: KEY }, ctx)
    expect(refused.isError).toBe(true)
    expect(store.getNode(id)!.key).toBe(KEY)
  })

  it('archived and archived_at are symmetric across create and update; key is not', async () => {
    const created = await dispatch(
      createNode,
      { type: 'feature', title: 'Shelf audit', key: 'LTN-888', archived: true, archived_at: ARCHIVED_AT },
      ctx,
    )
    const id = (JSON.parse(created.content[0].text) as { node: UPGBaseNode }).node.id

    const unarchive = await dispatch(updateNode, { node_id: id, archived: false }, ctx)
    expect(unarchive.isError).toBeUndefined()

    const rekey = await dispatch(updateNode, { node_id: id, key: 'LTN-889' }, ctx)
    expect(rekey.isError).toBe(true)
  })

  it('the wire schemas match the handlers, so no field is advertised and dropped', () => {
    // Layer 1 must agree with layer 3, in both directions. A schema field the
    // handler ignores is the silent-drop defect; a handler field the schema
    // hides is a capability nobody can discover.
    for (const props of [schemaProps('create_node'), batchItemProps('batch_create_nodes', 'nodes')]) {
      expect(props.key).toBeDefined()
      expect(props.archived).toBeDefined()
      expect(props.archived_at).toBeDefined()
    }

    for (const props of [schemaProps('update_node'), batchItemProps('batch_update_nodes', 'updates')]) {
      expect(props.archived).toBeDefined()
      expect(props.archived_at).toBeDefined()
      // Deliberately absent: advertising a field that is always refused invites
      // the call the refusal exists to prevent. The tool DESCRIPTION carries
      // the rule instead.
      expect(props.key).toBeUndefined()
    }

    for (const name of ['update_node', 'batch_update_nodes']) {
      const def = TOOL_DEFINITIONS.find((t) => t.name === name)!
      expect(def.description).toMatch(/`key` is NOT updatable/)
    }
  })

  it('widening these schemas added no tools', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(98)
  })
})
