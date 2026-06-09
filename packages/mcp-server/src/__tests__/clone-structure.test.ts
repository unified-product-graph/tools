/**
 * Cross-product structure clone (batch-4 #17, 0.9.4).
 *
 * Runs against a real tmp workspace with multiple `.upg` files; the handler
 * reads process.cwd(), so each test chdirs in and restores afterwards. Exercises
 * the dry-run preview, the into-active default, the no-switch named-target
 * (cross-product write), region scoping, content-stripping, and the guards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { getRegionForEntityType } from '@unified-product-graph/core'
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
import { cloneStructure } from '../tools/clone-structure.js'

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

// Source carries real content (descriptions + properties + statuses) so we can
// prove NONE of it crosses into the clone.
const SOURCE = doc({
  product: { id: 'p_source', title: 'Content Lake', stage: 'growth' },
  nodes: [
    { id: 's_per', type: 'persona', title: 'Solo Builder', description: 'real content', status: 'validated', properties: { segment: 'indie' } },
    { id: 's_job', type: 'job', title: 'Ship faster', description: 'real content' },
    { id: 's_price', type: 'pricing_tier', title: 'Pro', description: 'real content', properties: { price: 20 } },
  ],
  edges: [{ id: 's_e1', source: 's_per', target: 's_job', type: 'persona_pursues_job' }],
})

function bodyOf(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text)
}

describe('clone_structure (#17)', () => {
  let cwd: string
  let prevCwd: string

  beforeEach(() => {
    prevCwd = process.cwd()
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'upg-clone-')))
    mkdirSync(join(cwd, '.upg'))
    writeFileSync(join(cwd, '.upg', 'source.upg'), JSON.stringify(SOURCE, null, 2))
    writeFileSync(join(cwd, '.upg', 'target.upg'), JSON.stringify(doc({ product: { id: 'p_target', title: 'Target', stage: 'concept' } }), null, 2))
    writeFileSync(join(cwd, '.upg', 'scratch.upg'), JSON.stringify(doc({ product: { id: 'p_scratch', title: 'Scratch', stage: 'concept' } }), null, 2))
    process.chdir(cwd)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(cwd, { recursive: true, force: true })
  })

  async function ctxWithActive(file: string): Promise<ToolContext> {
    const store = new UPGFileStore()
    await store.load(join(cwd, '.upg', file))
    store.stopWatching()
    return {
      store,
      sessionContext: createSessionContext(),
      queryCache: createQueryCache(),
      sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
    }
  }

  function readProduct(file: string): UPGDocument {
    return JSON.parse(readFileSync(join(cwd, '.upg', file), 'utf-8'))
  }

  it('dry_run previews the plan without writing', async () => {
    const ctx = await ctxWithActive('scratch.upg')
    const body = bodyOf(await cloneStructure({ from_product: 'source', into: 'target', dry_run: true }, ctx))
    expect(body.dry_run).toBe(true)
    expect(body.from).toBe('p_source')
    expect(body.into).toBe('p_target')
    expect(body.into_is_active).toBe(false)
    expect(body.would_clone.nodes).toBe(3)
    expect(body.would_clone.edges).toBe(1)
    expect(body.would_clone.by_type).toMatchObject({ persona: 1, job: 1, pricing_tier: 1 })
    expect(body.sample_titles.every((t: string) => t.startsWith('TODO:'))).toBe(true)
    // Target on disk is still empty.
    expect(readProduct('target.upg').nodes).toHaveLength(0)
  })

  it('clones SHAPE (not content) into the active product by default', async () => {
    const ctx = await ctxWithActive('target.upg')
    const body = bodyOf(await cloneStructure({ from_product: 'source' }, ctx))
    expect(body.cloned).toBe(true)
    expect(body.into_is_active).toBe(true)
    expect(body.nodes_created).toBe(3)
    expect(body.edges_created).toBe(1)

    const twins = ctx.store.getAllNodes()
    expect(twins).toHaveLength(3)
    for (const n of twins) {
      expect(n.title.startsWith('TODO:')).toBe(true)
      expect((n.tags ?? []).includes('stub')).toBe(true)
      // Content did NOT cross over.
      expect(n.description).toBeUndefined()
      expect(n.properties).toBeUndefined()
    }
    // The edge shape is preserved by type.
    const edges = ctx.store.getAllEdges()
    expect(edges).toHaveLength(1)
    expect(edges[0].type).toBe('persona_pursues_job')
    // Source is untouched.
    expect(readProduct('source.upg').nodes).toHaveLength(3)
  })

  it('writes to a NAMED non-active product with no switch_product', async () => {
    const ctx = await ctxWithActive('scratch.upg') // active is neither source nor target
    const body = bodyOf(await cloneStructure({ from_product: 'source', into: 'target' }, ctx))
    expect(body.cloned).toBe(true)
    expect(body.into_is_active).toBe(false)
    expect(body.nodes_created).toBe(3)

    // Target file on disk received the shape...
    const target = readProduct('target.upg')
    expect(target.nodes).toHaveLength(3)
    expect(target.edges).toHaveLength(1)
    // ...and the active product (scratch) was never touched.
    expect(ctx.store.getAllNodes()).toHaveLength(0)
    expect(readProduct('scratch.upg').nodes).toHaveLength(0)
  })

  it('scopes the clone to the requested regions', async () => {
    const personaRegion = getRegionForEntityType('persona')!.id
    const ctx = await ctxWithActive('target.upg')
    const body = bodyOf(await cloneStructure({ from_product: 'source', regions: [personaRegion], dry_run: true }, ctx))
    // Every cloned type must belong to the scoped region; pricing_tier (a
    // different region) is excluded.
    for (const type of Object.keys(body.would_clone.by_type)) {
      expect(getRegionForEntityType(type)!.id).toBe(personaRegion)
    }
    expect(body.would_clone.by_type.pricing_tier).toBeUndefined()
    expect(body.region_scope).toContain(personaRegion)
  })

  it('refuses to clone a product into itself', async () => {
    const ctx = await ctxWithActive('source.upg')
    const result = await cloneStructure({ from_product: 'source', into: 'source' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/into itself/)
  })

  it('warns on a double-stamp (additive re-clone)', async () => {
    const ctx = await ctxWithActive('target.upg')
    await cloneStructure({ from_product: 'source' }, ctx)
    const body = bodyOf(await cloneStructure({ from_product: 'source' }, ctx))
    expect(body.nodes_created).toBe(3)
    expect(ctx.store.getAllNodes()).toHaveLength(6) // additive
    expect((body.warnings ?? []).join(' ')).toMatch(/prior clone/)
  })
})
