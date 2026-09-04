/**
 * 0.39.0 (A4) — a write tool's response means ON DISK.
 *
 * The field case (Sanity design-layer brief, ~2,000 tool calls): `store` saves
 * on a 300ms fire-and-forget debounce, so a write tool returned while the file
 * still held the pre-write state. The documented workflow — `batch_*`, then
 * read the file for ids and verification — raced its own writes; three scripts
 * read stale state and needed sleeps.
 *
 * These drive the real dispatcher (the path the stdio server uses) and assert
 * against the FILE, not the in-memory store: reading memory would pass under
 * the old bug and prove nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { createDispatcher, MUTATING_TOOLS } from '../server.js'
import {
  createSessionContext,
  createQueryCache,
  readSyncState,
  writeSyncState,
  hashFile,
  syncFilePath,
  type ToolContext,
} from '../lib/server-context.js'

let dir: string
let file: string
let store: UPGFileStore
let dispatch: (n: string, a: Record<string, unknown>, k?: string) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>

/** The graph as it exists ON DISK right now. */
function onDisk(): { nodes: Array<{ id: string; title: string; type: string; properties?: Record<string, unknown> }> } {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'upg-flush-'))
  file = join(dir, 'p.upg')
  writeFileSync(
    file,
    JSON.stringify({
      upg_version: '0.8.0',
      exported_at: new Date().toISOString(),
      source: { tool: 'test', tool_version: '0' },
      product: { id: 'p_1', title: 'Flush Test' },
      nodes: [],
      edges: [],
    }),
    'utf-8',
  )
  store = new UPGFileStore()
  await store.load(file)
  const ctx: ToolContext = {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
    serverInfo: { name: 'test', version: '0' },
    getClientInfo: () => undefined,
  }
  dispatch = createDispatcher(ctx).dispatch as typeof dispatch
})

afterEach(() => {
  store.stopWatching()
  rmSync(dir, { recursive: true, force: true })
})

describe('A4 — a write tool returns only after the file is written', () => {
  it('create_node: the node is on disk the instant the response is delivered', async () => {
    const r = await dispatch('create_node', { type: 'feature', title: 'Immediately readable' })
    expect(r.isError).toBeFalsy()
    // NO sleep, no flush, no re-read of the store: straight to the file.
    const titles = onDisk().nodes.map((n) => n.title)
    expect(titles).toContain('Immediately readable')
  })

  it('batch_create_nodes: all 50 are on disk immediately (the reporter’s shape)', async () => {
    const nodes = Array.from({ length: 50 }, (_, i) => ({ type: 'design_token', title: `token-${i}` }))
    const r = await dispatch('batch_create_nodes', { nodes })
    expect(r.isError).toBeFalsy()
    const onDiskTitles = new Set(onDisk().nodes.map((n) => n.title))
    const missing = nodes.map((n) => n.title).filter((t) => !onDiskTitles.has(t))
    expect(missing, 'titles the response claimed but the file did not hold').toEqual([])
  })

  it('a write→read→write→read loop never observes stale state', async () => {
    // The documented workflow: batch, verify, batch again keyed off the read.
    for (let round = 0; round < 3; round++) {
      await dispatch('create_node', { type: 'feature', title: `round-${round}` })
      const seen = onDisk().nodes.map((n) => n.title)
      for (let prior = 0; prior <= round; prior++) {
        expect(seen, `round ${round} lost round ${prior}`).toContain(`round-${prior}`)
      }
    }
  })

  it('update_node: the updated value is on disk, not just in memory', async () => {
    const created = await dispatch('create_node', { type: 'feature', title: 'Before' })
    const id = JSON.parse(created.content[0].text).node.id as string
    await dispatch('update_node', { node_id: id, title: 'After' })
    const node = onDisk().nodes.find((n) => n.id === id)
    expect(node?.title).toBe('After')
  })

  it('delete_node: the deletion is on disk immediately', async () => {
    const created = await dispatch('create_node', { type: 'feature', title: 'Doomed' })
    const id = JSON.parse(created.content[0].text).node.id as string
    await dispatch('delete_node', { node_id: id })
    expect(onDisk().nodes.find((n) => n.id === id)).toBeUndefined()
  })

  it('a READ tool is not slowed by the flush guarantee (reads are never in MUTATING_TOOLS)', async () => {
    // Guards the scope of the change: the flush is on the write path only.
    for (const readTool of ['get_graph_digest', 'list_nodes', 'query', 'get_spec_version']) {
      expect(MUTATING_TOOLS.has(readTool), `${readTool} must not be treated as a write`).toBe(false)
    }
  })
})
