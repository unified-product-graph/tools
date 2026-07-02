/**
 * switch_product / reload_product conflict remediation (0.17.6).
 *
 * Reproduces the wedged save-conflict: the active .upg is edited by another
 * session while this session holds an unflushed in-memory change to the same
 * node's same field. `switch_product` flushes the active product first, so the
 * conflict blocks EVERY switch. These tests prove:
 *  - the scoped switch_product error names the ACTIVE file and says the target
 *    was not loaded (not the old "Failed to switch" that implied a load failure);
 *  - reload_product refuses to drop unsaved work without `discard_local: true`;
 *  - reload_product({ discard_local: true }) re-reads from disk, clears the
 *    conflict, and a subsequent switch_product succeeds — no server restart.
 *
 * Handlers read process.cwd(); each test chdirs into a real tmp workspace and
 * restores cwd afterwards, mirroring portfolio-read.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
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
import { switchProduct, reloadProduct } from '../tools/workspace.js'

function doc(over: Partial<UPGDocument> & { product: UPGDocument['product'] }): UPGDocument {
  return {
    upg_version: '0.2',
    exported_at: new Date().toISOString(),
    source: { tool: 'test' },
    nodes: [],
    edges: [],
    ...over,
  }
}

function makeCtx(store: UPGFileStore): ToolContext {
  return {
    store,
    sessionContext: createSessionContext(),
    queryCache: createQueryCache(),
    sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
  }
}

function bodyOf(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text)
}

const ACTIVE = doc({
  product: { id: 'p_active', title: 'Active', stage: 'concept' },
  nodes: [{ id: 'n1', type: 'persona', title: 'Original' }],
})
const TARGET = doc({
  product: { id: 'p_target', title: 'Target', stage: 'build' },
  nodes: [
    { id: 't1', type: 'persona', title: 'Target Persona' },
    { id: 't2', type: 'job', title: 'Target Job' },
  ],
})

describe('switch_product / reload_product conflict remediation (0.17.6)', () => {
  let cwd: string
  let prevCwd: string
  let store: UPGFileStore
  let ctx: ToolContext
  let activePath: string

  beforeEach(async () => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-reload-conflict-')))
    mkdirSync(join(cwd, '.upg'))
    activePath = join(cwd, '.upg', 'active.upg')
    writeFileSync(activePath, JSON.stringify(ACTIVE, null, 2))
    writeFileSync(join(cwd, '.upg', 'target.upg'), JSON.stringify(TARGET, null, 2))
    store = new UPGFileStore()
    await store.load(activePath)
    // Stop the file watcher so the external write below never triggers an async
    // watcher-driven merge; the conflict must surface deterministically on flush.
    store.stopWatching()
    ctx = makeCtx(store)
    process.chdir(cwd)
  })

  afterEach(() => {
    store.stopWatching()
    process.chdir(prevCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  /**
   * Put the store into the wedged state: an unflushed in-memory title change to
   * n1, plus an external on-disk edit of n1 to a DIFFERENT title. baseline still
   * holds the original, so the next flush three-way-merges and hits a same-field
   * CONFLICT.
   */
  function wedgeConflict() {
    store.updateNode('n1', { title: 'Ours' }) // in-memory, dirty; not flushed
    const onDisk = doc({
      product: { id: 'p_active', title: 'Active', stage: 'concept' },
      nodes: [{ id: 'n1', type: 'persona', title: 'Theirs' }],
    })
    writeFileSync(activePath, JSON.stringify(onDisk, null, 2))
  }

  it('the pre-switch flush conflict scopes the error to the ACTIVE file and does not load the target', async () => {
    wedgeConflict()
    const result = await switchProduct({ file: 'target' }, ctx)
    expect(result.isError).toBe(true)
    const msg = result.content[0].text
    expect(msg).toMatch(/active product/i)
    expect(msg).toContain('active.upg') // names the ACTIVE file, not the target
    expect(msg).toMatch(/was NOT loaded/)
    expect(msg).toMatch(/reload_product/)
    // The active product is unchanged: still p_active, still our in-memory title.
    expect(store.getProduct().id).toBe('p_active')
    expect(store.getNode('n1')?.title).toBe('Ours')
    expect(store.hasUnsavedChanges()).toBe(true)
  })

  it('reload_product refuses to discard unsaved changes without discard_local', async () => {
    wedgeConflict()
    const result = await reloadProduct({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/unsaved/i)
    expect(result.content[0].text).toMatch(/discard_local: true/)
    // Nothing was reloaded; our in-memory state stands.
    expect(store.getNode('n1')?.title).toBe('Ours')
    expect(store.hasUnsavedChanges()).toBe(true)
  })

  it('reload_product({ discard_local: true }) clears the conflict; a subsequent switch succeeds', async () => {
    wedgeConflict()
    const reload = bodyOf(await reloadProduct({ discard_local: true }, ctx))
    expect(reload.discarded_local_changes).toBe(true)
    // Disk state won: n1 is "Theirs", not our discarded "Ours".
    expect(store.getNode('n1')?.title).toBe('Theirs')
    expect(store.hasUnsavedChanges()).toBe(false)

    // The wedge is gone: switch_product now succeeds and loads the target.
    const sw = bodyOf(await switchProduct({ file: 'target' }, ctx))
    expect(sw.product.title).toBe('Target')
    expect(sw.entities).toBe(2)
    expect(store.getProduct().id).toBe('p_target')
  })

  it('reload_product on a clean store is a safe refresh (no discard_local needed)', async () => {
    // No in-memory mutation; an external write adds a node. A clean reload picks
    // it up without requiring the discard flag.
    const onDisk = doc({
      product: { id: 'p_active', title: 'Active', stage: 'concept' },
      nodes: [
        { id: 'n1', type: 'persona', title: 'Original' },
        { id: 'n2', type: 'job', title: 'Added Externally' },
      ],
    })
    writeFileSync(activePath, JSON.stringify(onDisk, null, 2))

    const body = bodyOf(await reloadProduct({}, ctx))
    expect(body.discarded_local_changes).toBe(false)
    expect(body.entities).toBe(2)
    expect(store.getNode('n2')?.title).toBe('Added Externally')
  })

  it('after a discard_local reload, a later flush persists cleanly (no lingering wedge)', async () => {
    wedgeConflict()
    await reloadProduct({ discard_local: true }, ctx)
    // A fresh mutation + flush must write without re-triggering the conflict.
    store.updateNode('n1', { title: 'Post-reload' })
    await store.flush()
    const persisted = JSON.parse(readFileSync(activePath, 'utf-8'))
    const n1 = persisted.nodes.find((n: { id: string }) => n.id === 'n1')
    expect(n1.title).toBe('Post-reload')
  })
})
