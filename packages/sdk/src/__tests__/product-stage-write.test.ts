/**
 * Product stage: the write must survive the serializer (2026-08-16 defect).
 *
 * `updateProduct({ stage })` set `doc.product.stage`, `flush()` ran the canonical
 * form's `effectiveRootProduct()` overlay — `stage: node.status ?? doc.product.stage`
 * — and the summary was re-derived from the UNTOUCHED product node before the
 * bytes hit disk. The read-back returned the OLD value with exit 0. The SDK's own
 * comment asserted the opposite invariant ("the product node carries no `status`,
 * so the summary stage wins"), which is false for any graph a graph tool has
 * touched.
 *
 * THE INVARIANT UNDER TEST: a product's stage is single-valued, and the
 * `type:'product'` node sharing the product id is its AUTHORITATIVE store —
 * `$upg.product.stage` / `doc.product.stage` are a projection of it. Every writer
 * must therefore leave every carrier agreeing, so that a write followed by a
 * reload from disk returns the written value through EVERY reader. Read order,
 * identical in the serializer (canonical.ts), the digest, and the writers:
 *
 *     node.properties.stage  ??  node.status  ??  $upg.product.stage
 *
 * Every case below writes, FLUSHES, and re-reads from disk — the defect was
 * invisible in memory.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { UPGFileStore } from '../index.js'
import { updateProduct } from '../lib/workspace.js'
import { updateNode, batchUpdateNodes, computeGraphDigest } from '../lib/tools.js'
import type { UPGBaseNode } from '@unified-product-graph/core'

// ── Fixture ──────────────────────────────────────────────────────────────────
// Fictional product ("Tessellate") — no real companies, people, or brands.

const PRODUCT_ID = 'p_tessellate'

/**
 * @param nodeStage what the product NODE carries. `status` is the carrier the
 *   serializer overlaid; `properties.stage` is the spec's declared carrier.
 */
function fixtureDoc(opts: {
  summaryStage?: string
  nodeStatus?: string
  nodePropertiesStage?: string
  withProductNode?: boolean
} = {}) {
  const { summaryStage = 'concept', nodeStatus, nodePropertiesStage, withProductNode = true } = opts
  const productNode: UPGBaseNode = {
    id: PRODUCT_ID,
    type: 'product',
    title: 'Tessellate',
    ...(nodeStatus ? { status: nodeStatus } : {}),
    ...(nodePropertiesStage ? { properties: { stage: nodePropertiesStage } } : {}),
  } as UPGBaseNode
  return {
    $upg: {
      format_version: '1.0.0',
      spec_version: '0.8.0',
      product: { id: PRODUCT_ID, title: 'Tessellate', stage: summaryStage },
      counts: { nodes: 0, edges: 0 },
      provenance: { tool: 'vitest', tool_version: '0.0.0', exported_at: '2026-08-17T00:00:00.000Z' },
      integrity: { algorithm: 'sha256-128', body: '00000000000000000000000000000000' },
    },
    product: { id: PRODUCT_ID, title: 'Tessellate', stage: summaryStage },
    nodes: [
      ...(withProductNode ? [productNode] : []),
      { id: 'n_persona', type: 'persona', title: 'Studio Lead', slug: 'studio-lead' },
    ] as UPGBaseNode[],
    edges: [],
  }
}

