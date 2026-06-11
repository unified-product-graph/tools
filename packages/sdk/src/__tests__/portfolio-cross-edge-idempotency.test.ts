/**
 * Portfolio cross-edge write idempotency
 * (`upg-bug-idempotency-reopened-0.9.22.md`, the second / cross-product bug).
 *
 * `create_cross_product_edge` could throw a false-negative
 * `ENOENT ...portfolio.upg.tmp -> ...portfolio.upg` (a debounced save racing an
 * explicit flush on a SHARED tmp path) even though the edge had already
 * persisted; a naive retry then appended a SECOND identical edge. Two fixes:
 * a per-write UNIQUE tmp path (no shared-tmp collision), and a (source, target,
 * type) dedup in addCrossEdge so the retry is a safe no-op.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { UPGCrossEdge } from '@unified-product-graph/core'
import { UPGPortfolioStore } from '../store.js'

const crossEdge = (id: string): UPGCrossEdge =>
  ({ id, source: 'prod_a/n_1', target: 'prod_b/n_2', type: 'depends_on_product' }) as UPGCrossEdge

describe('portfolio cross-edge write idempotency', () => {
  it('addCrossEdge dedupes an identical (source, target, type) re-create', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-pf-idem-'))
    const store = new UPGPortfolioStore()
    await store.loadOrInit(path.join(dir, 'portfolio.upg'))

    store.addCrossEdge(crossEdge('cx_1'))
    // Same triple, FRESH id == the naive retry after a false-negative FS error.
    store.addCrossEdge(crossEdge('cx_2'))

    expect(store.getAllCrossEdges()).toHaveLength(1)
    await store.flush()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writeToDisk persists and leaves no orphan .tmp file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-pf-tmp-'))
    const pfPath = path.join(dir, 'portfolio.upg')
    const store = new UPGPortfolioStore()
    await store.loadOrInit(pfPath)
    store.addCrossEdge(crossEdge('cx_1'))
    await store.flush()

    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])

    const reloaded = new UPGPortfolioStore()
    await reloaded.loadOrInit(pfPath)
    expect(reloaded.getAllCrossEdges()).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
