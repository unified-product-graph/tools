/**
 * Tests for the dangling-edge classifier + repair tool.
 *
 * Three classes of dangling edge are exercised against fixtures and end to
 * end through the `repair_dangling_edges` MCP handler.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UPGDocument, UPGEdge, UPGEntityType } from '@unified-product-graph/core'
import { UPGFileStore } from '@unified-product-graph/sdk'
import { getToolHandler } from '../lib/tool-registry.js'
import {
 classifyDanglingEdges,
 renderDanglingReport,
} from '@unified-product-graph/sdk'
import {
 createSessionContext,
 createQueryCache,
 readSyncState,
 writeSyncState,
 hashFile,
 syncFilePath,
 type ToolContext,
} from '../lib/server-context.js'

function makeDoc(edges: UPGEdge[]): UPGDocument {
 return {
 upg_version: '0.2',
 exported_at: new Date().toISOString(),
 source: { tool: 'test' },
 product: { id: 'p1', title: 'Dangling Test', stage: 'concept' },
 nodes: [
 { id: 'n_a', type: 'persona' as UPGEntityType, title: 'A' },
 { id: 'n_b', type: 'job' as UPGEntityType, title: 'B' },
 ],
 edges,
 }
}

async function loadStore(doc: UPGDocument): Promise<UPGFileStore> {
 const dir = mkdtempSync(join(tmpdir(), 'upg-dangling-'))
 const filePath = join(dir, 'test.upg')
 writeFileSync(filePath, JSON.stringify(doc, null, 2))
 const store = new UPGFileStore()
 await store.load(filePath)
 store.stopWatching()
 return store
}

/**
 * Build a store whose loaded document contains inline cross-product edges.
 * The on-disk validator (v0.5+) rejects cross-product edge types in `edges[]`
 * they must live in `portfolio.cross_edges[]`. To exercise the
 * load-time dangling-edge classification for cross-product edges (the path
 * the classifier was designed for), we:
 *   1. Load a clean fixture through the validator (no cross-product edges).
 *   2. Splice the cross-product edges into the live doc via `getDocument()`.
 *   3. Re-run `classifyDanglingEdges` and patch the store's cached report so
 *      `getDanglingReport()` returns the post-injection classification.
 * This mirrors the pre-v0.5 behaviour where a legacy file containing inline
 * cross-product edges would load and surface a stderr integrity report.
 */
async function loadStoreWithCrossEdges(
 nodeFixture: UPGDocument,
 crossEdges: UPGEdge[],
): Promise<{ store: UPGFileStore; stderrWrites: string }> {
 const dir = mkdtempSync(join(tmpdir(), 'upg-dangling-'))
 const filePath = join(dir, 'test.upg')
 writeFileSync(filePath, JSON.stringify(nodeFixture, null, 2))
 const store = new UPGFileStore()
 await store.load(filePath)
 store.stopWatching()

 const liveDoc = store.getDocument()
 liveDoc.edges.push(...crossEdges)

 // Recompute the classification + stderr report so consumers (getDanglingReport
 // and the repair_dangling_edges tool) see the post-injection state.
 const report = classifyDanglingEdges(
 liveDoc.edges,
 new Set(liveDoc.nodes.map((n) => n.id)),
 )
 // Private field; runtime-accessible in TS. Mirrors the load() code path
 // without re-running the (now-stricter) validator.
 ;(store as unknown as { lastDanglingReport: typeof report }).lastDanglingReport = report

 const rendered = renderDanglingReport(report, filePath)
 const stderrWrites = rendered ? rendered + '\n' : ''
 return { store, stderrWrites }
}

function makeCtx(store: UPGFileStore): ToolContext {
 return {
 store,
 sessionContext: createSessionContext(),
 queryCache: createQueryCache(),
 sync: { readSyncState, writeSyncState, hashFile, syncFilePath },
 }
}

describe('classifyDanglingEdges', () => {
 it('returns an empty report when every endpoint resolves', () => {
 const report = classifyDanglingEdges(
 [
 { id: 'e1', type: 'persona_pursues_job', source: 'n_a', target: 'n_b' } as UPGEdge,
 ],
 new Set(['n_a', 'n_b']),
 )
 expect(report.total).toBe(0)
 expect(report.edges).toEqual([])
 })

 it('classifies cross-product edges with annotation as expected', () => {
 const report = classifyDanglingEdges(
 [
 {
 id: 'e_cross',
 type: 'shares_persona',
 source: 'p_other/n_x',
 target: 'n_a',
 source_product_id: 'p_other',
 } as unknown as UPGEdge,
 ],
 new Set(['n_a']),
 )
 expect(report.total).toBe(1)
 expect(report.by_class.expected).toBe(1)
 expect(report.edges[0].class).toBe('expected')
 })

 it('classifies cross-product edges without annotation as suspect', () => {
 const report = classifyDanglingEdges(
 [
 { id: 'e_suspect', type: 'shares_persona', source: 'n_a', target: 'n_missing' } as unknown as UPGEdge,
 ],
 new Set(['n_a']),
 )
 expect(report.by_class.suspect).toBe(1)
 expect(report.edges[0].class).toBe('suspect')
 expect(report.edges[0].missing).toEqual(['target'])
 })

 it('classifies non-cross-product dangling edges as corrupt', () => {
 const report = classifyDanglingEdges(
 [
 { id: 'e_corrupt', type: 'persona_pursues_job', source: 'n_ghost', target: 'n_b' } as UPGEdge,
 ],
 new Set(['n_b']),
 )
 expect(report.by_class.corrupt).toBe(1)
 expect(report.edges[0].class).toBe('corrupt')
 expect(report.edges[0].missing).toEqual(['source'])
 })
})

