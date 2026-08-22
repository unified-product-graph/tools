/**
 * R2 — `upsert_composition` writes a view that lifecycle-aware reads can see.
 *
 * 0.34.0's only new tool wrote the phase into `properties.lifecycle`, an
 * undeclared and un-namespaced bag key, and left the node with no `status` at
 * all. Three things followed, all of them observable from outside:
 *
 *   - `list_nodes({ type: 'composition', status: 'published' })` returned
 *     nothing for a view that had just been published.
 *   - `get_node` reported `lifecycle` and `updated_at` as unknown properties on
 *     every composition the tool had ever written.
 *   - the tool accepted a `retired` phase the composition lifecycle does not
 *     have (`draft | published | archived`, terminal `archived`).
 *
 * `rev` semantics were correct throughout and are covered by
 * `upsert-composition.test.ts`; nothing here re-tests them.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore, readComposition } from '@unified-product-graph/sdk'
import { getNode, listNodes } from '../tools/nodes.js'
import { getToolHandler } from '../lib/tool-registry.js'
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
  const dir = mkdtempSync(join(tmpdir(), 'upg-composition-status-test-'))
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

/** Dispatch `upsert_composition` the way the server does. */
function upsertComposition(args: Record<string, unknown>, ctx: ToolContext) {
  const handler = getToolHandler('upsert_composition')
  if (!handler) throw new Error('No handler registered for upsert_composition')
  return handler(args, ctx)
}

async function parse(result: unknown) {
  const r = (await Promise.resolve(result)) as {
    isError?: boolean
    content: Array<{ text: string }>
  }
  if (r.isError) return { error: r.content[0].text }
  return JSON.parse(r.content[0].text)
}

describe('upsert_composition: the phase lands on status (R2)', () => {
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    store = await makeStore()
    ctx = makeCtx(store)
  })

  it('get_node returns a status for a published view', async () => {
    await parse(
      upsertComposition(
        { slug: 'audit-view', title: 'AUDIT View', lifecycle: 'published', members: [] },
        ctx,
      ),
    )
    const read = await parse(getNode({ node_id: 'audit-view' }, ctx))
    expect(read.node.status).toBe('published')
  })

  it('list_nodes filtered by status FINDS the view it just published', async () => {
    await parse(
      upsertComposition(
        { slug: 'audit-view', title: 'AUDIT View', lifecycle: 'published', members: [] },
        ctx,
      ),
    )
    const listed = await parse(
      listNodes({ type: 'composition', status: 'published' }, ctx),
    )
    expect(listed.nodes.map((n: { id: string }) => n.id)).toContain('audit-view')
  })

  it('a draft view is NOT in the published set', async () => {
    await parse(
      upsertComposition({ slug: 'draft-view', title: 'Draft', lifecycle: 'draft' }, ctx),
    )
    const published = await parse(
      listNodes({ type: 'composition', status: 'published' }, ctx),
    )
    expect(published.nodes.map((n: { id: string }) => n.id)).not.toContain('draft-view')
    const drafts = await parse(listNodes({ type: 'composition', status: 'draft' }, ctx))
    expect(drafts.nodes.map((n: { id: string }) => n.id)).toContain('draft-view')
  })

  it('emits NO unknown-property warning: neither lifecycle nor updated_at is in the bag', async () => {
    await parse(
      upsertComposition(
        { slug: 'audit-view', title: 'AUDIT View', lifecycle: 'published', members: [] },
        ctx,
      ),
    )
    const read = await parse(getNode({ node_id: 'audit-view' }, ctx))
    expect(read.unknown_properties).toBeUndefined()
    expect(read.warning).toBeUndefined()
    expect(read.node.properties?.lifecycle).toBeUndefined()
    expect(read.node.properties?.updated_at).toBeUndefined()
  })

  it('writes updated_at to the DECLARED base field instead', async () => {
    await parse(
      upsertComposition({ slug: 'audit-view', title: 'V', lifecycle: 'draft' }, ctx),
    )
    const read = await parse(getNode({ node_id: 'audit-view' }, ctx))
    expect(read.node.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('the graph it writes validates clean', async () => {
    await parse(
      upsertComposition(
        { slug: 'audit-view', title: 'AUDIT View', lifecycle: 'published', members: [] },
        ctx,
      ),
    )
    const v = await parse(validateGraph({ skip_anti_patterns: true }, ctx))
    expect(v.summary.lifecycle_drift).toBe(0)
    expect(v.summary.top_level_drift).toBe(0)
  })
})

describe('upsert_composition: retired reconciles to archived (R2)', () => {
  let store: UPGFileStore
  let ctx: ToolContext

  beforeEach(async () => {
    store = await makeStore()
    ctx = makeCtx(store)
  })

  it('accepts the spec phase `archived` and stores it', async () => {
    await parse(
      upsertComposition({ slug: 'v', title: 'V', lifecycle: 'archived' }, ctx),
    )
    const read = await parse(getNode({ node_id: 'v' }, ctx))
    expect(read.node.status).toBe('archived')
  })

  it('accepts the deprecated `retired` alias and stores `archived`', async () => {
    await parse(
      upsertComposition({ slug: 'v', title: 'V', lifecycle: 'retired' }, ctx),
    )
    const read = await parse(getNode({ node_id: 'v' }, ctx))
    expect(read.node.status).toBe('archived')
    expect(readComposition(store, 'v')?.lifecycle).toBe('archived')
  })

  it('refuses a phase the composition lifecycle does not have', async () => {
    const res = await parse(
      upsertComposition({ slug: 'v', title: 'V', lifecycle: 'sunset' }, ctx),
    )
    expect(res.error).toBeDefined()
  })
})

describe('a composition written by 0.34.0 still reads, and self-heals (R2)', () => {
  it('reads its phase from the bag, then moves it to status on the next publish', async () => {
    const store = await makeStore([
      {
        id: 'legacy-view',
        type: 'composition',
        title: 'Legacy View',
        properties: { lifecycle: 'published', updated_at: '2026-08-20T00:00:00.000Z', rev: 3 },
      },
    ] as UPGDocument['nodes'])
    const ctx = makeCtx(store)

    // Read BEFORE any write: the fallback carries it.
    expect(readComposition(store, 'legacy-view')?.lifecycle).toBe('published')
    expect(readComposition(store, 'legacy-view')?.rev).toBe(3)

    await parse(
      upsertComposition(
        { slug: 'legacy-view', title: 'Legacy View', lifecycle: 'published' },
        ctx,
      ),
    )

    const read = await parse(getNode({ node_id: 'legacy-view' }, ctx))
    expect(read.node.status).toBe('published')
    expect(read.node.properties?.lifecycle).toBeUndefined()
    expect(read.node.properties?.updated_at).toBeUndefined()
    expect(read.unknown_properties).toBeUndefined()
    // rev still derived, not reset.
    expect(read.node.properties?.rev).toBe(4)
  })
})
