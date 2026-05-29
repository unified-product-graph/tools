/**
 * Tests for UPGPortfolioStore (Phase 2): portfolio-document
 * load/save and cross-edge migration from inline product edges.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPGPortfolioStore, UPGFileStore } from '@unified-product-graph/sdk'
import type { UPGDocument } from '@unified-product-graph/core'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tempDir(): string {
 return mkdtempSync(join(tmpdir(), 'upg-portfolio-store-'))
}

function makeProductDoc(
 productId: string,
 title: string,
 extraEdges: Array<{
 id: string
 source: string
 target: string
 type: string
 }> = [],
): UPGDocument {
 return {
 upg_version: '0.2',
 exported_at: new Date().toISOString(),
 source: { tool: 'test' },
 product: { id: productId, title, stage: 'concept' },
 nodes: [
 { id: 'n_aaa', type: 'persona', title: 'Alice' },
 { id: 'n_bbb', type: 'persona', title: 'Bob' },
 ],
 edges: [...extraEdges] as UPGDocument['edges'],
 }
}

async function makeStoreAt(
 filePath: string,
 doc: UPGDocument,
): Promise<UPGFileStore> {
 writeFileSync(filePath, JSON.stringify(doc, null, 2))
 const store = new UPGFileStore()
 await store.load(filePath)
 store.stopWatching()
 return store
}

// ─── UPGPortfolioStore.loadOrInit ──────────────────────────────────────────

describe('UPGPortfolioStore.loadOrInit', () => {
 let cwd: string

 beforeEach(() => {
 cwd = tempDir()
 })

 afterEach(() => {
 rmSync(cwd, { recursive: true, force: true })
 })

 it('creates a new portfolio document when file does not exist', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()

 const result = await pStore.loadOrInit(portfolioPath, 'Acme Corp')

 expect(result.cross_edge_count).toBe(0)
 expect(result.product_count).toBe(0)
 expect(existsSync(portfolioPath)).toBe(true)

 const raw = JSON.parse(readFileSync(portfolioPath, 'utf-8'))
 expect(raw.type).toBe('portfolio')
 expect(raw.organization.title).toBe('Acme Corp')
 expect(raw.cross_edges).toEqual([])
 })

 it('loads an existing portfolio document', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const existing = {
 upg_version: '0.2',
 type: 'portfolio',
 exported_at: new Date().toISOString(),
 source: { tool: 'test' },
 organization: { id: 'org_1', title: 'Existing Org' },
 product_areas: [],
 portfolios: [],
 products: [],
 cross_edges: [
 {
 id: 'e_existing',
 source: 'prod_a/n_111',
 target: 'prod_b/n_222',
 type: 'shares_persona',
 source_product_id: 'prod_a',
 target_product_id: 'prod_b',
 },
 ],
 }
 writeFileSync(portfolioPath, JSON.stringify(existing, null, 2))

 const pStore = new UPGPortfolioStore()
 const result = await pStore.loadOrInit(portfolioPath)

 expect(result.cross_edge_count).toBe(1)
 expect(pStore.getAllCrossEdges()).toHaveLength(1)
 expect(pStore.getAllCrossEdges()[0].id).toBe('e_existing')
 })

 it('throws when the file exists but is not a portfolio document', async () => {
 const portfolioPath = join(cwd, 'notaportfolio.upg')
 writeFileSync(
 portfolioPath,
 JSON.stringify({ type: 'product', upg_version: '0.2' }, null, 2),
 )

 const pStore = new UPGPortfolioStore()
 await expect(pStore.loadOrInit(portfolioPath)).rejects.toThrow(
 /expected a portfolio document/i,
 )
 })

 it('isLoaded() returns false before init, true after', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 expect(pStore.isLoaded()).toBe(false)
 await pStore.loadOrInit(portfolioPath)
 expect(pStore.isLoaded()).toBe(true)
 })
})

// ─── UPGPortfolioStore.addCrossEdge ──────────────────────────────────────────

describe('UPGPortfolioStore.addCrossEdge', () => {
 let cwd: string

 beforeEach(() => {
 cwd = tempDir()
 })

 afterEach(() => {
 rmSync(cwd, { recursive: true, force: true })
 })

 it('adds a valid cross-product edge and persists it', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 pStore.addCrossEdge({
 id: 'e_001',
 source: 'prod_a/n_111',
 target: 'prod_b/n_222',
 type: 'shares_persona',
 source_product_id: 'prod_a',
 target_product_id: 'prod_b',
 })
 await pStore.flush()

 const saved = JSON.parse(readFileSync(portfolioPath, 'utf-8'))
 expect(saved.cross_edges).toHaveLength(1)
 expect(saved.cross_edges[0].id).toBe('e_001')
 expect(saved.cross_edges[0].source).toBe('prod_a/n_111')
 expect(saved.cross_edges[0].target).toBe('prod_b/n_222')
 })

 it('rejects a bare (unqualified) source ID', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 expect(() =>
 pStore.addCrossEdge({
 id: 'e_bad',
 source: 'n_111', // bare, not qualified
 target: 'prod_b/n_222',
 type: 'shares_persona',
 }),
 ).toThrow(/qualified ID/)
 })

 it('rejects a bare target ID', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 expect(() =>
 pStore.addCrossEdge({
 id: 'e_bad',
 source: 'prod_a/n_111',
 target: 'n_222', // bare, not qualified
 type: 'shares_persona',
 }),
 ).toThrow(/qualified ID/)
 })

 it('rejects an invalid edge type', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 expect(() =>
 pStore.addCrossEdge({
 id: 'e_bad',
 source: 'prod_a/n_111',
 target: 'prod_b/n_222',
 type: 'invalid_type' as never,
 }),
 ).toThrow(/Invalid cross-product edge type/)
 })

 it('throws when portfolio not loaded', () => {
 const pStore = new UPGPortfolioStore()
 expect(() =>
 pStore.addCrossEdge({
 id: 'e_x',
 source: 'p/n',
 target: 'q/m',
 type: 'shares_persona',
 }),
 ).toThrow(/not loaded/)
 })
})

// ─── UPGPortfolioStore.removeCrossEdge ────────────────────────────────────────

describe('UPGPortfolioStore.removeCrossEdge', () => {
 let cwd: string

 beforeEach(() => {
 cwd = tempDir()
 })

 afterEach(() => {
 rmSync(cwd, { recursive: true, force: true })
 })

 it('removes an existing edge by ID', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 pStore.addCrossEdge({
 id: 'e_remove_me',
 source: 'p/n1',
 target: 'q/n2',
 type: 'depends_on_product',
 })

 const removed = pStore.removeCrossEdge('e_remove_me')
 expect(removed).not.toBeNull()
 expect(removed?.id).toBe('e_remove_me')
 expect(pStore.getAllCrossEdges()).toHaveLength(0)
 })

 it('returns null for a non-existent edge ID', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 const result = pStore.removeCrossEdge('no_such_edge')
 expect(result).toBeNull()
 })
})

// ─── UPGPortfolioStore.migrateCrossEdgesFromDoc ────────────────────────────────

describe('UPGPortfolioStore.migrateCrossEdgesFromDoc', () => {
 let cwd: string

 beforeEach(() => {
 cwd = tempDir()
 })

 afterEach(() => {
 rmSync(cwd, { recursive: true, force: true })
 })

 function makeCrossEdgeDoc() {
 return makeProductDoc('prod_quality', 'Quality Circle', [
 // Cross-product type: should be migrated
 {
 id: 'e_cross_1',
 source: 'n_aaa',
 target: 'n_ext_001', // target NOT in this doc → needs targetProductId
 type: 'shares_persona',
 },
 // Cross-product type, target IN same doc
 {
 id: 'e_cross_2',
 source: 'n_aaa',
 target: 'n_bbb',
 type: 'shares_competitor',
 },
 // Regular edge: must NOT be migrated
 {
 id: 'e_regular',
 source: 'n_aaa',
 target: 'n_bbb',
 type: 'persona_pursues_job',
 },
 ])
 }

 it('dry_run: true, reports migrated edges without writing', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 const doc = makeCrossEdgeDoc()
 const originalEdgeCount = doc.edges.length

 const result = pStore.migrateCrossEdgesFromDoc(
 doc,
 'prod_quality',
 'prod_ifqm',
 true, // dry_run
 )

 expect(result.dry_run).toBe(true)
 expect(result.migrated).toHaveLength(2) // e_cross_1 + e_cross_2
 expect(result.skipped).toHaveLength(0)

 // Doc edges must NOT be mutated in dry_run
 expect(doc.edges).toHaveLength(originalEdgeCount)
 // Portfolio store must NOT have any edges yet
 expect(pStore.getAllCrossEdges()).toHaveLength(0)
 })

 it('dry_run: false, migrates edges and removes them from source doc', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 const doc = makeCrossEdgeDoc()

 const result = pStore.migrateCrossEdgesFromDoc(
 doc,
 'prod_quality',
 'prod_ifqm',
 false, // live
 )

 expect(result.dry_run).toBe(false)
 expect(result.migrated).toHaveLength(2)
 expect(result.skipped).toHaveLength(0)

 // Doc edges should only contain the regular edge now
 expect(doc.edges).toHaveLength(1)
 expect(doc.edges[0].id).toBe('e_regular')

 // Portfolio should have the two migrated edges
 expect(pStore.getAllCrossEdges()).toHaveLength(2)
 await pStore.flush()

 const saved = JSON.parse(readFileSync(portfolioPath, 'utf-8'))
 expect(saved.cross_edges).toHaveLength(2)
 })

 it('uses qualified IDs for migrated edges', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 const doc = makeProductDoc('prod_q', 'Q Product', [
 {
 id: 'e_cross',
 source: 'n_aaa',
 target: 'n_ext',
 type: 'depends_on_product',
 },
 ])

 pStore.migrateCrossEdgesFromDoc(doc, 'prod_q', 'prod_ext', false)

 const edges = pStore.getAllCrossEdges()
 expect(edges).toHaveLength(1)
 expect(edges[0].source).toBe('prod_q/n_aaa')
 expect(edges[0].target).toBe('prod_ext/n_ext')
 expect(edges[0].source_product_id).toBe('prod_q')
 expect(edges[0].target_product_id).toBe('prod_ext')
 })

 it('skips cross-edges when target is external and no targetProductId provided', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 const doc = makeProductDoc('prod_q', 'Q', [
 {
 id: 'e_orphan',
 source: 'n_aaa',
 target: 'n_ext_unknown',
 type: 'shares_metric',
 },
 ])

 const result = pStore.migrateCrossEdgesFromDoc(doc, 'prod_q', null, true)

 expect(result.migrated).toHaveLength(0)
 expect(result.skipped).toHaveLength(1)
 expect(result.skipped[0].id).toBe('e_orphan')
 expect(result.skipped[0].reason).toMatch(/targetProductId/)
 })

 it('does not touch regular edges in the source document', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 const doc = makeProductDoc('prod_q', 'Q', [
 { id: 'e_reg', source: 'n_aaa', target: 'n_bbb', type: 'persona_pursues_job' },
 ])

 pStore.migrateCrossEdgesFromDoc(doc, 'prod_q', null, false)

 expect(doc.edges).toHaveLength(1)
 expect(doc.edges[0].id).toBe('e_reg')
 expect(pStore.getAllCrossEdges()).toHaveLength(0)
 })

 it('handles a document with no cross-product edges gracefully', async () => {
 const portfolioPath = join(cwd, 'portfolio.upg')
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 const doc = makeProductDoc('prod_q', 'Q') // no edges at all

 const result = pStore.migrateCrossEdgesFromDoc(doc, 'prod_q', null, false)

 expect(result.migrated).toHaveLength(0)
 expect(result.skipped).toHaveLength(0)
 expect(pStore.getAllCrossEdges()).toHaveLength(0)
 })
})

// ─── Integration: migrate from UPGFileStore doc ───────────────────────────────

describe('migration: UPGFileStore + UPGPortfolioStore round-trip', () => {
 let cwd: string

 beforeEach(() => {
 cwd = tempDir()
 mkdirSync(join(cwd, '.upg'))
 })

 afterEach(() => {
 rmSync(cwd, { recursive: true, force: true })
 })

 it('migrates inline cross-product edges to portfolio doc and saves both files', async () => {
 const productPath = join(cwd, '.upg', 'main.upg')
 const portfolioPath = join(cwd, '.upg', 'portfolio.upg')

 // The v0.5+ validator rejects cross-product edge types in `edges[]`, so we
 // can't write the legacy "inline cross-product" fixture to disk and load
 // it. Build a loadable product doc, then splice the inline cross-product
 // edge into `liveDoc.edges` post-load; this is the exact graph state the
 // migration tool is meant to clean up.
 const doc = makeProductDoc('prod_main', 'Main Product', [
 {
 id: 'e_regular',
 source: 'n_aaa',
 target: 'n_bbb',
 type: 'persona_pursues_job',
 },
 ])

 const store = await makeStoreAt(productPath, doc)
 const pStore = new UPGPortfolioStore()
 await pStore.loadOrInit(portfolioPath)

 // Splice the legacy inline cross-product edge into the live doc to
 // reproduce the pre-v0.5 shape the migration sweep is designed to clear.
 const liveDoc = store.getDocument()
 liveDoc.edges.push({
 id: 'e_cross_inline',
 source: 'n_aaa',
 target: 'n_ext',
 type: 'shares_persona',
 } as unknown as UPGDocument['edges'][number])

 // Run migration on the live document
 const result = pStore.migrateCrossEdgesFromDoc(
 liveDoc,
 'prod_main',
 'prod_sibling',
 false,
 )

 expect(result.migrated).toHaveLength(1)
 expect(result.skipped).toHaveLength(0)

 // migrateCrossEdgesFromDoc mutates doc.edges in-place but can't set the
 // store's dirty flag; call markDirty() before flush so the save goes through.
 store.markDirty()

 // Flush both
 await pStore.flush()
 await store.flush()

 // Verify portfolio file
 const savedPortfolio = JSON.parse(readFileSync(portfolioPath, 'utf-8'))
 expect(savedPortfolio.type).toBe('portfolio')
 expect(savedPortfolio.cross_edges).toHaveLength(1)
 expect(savedPortfolio.cross_edges[0].source).toBe('prod_main/n_aaa')
 expect(savedPortfolio.cross_edges[0].target).toBe('prod_sibling/n_ext')

 // Verify product file no longer has the cross-product edge
 const savedProduct = JSON.parse(readFileSync(productPath, 'utf-8'))
 expect(savedProduct.edges).toHaveLength(1)
 expect(savedProduct.edges[0].id).toBe('e_regular')
 })
})