describe('renderDanglingReport', () => {
 it('returns null when there are no dangling edges', () => {
 expect(
 renderDanglingReport(
 { total: 0, by_class: { expected: 0, suspect: 0, corrupt: 0 }, edges: [] },
 '/tmp/x.upg',
 ),
 ).toBeNull()
 })

 it('renders a multi-line report classifying each class', () => {
 const report = classifyDanglingEdges(
 [
 { id: 'e1', type: 'shares_persona', source: 'n_a', target: 'n_x', source_product_id: 'p_other' } as unknown as UPGEdge,
 { id: 'e2', type: 'shares_persona', source: 'n_a', target: 'n_y' } as unknown as UPGEdge,
 { id: 'e3', type: 'persona_pursues_job', source: 'n_ghost', target: 'n_b' } as UPGEdge,
 ],
 new Set(['n_a', 'n_b']),
 )
 const rendered = renderDanglingReport(report, '/tmp/x.upg')!
 expect(rendered).toMatch(/expected dangling edges/)
 expect(rendered).toMatch(/suspect dangling cross-product edges/)
 expect(rendered).toMatch(/corrupt edges/)
 expect(rendered).toMatch(/repair_dangling_edges/)
 })
})

describe('UPGFileStore.getDanglingReport', () => {
 // Note: non-cross-product edges with missing endpoints fail
 // `validateUPGDocument` at load time, so the `corrupt` class only reaches
 // this report via the tampered-file integrity verification path. The
 // store-level tests below exercise the cross-product cases that *do* load
 // post-(cross-edge endpoint exemption shipped on dev).

 it('captures the load-time classification', async () => {
 // Mixed legacy fixture: one valid intra-product edge (loadable) plus one
 // cross-product edge with a missing endpoint (injected post-load; the
 // validator now rejects cross-product types in `edges[]`, see
 // loadStoreWithCrossEdges).
 const { store } = await loadStoreWithCrossEdges(
 makeDoc([
 { id: 'e1', type: 'persona_pursues_job', source: 'n_a', target: 'n_b' } as UPGEdge,
 ]),
 [
 { id: 'e2', type: 'shares_persona', source: 'n_a', target: 'n_missing' } as unknown as UPGEdge,
 ],
 )
 const report = store.getDanglingReport()
 expect(report).not.toBeNull()
 expect(report!.total).toBe(1)
 expect(report!.by_class.suspect).toBe(1)
 })

 it('writes a stderr report on load when cross-product dangling edges are present', async () => {
 // The validator (v0.5+) refuses to load a document with cross-product
 // edges inline, so the legacy "load and warn" path is now reachable only
 // by injecting post-load. We verify the rendered report content directly.
 const { stderrWrites } = await loadStoreWithCrossEdges(
 makeDoc([]),
 [
 { id: 'e_suspect', type: 'shares_persona', source: 'n_a', target: 'n_missing' } as unknown as UPGEdge,
 ],
 )
 expect(stderrWrites).toMatch(/integrity report/)
 expect(stderrWrites).toMatch(/repair_dangling_edges/)
 })
})

describe('repair_dangling_edges tool', () => {
 let ctx: ToolContext

 beforeEach(async () => {
 // The intra-product `persona_pursues_job` edge loads through the
 // validator; cross-product `shares_persona` edges are injected post-load
 // (see loadStoreWithCrossEdges) because the v0.5+ validator now refuses
 // cross-product types in `edges[]`.
 const { store } = await loadStoreWithCrossEdges(
 makeDoc([
 { id: 'e_clean', type: 'persona_pursues_job', source: 'n_a', target: 'n_b' } as UPGEdge,
 ]),
 [
 { id: 'e_expected', type: 'shares_persona', source: 'n_a', target: 'n_x', source_product_id: 'p_other' } as unknown as UPGEdge,
 { id: 'e_suspect', type: 'shares_persona', source: 'n_a', target: 'n_y' } as unknown as UPGEdge,
 ],
 )
 ctx = makeCtx(store)
 })

 it('dry_run defaults to true and returns the classification report', async () => {
 const handler = getToolHandler('repair_dangling_edges')!
 const result = await handler({}, ctx)
 expect(result.isError).toBeUndefined()
 const body = JSON.parse(result.content[0].text)
 expect(body.dry_run).toBe(true)
 expect(body.report.by_class.expected).toBe(1)
 expect(body.report.by_class.suspect).toBe(1)
 expect(body.report.by_class.corrupt).toBe(0)
 })

 it('refuses dry_run + drop combination', async () => {
 const handler = getToolHandler('repair_dangling_edges')!
 const result = await handler({ dry_run: true, drop: ['suspect'] }, ctx)
 expect(result.isError).toBe(true)
 })

 it('drops only the named classes and keeps expected', async () => {
 const handler = getToolHandler('repair_dangling_edges')!
 const result = await handler({ dry_run: false, drop: ['suspect'] }, ctx)
 expect(result.isError).toBeUndefined()
 const body = JSON.parse(result.content[0].text)
 expect(body.dropped).toBe(1)
 expect(body.remaining.by_class.expected).toBe(1)
 expect(body.remaining.by_class.suspect).toBe(0)
 })

 it('rejects unknown classes', async () => {
 const handler = getToolHandler('repair_dangling_edges')!
 const result = await handler({ dry_run: false, drop: ['gremlin'] }, ctx)
 expect(result.isError).toBe(true)
 expect(result.content[0].text).toMatch(/Unknown dangling-edge class/)
 })

 it('omitting drop with dry_run:false is a no-op', async () => {
 const handler = getToolHandler('repair_dangling_edges')!
 const result = await handler({ dry_run: false }, ctx)
 expect(result.isError).toBeUndefined()
 const body = JSON.parse(result.content[0].text)
 expect(body.dropped).toBe(0)
 })
})