const cleanupDirs: string[] = []
afterEach(() => {
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop()!
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function writeFixture(doc: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-stage-'))
  cleanupDirs.push(dir)
  const f = path.join(dir, 'tessellate.upg')
  fs.writeFileSync(f, JSON.stringify(doc))
  return f
}

async function openStore(file: string): Promise<UPGFileStore> {
  const store = new UPGFileStore()
  await store.load(file)
  store.stopWatching()
  return store
}

type Stagey = { stage?: string }
function readRaw(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
}

/** What the FILE says, through every carrier, after a round trip through disk. */
interface OnDisk {
  headerStage: string | undefined
  summaryStage: string | undefined
  nodeStatus: string | undefined
  nodePropertiesStage: string | undefined
}
function readBack(file: string): OnDisk {
  const raw = readRaw(file)
  const nodes = (raw.nodes ?? []) as Array<Record<string, unknown>>
  const node = nodes.find((n) => n.type === 'product' && n.id === PRODUCT_ID)
  const header = (raw.$upg as Record<string, unknown> | undefined)?.product as Stagey | undefined
  return {
    headerStage: header?.stage,
    summaryStage: (raw.product as Stagey | undefined)?.stage,
    nodeStatus: node?.status as string | undefined,
    nodePropertiesStage: (node?.properties as Stagey | undefined)?.stage,
  }
}

/** Every carrier agrees on `stage` — the invariant, asserted as one thing. */
function expectStageEverywhere(file: string, stage: string): void {
  const d = readBack(file)
  expect(d.headerStage).toBe(stage)
  expect(d.summaryStage).toBe(stage)
  expect(d.nodeStatus).toBe(stage)
  expect(d.nodePropertiesStage).toBe(stage)
}

// ── (a) the defect: write → save → reload → read back the written value ──────

describe('updateProduct({ stage }) — the write must reach disk', () => {
  it('a stage write on a graph with a plain product node round-trips through disk', async () => {
    const file = writeFixture(fixtureDoc({ summaryStage: 'concept' }))
    const store = await openStore(file)

    const result = await updateProduct({ store, stage: 'build' as never })
    expect(result.updated).toContain('stage')
    await store.flush()

    // Reload from disk — the defect was invisible from the writing store's memory.
    const reloaded = await openStore(file)
    expect((reloaded.getProduct() as { stage?: string }).stage).toBe('build')
    expectStageEverywhere(file, 'build')
  })

  it('THE REGRESSION: a product node carrying a DIFFERENT status does not undo the write', async () => {
    // Exactly the shape that caught this: the node says `concept`, the caller
    // says `build`. Pre-fix the flush re-derived the summary from the node and
    // the file came back `concept` — no error, exit 0.
    const file = writeFixture(fixtureDoc({ summaryStage: 'concept', nodeStatus: 'concept' }))
    const store = await openStore(file)

    await updateProduct({ store, stage: 'build' as never })
    await store.flush()

    expectStageEverywhere(file, 'build')
    const reloaded = await openStore(file)
    expect((reloaded.getProduct() as { stage?: string }).stage).toBe('build')
  })

  it('heals a graph whose two node carriers already disagree', async () => {
    const file = writeFixture(
      fixtureDoc({ summaryStage: 'concept', nodeStatus: 'concept', nodePropertiesStage: 'growth' }),
    )
    const store = await openStore(file)

    await updateProduct({ store, stage: 'launch' as never })
    await store.flush()

    expectStageEverywhere(file, 'launch')
  })

  it('a root-only product (no product node) still writes its stage', async () => {
    const file = writeFixture(fixtureDoc({ summaryStage: 'concept', withProductNode: false }))
    const store = await openStore(file)

    await updateProduct({ store, stage: 'beta' as never })
    await store.flush()

    const d = readBack(file)
    expect(d.headerStage).toBe('beta')
    expect(d.summaryStage).toBe('beta')
  })

  it('a rename beside a stage change lands both, and neither reverts the other', async () => {
    const file = writeFixture(fixtureDoc({ summaryStage: 'concept', nodeStatus: 'concept' }))
    const store = await openStore(file)

    await updateProduct({ store, stage: 'growth' as never, title: 'Tessellate Studio' })
    await store.flush()

    expectStageEverywhere(file, 'growth')
    const header = (readRaw(file).$upg as Record<string, unknown>).product as { title?: string }
    expect(header.title).toBe('Tessellate Studio')
  })
})

// ── (b) the overlay's own precedence ─────────────────────────────────────────

describe('effectiveRootProduct overlay — one precedence order, everywhere', () => {
  it('serializes properties.stage in preference to status (the declared carrier wins)', async () => {
    // No writer involved: prove the SERIALIZER's order. A graph whose node carries
    // both, disagreeing, must serialize the carrier every reader reads first —
    // otherwise the header and `get_graph_digest` report different stages.
    const file = writeFixture(
      fixtureDoc({ summaryStage: 'concept', nodeStatus: 'concept', nodePropertiesStage: 'mature' }),
    )
    const store = await openStore(file)
    store.markDirty()
    await store.flush()

    const d = readBack(file)
    expect(d.headerStage).toBe('mature')
    expect(d.summaryStage).toBe('mature')
  })

  it('a NON-root product node does not get a vote', async () => {
    // A graph may hold other `type:'product'` nodes (portfolio siblings, watched
    // competitors). Only the node sharing `product.id` is authoritative — and
    // `createNode` seeds a product's status at the lifecycle's initial phase, so
    // a decoy read by type alone would drag a launch product back to concept.
    const doc = fixtureDoc({ summaryStage: 'launch' })
    doc.nodes.push({ id: 'n_decoy', type: 'product', title: 'Watched Rival', status: 'concept' } as UPGBaseNode)
    const file = writeFixture(doc)
    const store = await openStore(file)
    store.markDirty()
    await store.flush()

    expect(computeGraphDigest(store).product.stage).toBe('launch')
    expect(readBack(file).headerStage).toBe('launch')
  })

  it('the digest and the serialized header never disagree', async () => {
    const file = writeFixture(
      fixtureDoc({ summaryStage: 'concept', nodeStatus: 'growth' }),
    )
    const store = await openStore(file)
    store.markDirty()
    await store.flush()

    const digest = computeGraphDigest(store)
    expect(digest.product.stage).toBe(readBack(file).headerStage)
    expect(digest.product.stage).toBe('growth')
  })
})

// ── (c) the same hole's other doors: update_node and batch_update_nodes ──────

describe('update_node on the product node — the second door', () => {
  it('writing properties.stage beside a stale status is not silently reverted', async () => {
    // Pre-fix: §B synced the header from properties.stage, then the serializer
    // overlaid `status` back over it. A no-op on disk, exit 0.
    const file = writeFixture(fixtureDoc({ summaryStage: 'concept', nodeStatus: 'concept' }))
    const store = await openStore(file)

    updateNode(store, { node_id: PRODUCT_ID, properties: { stage: 'launch' } })
    await store.flush()

    expectStageEverywhere(file, 'launch')
  })

  it('writing status beside a stale properties.stage honours the value the caller wrote', async () => {
    // The old §B preferred properties.stage unconditionally, so an explicit
    // `status` write was resolved against a value the caller did not supply.
    const file = writeFixture(
      fixtureDoc({ summaryStage: 'concept', nodePropertiesStage: 'concept' }),
    )
    const store = await openStore(file)

    updateNode(store, { node_id: PRODUCT_ID, status: 'growth' })
    await store.flush()

    expectStageEverywhere(file, 'growth')
  })

  it('an unrelated edit does not resurrect a carrier the graph does not have', async () => {
    const file = writeFixture(fixtureDoc({ summaryStage: 'build', nodeStatus: 'build' }))
    const store = await openStore(file)

    updateNode(store, { node_id: PRODUCT_ID, title: 'Tessellate Renamed' })
    await store.flush()

    const d = readBack(file)
    expect(d.headerStage).toBe('build')
    expect(d.nodePropertiesStage).toBeUndefined() // never had one; not invented here
  })

  it('an explicit unset of properties.stage stays unset', async () => {
    const file = writeFixture(
      fixtureDoc({ summaryStage: 'build', nodeStatus: 'build', nodePropertiesStage: 'build' }),
    )
    const store = await openStore(file)

    updateNode(store, { node_id: PRODUCT_ID, unset_properties: ['stage'] })
    await store.flush()

    expect(readBack(file).nodePropertiesStage).toBeUndefined()
  })
})

describe('batch_update_nodes on the product node — the third door', () => {
  it('a batched stage write reaches disk through every carrier', async () => {
    const file = writeFixture(
      fixtureDoc({ summaryStage: 'concept', nodeStatus: 'concept', nodePropertiesStage: 'concept' }),
    )
    const store = await openStore(file)

    const res = batchUpdateNodes(store, [{ node_id: PRODUCT_ID, status: 'beta' }])
    expect(res.ok).toBe(true)
    await store.flush()

    expectStageEverywhere(file, 'beta')
  })
})
