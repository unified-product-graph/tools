/**
 * Content-level dedup: the second layer of the duplicate-delivery defence.
 *
 * 0.9.22 added a request-id idempotency ledger, but it only catches a resend
 * that REUSES the JSON-RPC request id. The field bug
 * (`upg-bug-idempotency-reopened-0.9.22.md`) is a re-delivery carrying a FRESH
 * request id: each create handler re-executes and mints a SECOND copy with new
 * ids. The store cannot be the source (it dedupes by id and never mints ids;
 * fresh ids come only from the create path), so the fix lives in the dispatch.
 *
 * These tests drive the real dispatcher (createDispatcher) against a real store,
 * through the exact path the stdio server uses, with no transport. The
 * `allow_duplicate` case deliberately reproduces the duplication (proving the
 * dispatch WOULD double on a fresh-id re-delivery); the default case proves the
 * content-dedup holds the line.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UPGDocument } from '@unified-product-graph/core'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { createDispatcher, createContentDedup, contentDedupKey } from '../server.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

function emptyDoc(): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    product: { id: 'p1', title: 'Dedup Test Product', stage: 'concept' },
    nodes: [],
    edges: [],
  } as unknown as UPGDocument
}

async function makeStore(): Promise<UPGFileStore> {
  const dir = mkdtempSync(join(tmpdir(), 'upg-dedup-'))
  const filePath = join(dir, 'test.upg')
  writeFileSync(filePath, JSON.stringify(emptyDoc(), null, 2))
  const store = new UPGFileStore()
  await store.load(filePath)
  store.stopWatching() // no file-watcher in tests
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

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

const FOUR = {
  nodes: [
    { type: 'persona', title: 'P1', description: 'first' },
    { type: 'persona', title: 'P2', description: 'second' },
    { type: 'persona', title: 'P3', description: 'third' },
    { type: 'persona', title: 'P4', description: 'fourth' },
  ],
}

describe('content-level dedup (fresh-id duplicate-delivery defence)', () => {
  it('a re-delivered batch_create_nodes with a FRESH request id is a no-op', async () => {
    const store = await makeStore()
    const { dispatch } = createDispatcher(makeCtx(store))

    await dispatch('batch_create_nodes', clone(FOUR), 'req-1')
    expect(store.getAllNodes()).toHaveLength(4)

    // Identical payload, DIFFERENT request id == the field bug's re-delivery.
    // The request-id ledger can't see it; content-dedup must.
    await dispatch('batch_create_nodes', clone(FOUR), 'req-2')
    expect(store.getAllNodes()).toHaveLength(4) // not 8
  })

  it('allow_duplicate:true opts out (and so reproduces the underlying duplication)', async () => {
    const store = await makeStore()
    const { dispatch } = createDispatcher(makeCtx(store))

    await dispatch('batch_create_nodes', clone(FOUR), 'req-1')
    await dispatch('batch_create_nodes', { ...clone(FOUR), allow_duplicate: true }, 'req-2')
    // Escape hatch bypasses dedup -> a genuine second create. This is exactly
    // what the bug did on EVERY fresh-id re-delivery before the fix.
    expect(store.getAllNodes()).toHaveLength(8)
  })

  it('a genuinely DIFFERENT mutating payload still executes', async () => {
    const store = await makeStore()
    const { dispatch } = createDispatcher(makeCtx(store))

    await dispatch('batch_create_nodes', clone(FOUR), 'req-1')
    await dispatch(
      'batch_create_nodes',
      { nodes: [{ type: 'persona', title: 'Different', description: 'x' }] },
      'req-2',
    )
    expect(store.getAllNodes()).toHaveLength(5)
  })

  it("the report's interleaved sequence (W1=create k, W2=create 1, W1 replayed) stays correct", async () => {
    const store = await makeStore()
    const { dispatch } = createDispatcher(makeCtx(store))

    await dispatch('batch_create_nodes', clone(FOUR), 'req-1') // W1
    expect(store.getAllNodes()).toHaveLength(4)
    await dispatch(
      'batch_create_nodes',
      { nodes: [{ type: 'persona', title: 'trigger', description: 't' }] },
      'req-2',
    ) // W2 (the unrelated next write that used to surface W1's duplicate)
    expect(store.getAllNodes()).toHaveLength(5)
    // The harness re-delivers W1 with a fresh id around W2; dedup holds.
    await dispatch('batch_create_nodes', clone(FOUR), 'req-3')
    expect(store.getAllNodes()).toHaveLength(5) // not 9
  })

  it('arg key ORDER does not change the dedup identity', async () => {
    const store = await makeStore()
    const a = contentDedupKey('batch_create_nodes', store, { nodes: [], parent_id: 'x' })
    const b = contentDedupKey('batch_create_nodes', store, { parent_id: 'x', nodes: [] })
    expect(a).toBe(b)
  })

  it('allow_duplicate is excluded from the dedup key', async () => {
    const store = await makeStore()
    const a = contentDedupKey('batch_create_nodes', store, clone(FOUR))
    const b = contentDedupKey('batch_create_nodes', store, { ...clone(FOUR), allow_duplicate: true })
    expect(a).toBe(b)
  })
})

describe('createContentDedup', () => {
  it('records on success and replays by content key', () => {
    const d = createContentDedup<number>()
    expect(d.get('k')).toBeUndefined()
    d.record('k', 7)
    expect(d.get('k')).toBe(7)
    expect(d.has('k')).toBe(true)
  })

  it('evicts the oldest beyond the count window', () => {
    const d = createContentDedup<number>(2)
    d.record('a', 1)
    d.record('b', 2)
    d.record('c', 3) // evicts 'a'
    expect(d.get('a')).toBeUndefined()
    expect(d.get('b')).toBe(2)
    expect(d.get('c')).toBe(3)
    expect(d.size).toBe(2)
  })

  it('record refreshes recency so a repeated key is not evicted early', () => {
    const d = createContentDedup<number>(2)
    d.record('a', 1)
    d.record('b', 2)
    d.record('a', 1) // refresh 'a' -> 'b' is now oldest
    d.record('c', 3) // evicts 'b', not 'a'
    expect(d.get('a')).toBe(1)
    expect(d.get('b')).toBeUndefined()
    expect(d.get('c')).toBe(3)
  })
})
